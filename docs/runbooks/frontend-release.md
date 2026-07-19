# Weave frontend release runbook

## One-time EAS setup

1. Connect the GitHub repository to the EAS project referenced by `app.json`.
2. Choose the EAS Hosting subdomain and, if applicable, attach the production custom domain.
3. Create `development`, `preview`, and `production` EAS environments.
4. Set these plain-text or sensitive client variables in the appropriate environments:
   - `EXPO_PUBLIC_BACKEND_URL` (must end in `/api`)
   - `EXPO_PUBLIC_WEB_URL`
   - `EXPO_PUBLIC_SENTRY_DSN` (optional)
5. When Sentry is enabled, add `SENTRY_AUTH_TOKEN` as a sensitive build variable and configure `SENTRY_ORG` and `SENTRY_PROJECT`.
6. Configure Android and iOS signing credentials for the `production` profile.

Never store private API keys in an `EXPO_PUBLIC_*` variable. Expo inlines those values into client bundles.

## Backend production configuration

Set the final web origin and reset URL before deploying the web frontend:

```env
CLIENT_URL=ghsocial://callback
CORS_ORIGINS=https://your-production-web-origin.example
OAUTH_REDIRECT_ORIGINS=https://your-production-web-origin.example,ghsocial://callback
PASSWORD_RESET_URL=https://your-production-web-origin.example/reset-password
```

Add the same HTTPS OAuth and password-reset callbacks to the GitHub, Google, and Supabase provider allowlists. Do not use wildcard production origins.

## Required verification

Run from the repository root:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run doctor
npx expo install --check
npm audit --omit=dev --audit-level=high
npm run export:all
```

Run from `backend/`:

```sh
npm ci
npm run build
npm test
```

## Deployment

- `.eas/workflows/deploy-web.yml` deploys production web after a push to `main` or `master`.
- `.eas/workflows/create-production-builds.yml` is manually triggered for signed Android and iOS builds.
- The GitHub CI workflow verifies source, tests, dependency alignment, audits, and all-platform exports before merge.

## Post-deployment smoke test

Verify on production web, Android, and iOS:

1. Email signup, email login, GitHub OAuth, and Google OAuth.
2. Password-reset email, link handling, and password update.
3. Session remains valid after the 15-minute access token expires.
4. Onboarding completes and opens the repository feed.
5. Feed pagination, README display, comments, likes, dislikes, and saves.
6. Explore search and trending repositories.
7. Profile editing, boards, collections, saved repositories, follower lists, and logout.
8. Terms and Privacy pages are reachable before login.
9. Production CORS rejects an unapproved origin with HTTP 403.
10. A controlled test exception appears in Sentry with the correct release when monitoring is enabled.

If a web release must be rolled back, use the previous immutable EAS Hosting deployment and move the production alias back to that deployment.
