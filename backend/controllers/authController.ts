import crypto from "crypto";
import { eq } from "drizzle-orm";
import type { CookieOptions, NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import supabase, {
  createRecoverySupabaseClient,
  supabaseAdmin,
} from "../config/supabase.js";
import { db } from "../db/index.js";
import { appOauthCodes as oauthCodes, appRefreshTokens as refreshTokens, appUsers as users } from "../db/v2Schema.js";
import { ensureIdentityProfile, fallbackUsername } from "../services/identityService.js";
import { updatePasswordFromRecoverySession } from "../services/passwordRecoveryService.js";
import {
  sendControllerError,
  sendError,
  sendSuccess,
} from "../utils/response.js";
import { isValidUuid } from "../utils/validators.js";
import { resolveClientRedirect } from "../security/originPolicy.js";

const CLIENT_URL = process.env.CLIENT_URL;
const BACKEND_URL = process.env.BACKEND_URL;

if (!CLIENT_URL)
  throw new Error("Missing required environment variable: CLIENT_URL");
if (!BACKEND_URL)
  throw new Error("Missing required environment variable: BACKEND_URL");

const JWT_SECRET = process.env.JWT_SECRET as string;
const PASSWORD_RESET_URL = process.env.PASSWORD_RESET_URL
  ?? CLIENT_URL.replace(/callback\/?$/, "reset-password");
const LOCAL_OAUTH_ORIGIN = "http://localhost:3000";
const LOCAL_OAUTH_REDIRECT_COOKIE = "local_oauth_client_redirect";

if (!JWT_SECRET) {
  throw new Error(
    "FATAL ERROR: JWT_SECRET is not defined in environment variables.",
  );
}

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

const isPrivateDevelopmentHost = (hostname: string): boolean => {
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "10.0.2.2"
  ) {
    return true;
  }
  if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) {
    return true;
  }
  const match = hostname.match(/^172\.(\d{1,2})\./);
  return Boolean(
    match && Number(match[1]) >= 16 && Number(match[1]) <= 31,
  );
};

const getBackendCallbackUrl = (req: Request): URL => {
  const configuredCallback = new URL("/api/auth/callback", BACKEND_URL);
  if (process.env.NODE_ENV === "production") return configuredCallback;

  const host = req.get("host");
  if (!host) return configuredCallback;

  try {
    const requestOrigin = new URL(`http://${host}`);
    if (
      requestOrigin.protocol === "http:" &&
      requestOrigin.port === "5000" &&
      isPrivateDevelopmentHost(requestOrigin.hostname)
    ) {
      return new URL("/api/auth/callback", requestOrigin);
    }
  } catch {
    // Fall back to the explicitly configured backend origin.
  }

  return configuredCallback;
};

const isLocalOAuthRequest = (req: Request): boolean => {
  return process.env.NODE_ENV !== "production"
    && req.socket.localPort === 3000
    && (req.hostname === "localhost" || req.hostname === "127.0.0.1");
};

