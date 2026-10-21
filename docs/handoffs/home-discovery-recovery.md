# Home recovery from recommendation unavailability

The local API correctly returned `503 PERSONALIZED_FEED_UNAVAILABLE` because recommendation ML was disabled and the viewer had no active durable recommendation generation. Home previously retried that unavailable service repeatedly, then presented only an error. README generation was independent and could not repair this feed dependency.

Home now tries recommendations once (retaining conflict retries), then uses the existing authenticated canonical repository catalogue for this specific first-page unavailability response. It displays “Recently updated / Not personalized” in the existing fixed header. Catalogue ordering remains the backend's `updated_at DESC, repo_id`; no repository IDs, engagement counts, recommendations or authentication state are fabricated. The canonical listing now includes real owner profile IDs and viewer-follow state so the existing Follow control works on these cards too.

Catalogue cursors remain in catalogue mode instead of calling unavailable ML on every page or mixing personalized and catalogue results. Entries have no recommendation serve ID/position; the existing activity encoder therefore treats them as product interactions. Like/Dislike and Save update shared caches without remounting cards, and catalogue pagination remains available after those interactions. Deliberate refresh starts with recommendations again. The backend recommendation endpoint and strict production ML gates are unchanged; no new generation rows, schema migration, ML call, seed or application deployment was used to make Home load.

Authentication/offline failures, generic API errors and later personalized-page errors retain their error handling rather than switching sources. Empty catalogue state is explicit. Cached items remain visible during later fetch failures. The existing catalogue uses offset pagination: concurrent ingestion may shift page boundaries; the frontend removes repeated repository IDs while preserving earlier card identity/order. This is browsing rather than a recommendation snapshot.

## Verification

- Node 22.23.2; lint and typecheck pass.
- Frontend **157 tests pass**, including five new recovery/paging/source/identity regressions.
- Backend build passes; backend tests **148 pass**, **12 opt-in integrations skipped**.
- One separately enabled isolated PostgreSQL catalogue integration passes. It checks stored counts, README data, owner identity/follow state and absence of fabricated serve IDs; it deletes only its own test rows in the loopback test database.
- iOS/Android/web export succeeds; `git diff --check` passes.
- Authenticated in-app browser at 470x674 loads real Home cards. Read more opens the full generated structured summary, and Close returns to the same Files card. Like then Unlike changed the visible count 0→1→0 without replacing that card. Scrolling past the original ten loaded further real repositories (including React, React Native and Node), after the reaction test. Full reload returns to working Home. The reaction was restored; ordinary view/dwell telemetry may persist.
- No fresh native iOS/Android checks are claimed. The existing Phase 5 native accessibility, gesture and smallest-viewport QA matrix remains applicable, including the new source caption with large text. Runtime return to personalized recommendations is covered by orchestration tests; it cannot be verified against the currently unavailable ML deployment.

No push, deployment, Phase 6 work or changes to V2 database layout were performed.
