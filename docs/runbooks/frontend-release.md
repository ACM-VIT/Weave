# Weave frontend internal-QA release runbook

## Primary Android artifact flow (local only)

Internal Android QA builds are produced locally. This flow does not use EAS
Build, EAS environments, or EAS signing credentials.

Prerequisites:

- Node.js 22.13 or newer (the Expo SDK 56 minimum)
- The Android SDK and JDK 17
- Project dependencies installed with `npm ci`
- An existing generated `android/` project, or explicit permission to run
  prebuild as described below

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
5. Verifies the selected HTTPS API URL inside the generated Hermes bundle.
6. Copies the Gradle output to
   `artifacts/Weave-v2.0.0-internal-QA.apk`.
7. Prints the artifact's SHA-256 digest for handoff verification.

The default APK contains the `arm64-v8a` ABI used by modern Android phones and
is much smaller than the old four-architecture universal APK. Override this
only when a tester needs a different ABI:

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

The builder requires Java 17, matching Expo SDK 56's Android build environment.
It checks `WEAVE_ARTIFACT_JAVA_HOME`, `JAVA_HOME`, and common macOS/Homebrew JDK
17 locations in that order. Set the explicit override on other machines when
the JDK is installed elsewhere.

### When to run prebuild

Do not prebuild for ordinary TypeScript, styling, asset, or other frontend-only
changes. Run prebuild only after changing native dependencies or build-time app
configuration such as the package ID, URL scheme, plugins, permissions, icon,
or splash screen:

```sh
npm run build:android:artifact -- --prebuild
```

`--prebuild` runs `expo prebuild --platform android` without `--clean`, then
continues with the same Gradle artifact build. Prebuild modifies the generated
native project, which is why it is opt-in. Review `app.json` and generated
native configuration before distributing that artifact.

## Signing and upgrade limitations

The current `release` Gradle build uses the local Android debug signing key.
Therefore this APK is:

- for internal QA only;
- not suitable for Google Play or any production/store release; and
- not guaranteed to be upgrade-safe across machines, regenerated native
  directories, or changed debug keystores.

Android can install a new APK over an existing copy only when the application
ID and signing certificate match and its version code is acceptable. If the
debug certificate changes, testers must uninstall the old app first, which
also removes its local app data. Before claiming upgrade-safe QA distribution,
configure a persistent QA keystore outside the repository and increment
`expo.android.versionCode` for each distributed build.

## Backend OAuth configuration

The backend deployment used by an artifact must include:

```env
CLIENT_URL=ghsocial://callback
CORS_ORIGINS=https://your-production-web-origin.example
OAUTH_REDIRECT_ORIGINS=https://your-production-web-origin.example,ghsocial://callback
PASSWORD_RESET_URL=https://your-production-web-origin.example/reset-password
```

Keep GitHub and Google configured with Supabase's provider callback (normally
`https://<supabase-project>.supabase.co/auth/v1/callback`). Add the backend
broker callback `https://weave-backend.krishang.dev/api/auth/callback` to the
Supabase redirect allowlist only. Do not add the backend callback directly to
GitHub or Google, and do not use wildcard production origins.

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

Store releases require a separate local signing and release process; this
debug-signed internal-QA artifact must never be promoted directly to a store
build. EAS is not part of the supported Weave build workflow.