const createOAuthCode = async (user: {
  id: string;
  user_metadata?: Record<string, unknown>;
}): Promise<string> => {
  await ensureIdentityProfile({
    userId: user.id,
    username: fallbackUsername(user.id, user.user_metadata),
    fullName: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : null,
    githubId: typeof user.user_metadata?.provider_id === "string" ? user.user_metadata.provider_id : null,
    githubHandle: typeof user.user_metadata?.user_name === "string" ? user.user_metadata.user_name : null,
    avatarUrl: typeof user.user_metadata?.avatar_url === "string" ? user.user_metadata.avatar_url : null,
  });

  const [codeData] = await db
    .insert(oauthCodes)
    .values({
      userId: user.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })
    .returning({ code: oauthCodes.code });

  if (!codeData) throw new Error("Failed to generate OAuth exchange code");
  return codeData.code;
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
  let { email, password, username, full_name } = req.body;

  if (!username || typeof username !== "string" || username.trim() === "") {
    return sendError(res, 400, "Username is required");
  }

  // Normalize username to prevent whitespace bypasses (" alice " vs "alice")
  username = username.trim();

  try {
    // 0. Pre-emptively check if username is taken to avoid messy trigger constraint violations
    if (username) {
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.username, username));
      if (existingUser.length > 0) {
        return sendError(res, 409, "Username is already taken");
      }
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Bypass email verification so we can login immediately
      user_metadata: {
        user_name: username,
        full_name: full_name,
      },
    });

    if (error) return sendError(res, error.status || 400, error.message);

    const userId = data.user.id;

    try {
      await ensureIdentityProfile({ userId, username, fullName: full_name ?? null });
    } catch (databaseError) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      throw databaseError;
    }

    // 1. Generate Custom JWT Access Token
    const accessToken = jwt.sign({ userId, email }, JWT_SECRET, {
      expiresIn: "15m",
    });

    // 2. Generate and store Refresh Token securely using Drizzle
    const refreshToken = await createAndStoreRefreshToken(userId);

    // 3. Set refresh token in HTTP-only cookie
    res.cookie("refresh_token", refreshToken, refreshCookieOptions());

    return sendSuccess(res, 201, {
      message: "Signup successful",
      accessToken,
      token: accessToken, // Alias for backward compatibility
      user: data.user,
    });
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

    await ensureIdentityProfile({
      userId,
      username: fallbackUsername(userId, data.user.user_metadata),
      fullName: typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : null,
      avatarUrl: typeof data.user.user_metadata?.avatar_url === "string" ? data.user.user_metadata.avatar_url : null,
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

    if (process.env.NODE_ENV !== "production") {
      const host = req.get("host");
      try {
        const requestOrigin = host ? new URL(`http://${host}`) : null;
        if (
          requestOrigin
          && requestOrigin.port === "5000"
          && isPrivateDevelopmentHost(requestOrigin.hostname)
        ) {
          const localStartUrl = new URL(`/api/auth/local/start/${provider}`, LOCAL_OAUTH_ORIGIN);
          localStartUrl.searchParams.set("client_redirect", clientRedirect);
          return sendSuccess(res, 200, { url: localStartUrl.toString() });
        }
      } catch {
        // Use the normal public callback path when the request host is invalid.
      }
    }

    const callbackUrl = getBackendCallbackUrl(req);
    callbackUrl.searchParams.set("client_redirect", clientRedirect);
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
    url.searchParams.set("provider", provider);
    url.searchParams.set("redirect_to", callbackUrl.toString());

    return sendSuccess(res, 200, { url: url.toString() });
  } catch (error) {
    sendControllerError(res, error as Error);
  }
}

