# Weave local Android release runbook

## Primary Android artifact flow (local only)

Internal Android QA builds are produced locally. This flow does not use EAS
Build, EAS environments, or EAS signing credentials.

Prerequisites:

- Node.js 22.13 or newer
- The Android SDK and JDK 17
- Project dependencies installed with `npm ci`
- A persistent release keystore outside the checkout and its SHA-256 certificate pin
- Private signing configuration in `~/.local/share/weave/signing/release-signing.env`,
  a file selected by `WEAVE_ANDROID_SIGNING_ENV`, or the process environment:
  `WEAVE_ANDROID_KEYSTORE`, `WEAVE_ANDROID_KEY_ALIAS`,
  `WEAVE_ANDROID_STORE_PASSWORD`, `WEAVE_ANDROID_KEY_PASSWORD`,
  `WEAVE_ANDROID_CERT_SHA256`. Use an absolute external keystore path, a release
  alias and the certificate's 64-character hex digest. Restrict private files to
  their owner and retain the key and credentials for future updates. Never put
  them in Git, public environment variables or application assets.
- An existing generated `android/` project, or explicit permission to run
  prebuild as described below

The private environment file contains the following keys. Replace the examples
with the existing release identity and keep the file outside the repository:

```dotenv
WEAVE_ANDROID_KEYSTORE=/absolute/private/path/weave-release.p12
WEAVE_ANDROID_KEY_ALIAS=weave-release
WEAVE_ANDROID_STORE_PASSWORD="your private store password"
WEAVE_ANDROID_KEY_PASSWORD="your private key password"
WEAVE_ANDROID_CERT_SHA256=your_64_character_certificate_digest
```

The builder loads the default private file automatically when it exists.
`WEAVE_ANDROID_SIGNING_ENV` selects another private file; explicitly supplied
process variables take precedence. For direct Gradle invocations, export these
values into the process environment yourself. Missing configuration, a key
inside the checkout, an Android debug identity or a mismatched certificate
stops the release build. Do not generate a different key for an ordinary update.

For normal frontend-only changes, run from the repository root:

```sh
npm run build:android:artifact
```

The script:

1. Validates the artifact backend URL.
2. Preflights both GitHub and Google with short-lived synthetic PKCE challenges
   and requires the deployed backend to return its `/api/auth/oauth/continue`
   broker URL. The build stops before Gradle if the backend is stale.
3. Overrides `EXPO_PUBLIC_BACKEND_URL` for the embedded release bundle.
4. Invalidates the generated release JavaScript bundle so it cannot retain an
   older backend URL, while preserving the native Gradle compilation cache.
5. Verifies the selected HTTPS API URL inside the generated Hermes bundle, then
   verifies the actual APK signature, pinned certificate, package, version code
   and non-debuggable manifest before copying the artifact.
6. Copies the Gradle output to
   `artifacts/Weave-v2.0.0-release.apk`.
7. Prints the artifact's SHA-256 digest for handoff verification.

The default APK contains both `armeabi-v7a` and `arm64-v8a` so internal QA can
run on older 32-bit and current 64-bit Android phones. To build a smaller
architecture-specific artifact, override this only when a tester needs a
different ABI:

```sh
WEAVE_ARTIFACT_ANDROID_ARCHITECTURES=x86_64 npm run build:android:artifact
```

Multiple comma-separated ABIs are supported, but they increase both build
time and artifact size.

The internal-QA command disables Sentry source-map auto-upload, so it does not
require Sentry organization, project, or auth-token credentials. Store release
automation must upload source maps separately with scoped credentials.

The default backend is `https://weave-backend.krishang.dev/api`. To build
against another QA backend, provide an HTTPS URL ending in `/api`:

```sh
WEAVE_ARTIFACT_BACKEND_URL=https://qa-backend.example/api \
  npm run build:android:artifact
```

The script rejects cleartext HTTP, `MISSING_CONFIG`, credentials embedded in
the URL, query parameters, fragments, and URLs that do not end in `/api`. It
sets `EXPO_PUBLIC_BACKEND_URL` itself, so a stale value in the root `.env`
cannot redirect the artifact to a private development backend.

The local builder requires Java 17.
It checks `WEAVE_ARTIFACT_JAVA_HOME`, `JAVA_HOME`, and common macOS/Homebrew JDK
17 locations in that order. Set the explicit override on other machines when
the JDK is installed elsewhere.

### When to run prebuild

Do not prebuild for ordinary TypeScript, styling or web-only asset changes.
Run prebuild after changing native dependencies or build-time app
configuration such as the package ID, URL scheme, plugins, permissions, icon,
or splash screen:

```sh
npm run build:android:artifact -- --prebuild
```

`--prebuild` runs `expo prebuild --platform android --no-clean`, then
continues with the same Gradle artifact build. Prebuild modifies the generated
native project, which is why it is opt-in. Review `app.json` and generated
native configuration before distributing that artifact.

## Signing and upgrade limitations

Release builds require the external persistent key and its pinned certificate.
The config plugin preserves this policy when regenerating `android/`; release
builds fail when signing configuration is absent. Android debug identities and
certificate mismatches are rejected. The artifact builder checks the signed APK
before copying it to the output directory. Run
`npm run build:android:artifact -- --help` for the complete configuration contract.

Retain the same signing key for future updates and increment
`expo.android.versionCode` for each distributed build. Existing debug-signed QA
installations cannot be upgraded in place to this release identity; reinstalling
removes local application data. Signing does not itself qualify a store release
or replace physical-device and provider OAuth acceptance.

## Backend OAuth configuration

The backend deployment used by an artifact must include:

```env
CLIENT_URL=ghsocial://callback
CORS_ORIGINS=https://your-production-web-origin.example
OAUTH_REDIRECT_ORIGINS=https://your-production-web-origin.example,ghsocial://callback
PASSWORD_RESET_URL=https://your-production-web-origin.example/reset-password
EMAIL_CONFIRMATION_URL=https://your-production-web-origin.example/confirm-email
```

Keep GitHub and Google configured with Supabase's provider callback (normally
`https://<supabase-project>.supabase.co/auth/v1/callback`). Add the backend
broker callback `https://weave-backend.krishang.dev/api/auth/callback` to the
Supabase redirect allowlist only. Do not add the backend callback directly to
GitHub or Google, and do not use wildcard production origins.

Also allowlist the exact email-confirmation and password-reset redirect URLs in
Supabase. `EMAIL_CONFIRMATION_URL` can instead be `ghsocial://confirm-email` for
a direct native confirmation link. Without an override, the backend derives
`/confirm-email` from a web client origin or `ghsocial://confirm-email` from the
configured native scheme.

## Required verification

Before building, run from the repository root:

```sh
npm run lint
npm run typecheck
npm test
npm run doctor
npx expo install --check
```

Run from `backend/` when backend or authentication behavior changed:

```sh
npm run build
npm test
```

After installing the APK, verify at minimum:

1. Email signup and login.
2. GitHub OAuth returns through `ghsocial://callback` and skips manual
   onboarding when the GitHub-derived profile is available.
3. Google OAuth returns through `ghsocial://callback`.
4. Session refresh still works after the access token expires.
5. Feed, profile, logout, Terms, and Privacy routes open normally.
6. The SHA-256 received by the tester matches the digest printed by the build.

Store releases require their own physical-device/provider qualification and
production configuration review. Emulator results qualify only the tested API
level and ABI. EAS is not part of the supported Weave build workflow.
