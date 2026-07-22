import crypto from "crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { CookieOptions, Request, Response } from "express";
import jwt from "jsonwebtoken";
import supabase, {
  createOAuthSupabaseClient,
  createRecoverySupabaseClient,
  supabaseAdmin,
} from "../config/supabase.js";
import redisClient from "../config/redis.js";
import { db } from "../db/index.js";
import { appOauthCodes as oauthCodes, appRefreshTokens as refreshTokens, appUsers as users } from "../db/v2Schema.js";
import {
  ensureIdentityProfile,
  fallbackUsername,
  githubIdentityFromAuthUser,
} from "../services/identityService.js";
import { syncGitHubPersona } from "../services/githubPersonaService.js";
import { updatePasswordFromRecoverySession } from "../services/passwordRecoveryService.js";
import {
  OAuthPkceCoordinator,
  RedisOAuthAttemptStore,
  CLIENT_CODE_CHALLENGE_PATTERN,
  clientCodeChallengeFromVerifier,
  type ConsumedOAuthAttempt,
} from "../services/oauthPkceService.js";
import {
  sendControllerError,
  sendError,
  sendSuccess,
} from "../utils/response.js";
import { isValidUuid } from "../utils/validators.js";
import {
  resolveBackendCallbackUrl,
  resolveClientRedirect,
} from "../security/originPolicy.js";
import { normalizeUsername } from "../utils/username.js";
import { isValidDateOfBirth } from "../utils/dateOfBirth.js";
import {
  initialOAuthOnboardingCompleted,
  loginOnboardingCompleted,
  oauthLoginNeedsSignup,
  requiresGitHubPersona,
} from "../services/oauthProfilePolicy.js";

const CLIENT_URL = process.env.CLIENT_URL;
const BACKEND_URL = process.env.BACKEND_URL;
const OAUTH_ATTEMPT_COOKIE = "oauth_attempt";
const OAUTH_ATTEMPT_TTL_SECONDS = Number.parseInt(
  process.env.OAUTH_ATTEMPT_TTL_SECONDS ?? "300",
  10,
);

if (!CLIENT_URL)
  throw new Error("Missing required environment variable: CLIENT_URL");
if (!BACKEND_URL)
  throw new Error("Missing required environment variable: BACKEND_URL");

const JWT_SECRET = process.env.JWT_SECRET as string;
const PASSWORD_RESET_URL = process.env.PASSWORD_RESET_URL
  ?? CLIENT_URL.replace(/callback\/?$/, "reset-password");

if (!JWT_SECRET) {
  throw new Error(
    "FATAL ERROR: JWT_SECRET is not defined in environment variables.",
  );
}

const oauthPkce = new OAuthPkceCoordinator(
  new RedisOAuthAttemptStore(redisClient),
  createOAuthSupabaseClient,
  {
    attemptTtlSeconds: OAUTH_ATTEMPT_TTL_SECONDS,
  },
);

const oauthAttemptCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
  maxAge: OAUTH_ATTEMPT_TTL_SECONDS * 1_000,
});

const clearOAuthAttemptCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
});

// Helper: Hash the refresh token before storing it
const hashToken = (token: string) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