// GET /api/auth/local/start/:provider
// Development-only bridge that deliberately uses Supabase's existing localhost Site URL.
export async function startLocalOAuth(req: Request, res: Response): Promise<void> {
  if (!isLocalOAuthRequest(req)) return sendError(res, 404, "Not found");

  const { provider } = req.params;
  if (provider !== "github" && provider !== "google") {
    return sendError(res, 400, "Invalid provider.");
  }

  const clientRedirect = getClientRedirect(req.query.client_redirect);
  res.cookie(LOCAL_OAUTH_REDIRECT_COOKIE, clientRedirect, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 10 * 60 * 1000,
  });

  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/authorize`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("redirect_to", `${LOCAL_OAUTH_ORIGIN}/`);
  res.redirect(url.toString());
}

// POST /api/auth/local/session
// Converts the localhost fallback's Supabase token into the existing one-time code flow.
export async function exchangeLocalSupabaseSession(req: Request, res: Response): Promise<void> {
  if (!isLocalOAuthRequest(req)) return sendError(res, 404, "Not found");

  const accessToken = typeof req.body?.access_token === "string"
    ? req.body.access_token.trim()
    : "";
  if (!accessToken || accessToken.length > 8192) {
    return sendError(res, 400, "A valid Supabase access token is required");
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
    if (error || !data.user) return sendError(res, 401, "Invalid Supabase session");

    const code = await createOAuthCode(data.user);
    res.clearCookie(LOCAL_OAUTH_REDIRECT_COOKIE, { path: "/" });
    return sendSuccess(res, 200, { code });
  } catch (error) {
    sendControllerError(res, error);
  }
}

// GET / on the development-only port 3000.
export function serveLocalOAuthBridge(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isLocalOAuthRequest(req)) return next();

  const clientRedirect = getClientRedirect(req.cookies[LOCAL_OAUTH_REDIRECT_COOKIE]);
  const serializedRedirect = JSON.stringify(clientRedirect).replace(/</g, "\\u003c");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Completing sign-in</title></head>
<body style="margin:0;background:#000;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh">
  <main style="text-align:center;padding:24px"><h2>Completing sign-in…</h2><p id="status" style="color:#aaa">Returning to GH Social</p></main>
  <script>
    (async function () {
      const target = ${serializedRedirect};
      const hash = new URLSearchParams(location.hash.slice(1));
      const query = new URLSearchParams(location.search);
      const error = hash.get('error_description') || hash.get('error') || query.get('error_description') || query.get('error');
      const goBack = (key, value) => {
        const separator = target.includes('?') ? '&' : '?';
        location.replace(target + separator + key + '=' + encodeURIComponent(value));
      };
      if (error) return goBack('error', error);

      const accessToken = hash.get('access_token');
      history.replaceState(null, '', '/');
      if (!accessToken) return goBack('error', 'OAuth completed without a session token');

      try {
        const response = await fetch('/api/auth/local/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: accessToken })
        });
        const payload = await response.json();
        if (!response.ok || !payload.data?.code) {
          throw new Error(payload.error || 'Unable to create the local app session');
        }
        goBack('code', payload.data.code);
      } catch (error) {
        document.getElementById('status').textContent = error.message || 'Local OAuth failed';
      }
    })();
  </script>
</body>
</html>`);
}

// GET /api/auth/callback
export async function handleOAuthCallback(
  req: Request,
  res: Response,
): Promise<void> {
  const code = req.query.code as string;
  const clientRedirect = getClientRedirect(req.query.client_redirect);

  if (!code) {
    const reason = (req.query.error as string) || "no_code";
    return res.redirect(
      `${clientRedirect}?error=${encodeURIComponent(reason)}`,
    );
  }

  try {
    // 1. Exchange the provider code for a Supabase session using the Admin client
    const { data, error } =
      await supabaseAdmin.auth.exchangeCodeForSession(code);

    if (error || !data.user) {
      console.error("OAuth Exchange Error:", error);
      return res.redirect(
        `${clientRedirect}?error=Authentication failed`,
      );
    }

    // 2. Ensure the product profile exists and issue a one-time app exchange code.
    const exchangeCode = await createOAuthCode(data.user);

    // 4. Redirect to your frontend with the short-lived code.
    res.redirect(`${clientRedirect}?code=${exchangeCode}`);
  } catch (error) {
    console.error("OAuth Callback Caught Error:", error);
    res.redirect(`${clientRedirect}?error=Internal server error`);
  }
}

// POST /api/auth/exchange
export async function exchangeAuthCode(
  req: Request,
  res: Response,
): Promise<void> {
  const { code } = req.body;

  if (!code) {
    return sendError(res, 400, "Authorization code is required");
  }

  if (!isValidUuid(code)) {
    return sendError(res, 400, "Invalid authorization code format");
  }

  try {
    // 1 & 2. Atomically look up AND consume the code (DELETE ... RETURNING)
    const [codeData] = await db
      .delete(oauthCodes)
      .where(eq(oauthCodes.code, code))
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

    // 3. Check expiration
    if (new Date(codeData.expires_at) < new Date()) {
      return sendError(res, 400, "Authorization code expired");
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