const configuredClientRedirects = (process.env.OAUTH_REDIRECT_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const refreshCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/api/auth",
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

const clearRefreshCookieOptions = (): CookieOptions => {
  const { maxAge: _maxAge, ...options } = refreshCookieOptions();
  return options;
};

const getClientRedirect = (value: unknown): string => {
  return resolveClientRedirect(
    value,
    CLIENT_URL,
    configuredClientRedirects,
    process.env.NODE_ENV,
  );
};

const withClientRedirectParams = (
  clientRedirect: string,
  params: Record<string, string>,
): string => {
  const redirect = new URL(clientRedirect);
  // Never preserve caller-supplied auth results from the allowed redirect URL.
  // Keep unrelated routing parameters (for example `source=github`) intact.
  redirect.searchParams.delete("code");
  redirect.searchParams.delete("error");
  for (const [key, value] of Object.entries(params)) {
    redirect.searchParams.set(key, value);
  }
  return redirect.toString();
};

const queryString = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const getBackendCallbackUrl = (req: Request): URL => {
  return resolveBackendCallbackUrl(
    req.get("host"),
    BACKEND_URL,
    process.env.PORT,
    process.env.NODE_ENV,
  );
};

// Helper: Create and store a refresh token securely
const createAndStoreRefreshToken = async (userId: string, tx: any = db) => {
  const refreshToken = crypto.randomBytes(40).toString("hex");
  const tokenHash = hashToken(refreshToken);

  // Expiration set to 30 days
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await tx.insert(refreshTokens).values({
    userId,
    tokenHash,
    expiresAt,
  });

  return refreshToken;
};

// POST /api/auth/signup
export async function signUp(req: Request, res: Response): Promise<void> {
  const { email, password, full_name, date_of_birth } = req.body;
  const usernameInput = req.body?.username;
  const explicitUsername = usernameInput === undefined || usernameInput === null
    ? null
    : normalizeUsername(usernameInput);
  if (usernameInput !== undefined && usernameInput !== null && explicitUsername === null) {
    return sendError(
      res,
      400,
      "Username must be 1-50 characters using only letters, numbers, underscores, or hyphens",
    );
  }
  if (!isValidDateOfBirth(date_of_birth)) {
    return sendError(res, 400, "Date of birth is required in YYYY-MM-DD format and cannot be in the future");
  }

  try {
    // 0. Pre-emptively check if username is taken to avoid messy trigger constraint violations
    if (explicitUsername) {
      const existingUser = await db
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = lower(${explicitUsername})`);
      if (existingUser.length > 0) {
        return sendError(res, 409, "Username is already taken");
      }
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Bypass email verification so we can login immediately
      user_metadata: {
        ...(explicitUsername ? { user_name: explicitUsername } : {}),
        full_name: full_name,
        date_of_birth,
      },
    });

    if (error) return sendError(res, error.status || 400, error.message);

    const userId = data.user.id;
    const profileUsername = explicitUsername
      ?? fallbackUsername(userId, data.user.user_metadata);

    try {
      await ensureIdentityProfile({
        userId,
        username: profileUsername,
        fullName: full_name ?? null,
        dateOfBirth: date_of_birth,
        onboardingCompleted: false,
      });
      // Generate and persist both session credentials only after the product
      // profile exists. Any failure rolls the new identity back below.
      const accessToken = jwt.sign({ userId, email }, JWT_SECRET, {
        expiresIn: "15m",
      });
      const refreshToken = await createAndStoreRefreshToken(userId);

      res.cookie("refresh_token", refreshToken, refreshCookieOptions());
      return sendSuccess(res, 201, {
        message: "Signup successful",
        accessToken,
        token: accessToken,
        user: data.user,
      });
    } catch (provisioningError) {
      const { error: cleanupError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (cleanupError) console.error("Failed to roll back incomplete signup:", cleanupError.message);
      throw provisioningError;
    }
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// POST /api/auth/login
export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) return sendError(res, error.status || 401, error.message);

    const userId = data.user.id;
    const [existingProductProfile] = await db
      .select({ onboardingCompleted: users.onboardingCompleted })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    await ensureIdentityProfile({
      userId,
      username: fallbackUsername(userId, data.user.user_metadata),
      fullName: typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : null,
      dateOfBirth: typeof data.user.user_metadata?.date_of_birth === "string" ? data.user.user_metadata.date_of_birth : null,
      avatarUrl: typeof data.user.user_metadata?.avatar_url === "string" ? data.user.user_metadata.avatar_url : null,
      onboardingCompleted: loginOnboardingCompleted(
        existingProductProfile?.onboardingCompleted,
      ),
    });

    const accessToken = jwt.sign({ userId, email }, JWT_SECRET, {
      expiresIn: "15m",
    });

    const refreshToken = await createAndStoreRefreshToken(userId);

    res.cookie("refresh_token", refreshToken, refreshCookieOptions());

    return sendSuccess(res, 200, {
      message: "Login successful",
      accessToken,
      token: accessToken, // Alias for backward compatibility
      user: data.user,
    });
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// POST /api/auth/logout
export async function logout(req: Request, res: Response): Promise<void> {
  const incomingToken = req.cookies.refresh_token;

  if (!incomingToken) {
    res.status(200).json({ success: true, message: "Already logged out." });
    return;
  }

  try {
    const tokenHash = hashToken(incomingToken);

    try {
      await db
        .delete(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash));
    } catch (dbError) {
      return sendError(res, 500, "Failed to revoke refresh token.");
    }

    // Only clear the cookie AFTER the server-side token is successfully revoked!
    res.clearCookie("refresh_token", clearRefreshCookieOptions());

    res
      .status(200)
      .json({ success: true, message: "Logged out successfully." });
  } catch (err) {
    return sendError(res, 500, "Internal server error during logout");
  }
}

// POST /api/auth/refresh
export async function refreshToken(req: Request, res: Response): Promise<void> {
  const incomingToken = req.cookies.refresh_token;

  if (!incomingToken) {
    return sendError(res, 401, "No refresh token provided.");
  }

  try {
    const tokenHash = hashToken(incomingToken);

    // 1. Look up the hash in the DB without locking
    const [tokenData] = await db
      .select({
        user_id: refreshTokens.userId,
        expires_at: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!tokenData) {
      throw new Error("InvalidToken");
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      throw new Error("ExpiredToken");
    }

    // 2. Fetch user metadata from Supabase Auth via Admin Client
    // IMPORTANT: We do this BEFORE the transaction so we don't hold database connections open across network calls!
    const { data: authData, error: userError } =
      await supabaseAdmin.auth.admin.getUserById(tokenData.user_id);

    if (userError || !authData?.user) {
      throw new Error("UserNotFound");
    }

    // 3. Generate a fresh access token (CPU bound, fast)
    const newAccessToken = jwt.sign(
      { userId: authData.user.id, email: authData.user.email },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    // 4. Run the actual DB mutation in a fast, isolated atomic transaction
    const newRefreshToken = await db.transaction(async (tx) => {
      // Atomically attempt to delete the exact token.
      // If another concurrent request beat us to it, this returns empty.
      const deletedTokens = await tx
        .delete(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .returning();

      if (deletedTokens.length === 0) {
        throw new Error("InvalidToken"); // Race condition lost! Safely abort.
      }

      // Generate and store the new token inside the same atomic transaction
      return await createAndStoreRefreshToken(authData.user.id, tx);
    });

    // 5. Send new refresh token in cookie
    res.cookie("refresh_token", newRefreshToken, refreshCookieOptions());

    return sendSuccess(res, 200, {
      accessToken: newAccessToken,
      token: newAccessToken, // Alias for backward compatibility
      user: authData.user,
    });
  } catch (error: any) {
    if (error.message === "InvalidToken" || error.message === "ExpiredToken") {
      res.clearCookie("refresh_token", clearRefreshCookieOptions());
      return sendError(
        res,
        401,
        "Invalid or expired refresh token. Please log in again.",
      );
    }
    if (error.message === "UserNotFound") {
      return sendError(res, 404, "User not found in Auth system.");
    }
    sendControllerError(res, error as Error);
  }
}

// POST /api/auth/password/reset/request
export async function requestPasswordReset(req: Request, res: Response): Promise<void> {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return sendError(res, 400, "Enter a valid email address.");
  }

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: PASSWORD_RESET_URL,
    });
    if (error) console.error("Password reset request failed:", error.message);

    // Always return the same response so this endpoint cannot enumerate accounts.
    sendSuccess(res, 202, {
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (error) {
    console.error("Password reset request failed:", error);
    sendSuccess(res, 202, {
      message: "If an account exists for that email, a reset link has been sent.",
    });
  }
}

// POST /api/auth/password/reset/confirm
export async function confirmPasswordReset(req: Request, res: Response): Promise<void> {
  const accessToken = typeof req.body?.access_token === "string"
    ? req.body.access_token.trim()
    : "";
  const refreshToken = typeof req.body?.refresh_token === "string"
    ? req.body.refresh_token.trim()
    : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!accessToken || !refreshToken || password.length < 12 || password.length > 128) {
    return sendError(res, 400, "A valid reset session and a 12-128 character password are required.");
  }

  try {
    // Recovery tokens represent a user session, not an admin credential. Keep
    // that session request-scoped so concurrent resets cannot share auth state.
    const recoveryClient = createRecoverySupabaseClient();
    const result = await updatePasswordFromRecoverySession(
      recoveryClient.auth,
      { access_token: accessToken, refresh_token: refreshToken },
      password,
    );
    if (result === "invalid-session") {
      return sendError(res, 400, "This password reset link is invalid or expired.");
    }
    if (result === "update-failed") {
      return sendError(res, 400, "Unable to update the password. Request a new reset link and try again.");
    }

    sendSuccess(res, 200, { message: "Password updated successfully." });
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// GET /api/auth/:provider
export async function getOAuthUrl(req: Request, res: Response): Promise<void> {
  const { provider } = req.params;
  if (provider !== "github" && provider !== "google")
    return sendError(res, 400, "Invalid provider.");

  try {
    const clientRedirect = getClientRedirect(req.query.redirect_uri);
    const clientCodeChallenge = queryString(req.query.code_challenge);
    const authIntent = req.query.auth_intent;
    if (!clientCodeChallenge || !CLIENT_CODE_CHALLENGE_PATTERN.test(clientCodeChallenge)) {
      return sendError(res, 400, "A valid S256 client code challenge is required.");
    }
    if (authIntent !== "login" && authIntent !== "signup") {
      return sendError(res, 400, "auth_intent must be login or signup.");
    }
    const dateOfBirth = authIntent === "signup" ? queryString(req.query.date_of_birth) : null;
    if (authIntent === "signup" && !isValidDateOfBirth(dateOfBirth)) {
      return sendError(res, 400, "Date of birth is required for signup.");
    }
    const callbackUrl = getBackendCallbackUrl(req);
    const authorization = await oauthPkce.begin(
      provider,
      clientRedirect,
      callbackUrl,
      clientCodeChallenge,
      authIntent,
      dateOfBirth,
    );
    const continuationUrl = new URL("/api/auth/oauth/continue", callbackUrl);
    continuationUrl.searchParams.set("oauth_attempt", authorization.state);
    return sendSuccess(res, 200, { url: continuationUrl.toString() });
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// GET /api/auth/oauth/continue
export async function continueOAuth(req: Request, res: Response): Promise<void> {
  try {
    const authorization = await oauthPkce.resume(req.query.oauth_attempt);
    if (!authorization) {
      return sendError(res, 400, "Invalid or expired OAuth attempt.");
    }
    res.cookie(OAUTH_ATTEMPT_COOKIE, authorization.state, oauthAttemptCookieOptions());
    res.redirect(302, authorization.url);
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// GET /api/auth/callback
export async function handleOAuthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  let attempt: ConsumedOAuthAttempt | null;
  try {
    const attemptState = req.cookies?.[OAUTH_ATTEMPT_COOKIE];
    res.clearCookie(OAUTH_ATTEMPT_COOKIE, clearOAuthAttemptCookieOptions());
    attempt = await oauthPkce.consume(attemptState);
  } catch (error) {
    console.error("OAuth state consume error:", error);
    return res.redirect(withClientRedirectParams(CLIENT_URL, {
      error: "oauth_temporarily_unavailable",
    }));
  }

  if (!attempt) {
    return res.redirect(withClientRedirectParams(CLIENT_URL, {
      error: "invalid_or_expired_oauth_state",
    }));
  }

  const clientRedirect = attempt.clientRedirect;
  const code = queryString(req.query.code);
  const providerError = queryString(req.query.error);
  if (!code || providerError) {
    return res.redirect(withClientRedirectParams(clientRedirect, {
      error: providerError ? "oauth_provider_error" : "oauth_code_missing",
    }));
  }

  try {
    // The attempt was atomically consumed above. Rehydrate its request-scoped
    // PKCE client so this code can only be exchanged with the matching verifier.
    const { data, error } = await oauthPkce.exchange(attempt, code);

    if (error || !data.user) {
      console.error("OAuth Exchange Error:", error);
      return res.redirect(withClientRedirectParams(clientRedirect, {
        error: "oauth_exchange_failed",
      }));
    }

    // 2. Ensure the v2 product profile exists before the one-time code references it.
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const githubIdentity = githubIdentityFromAuthUser(data.user, attempt.provider);
    const [existingProductProfile] = await db
      .select({ onboardingCompleted: users.onboardingCompleted })
      .from(users)
      .where(eq(users.userId, data.user.id))
      .limit(1);
    // OAuth providers can create an identity even from a button labelled
    // "Log in". Do not silently create a product account without the signup
    // DOB/consent step; ask the user to use the actual signup entry point.
    if (oauthLoginNeedsSignup(attempt.authIntent, Boolean(existingProductProfile))) {
      return res.redirect(withClientRedirectParams(clientRedirect, {
        error: "oauth_account_not_found",
      }));
    }
    // GitHub can create an identity even when the user pressed "Log in". Any
    // product profile that has never completed persona sync must fail closed;
    // established GitHub accounts can still log in during a transient API
    // outage because their durable persona already exists.
    const githubPersonaRequired = requiresGitHubPersona(
      attempt.provider,
      existingProductProfile?.onboardingCompleted,
    );
    await ensureIdentityProfile({
      userId: data.user.id,
      username: fallbackUsername(data.user.id, data.user.user_metadata),
      fullName: typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : null,
      dateOfBirth: attempt.dateOfBirth
        ?? (typeof data.user.user_metadata?.date_of_birth === "string" ? data.user.user_metadata.date_of_birth : null),
      githubId: githubIdentity.githubId,
      githubHandle: githubIdentity.githubHandle,
      avatarUrl: typeof data.user.user_metadata?.avatar_url === "string" ? data.user.user_metadata.avatar_url : null,
      // Existing accounts retain their durable completion state. A new GitHub
      // account is completed only by syncGitHubPersona below; Google/email
      // signups finish the explicit onboarding flow.
      onboardingCompleted: initialOAuthOnboardingCompleted(
        attempt.authIntent,
        existingProductProfile?.onboardingCompleted,
        githubPersonaRequired,
      ),
    });
    if (attempt.provider === "github") {
      if (!githubIdentity.githubHandle) {
        console.error("GitHub OAuth response did not contain a GitHub handle.");
        if (githubPersonaRequired) {
          return res.redirect(withClientRedirectParams(clientRedirect, {
            error: "github_identity_incomplete",
          }));
        }
      }

      if (githubIdentity.githubHandle) {
        try {
          await syncGitHubPersona(data.user.id, githubIdentity.githubHandle);
        } catch (error) {
          console.warn(
            "GitHub persona sync failed:",
            error instanceof Error ? error.message : "Unknown error",
          );
          // A GitHub signup promises to derive the persona from GitHub and skip
          // manual onboarding. Do not issue an app session until that promise
          // has actually been fulfilled. The incomplete profile is safe to
          // retry on the next OAuth attempt.
          if (githubPersonaRequired) {
            return res.redirect(withClientRedirectParams(clientRedirect, {
              error: "github_persona_sync_failed",
            }));
          }
        }
      }
    }
    const [codeData] = await db
      .insert(oauthCodes)
      .values({
        userId: data.user.id,
        clientCodeChallenge: attempt.clientCodeChallenge,
        expiresAt,
      })
      .returning({ code: oauthCodes.code });

    if (!codeData) {
      console.error("OAuth Code Insert Error");
      return res.redirect(withClientRedirectParams(clientRedirect, {
        error: "oauth_code_generation_failed",
      }));
    }

    // 4. Redirect to your frontend with the short-lived code.
    res.redirect(withClientRedirectParams(clientRedirect, {
      code: codeData.code,
    }));
  } catch (error) {
    console.error("OAuth Callback Caught Error:", error);
    res.redirect(withClientRedirectParams(clientRedirect, {
      error: "oauth_internal_error",
    }));
  }
}

// POST /api/auth/exchange
export async function exchangeAuthCode(
  req: Request,
  res: Response,
): Promise<void> {
  const { code } = req.body;
  const codeVerifier = queryString(req.body?.code_verifier);

  if (!code) {
    return sendError(res, 400, "Authorization code is required");
  }

  if (!isValidUuid(code)) {
    return sendError(res, 400, "Invalid authorization code format");
  }

  const clientCodeChallenge = codeVerifier
    ? clientCodeChallengeFromVerifier(codeVerifier)
    : null;
  if (!clientCodeChallenge) {
    return sendError(res, 400, "A valid OAuth code verifier is required");
  }

  try {
    // 1 & 2. Atomically look up AND consume the code (DELETE ... RETURNING)
    const [codeData] = await db
      .delete(oauthCodes)
      .where(and(
        eq(oauthCodes.code, code),
        eq(oauthCodes.clientCodeChallenge, clientCodeChallenge),
        gt(oauthCodes.expiresAt, new Date()),
      ))
      .returning({
        user_id: oauthCodes.userId,
        expires_at: oauthCodes.expiresAt,
      });

    if (!codeData) {
      return sendError(
        res,
        400,
        "Invalid or already consumed authorization code",
      );
    }

    const userId = codeData.user_id;

    // 4. Look up user email
    const { data: authData, error: userError } =
      await supabaseAdmin.auth.admin.getUserById(userId);
    if (userError || !authData?.user) {
      return sendError(res, 404, "User not found");
    }

    const email = authData.user.email;

    // 5. Mint tokens
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: "15m" });

    const refreshToken = crypto.randomBytes(40).toString("hex");
    const tokenHash = hashToken(refreshToken);

    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(refreshTokens).values({
      userId,
      tokenHash,
      expiresAt: newExpiresAt,
    });

    res.cookie("refresh_token", refreshToken, refreshCookieOptions());

    return sendSuccess(res, 200, {
      accessToken: token,
      token: token, // Alias for backward compatibility
      user: authData.user,
    });
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}
