# Phase 5: keyboard and interaction usability

## Scope and preflight

Work is on `fix/product-fixes-v2` in the isolated managed worktree `phase-5-keyboard/gh-social`. This worktree started clean from `5c42129`; Phase 1 `962c37f`, Phase 2 `4b177bd`, Phase 3 `e1296f3`, and Phase 4 `5c42129` are ancestors. The supplied checkout and the earlier `codex/product-fixes-v2` worktree contained unrelated untracked/uncommitted work and were left intact. The requested branch did not exist locally, so it was created from the committed Phase 4 tip. Every npm/Expo/build/test command used Node **22.23.2** via `/opt/homebrew/opt/node@22/bin`.

Read root `AGENTS.md` before editing. SDK 56 documentation read:

- [SDK 56 reference and its React Native 0.85 compatibility](https://docs.expo.dev/versions/v56.0.0/)
- [Keyboard controller, including Expo Go support](https://docs.expo.dev/versions/v56.0.0/sdk/keyboard-controller/), [Expo keyboard handling](https://docs.expo.dev/guides/keyboard-handling/)
- [Safe-area context](https://docs.expo.dev/versions/v56.0.0/sdk/safe-area-context/)
- [App configuration, softwareKeyboardLayoutMode](https://docs.expo.dev/versions/v56.0.0/config/app/#softwarekeyboardlayoutmode)
- [Native UI](https://docs.expo.dev/versions/v56.0.0/sdk/ui/), [universal BottomSheet](https://docs.expo.dev/versions/v56.0.0/sdk/ui/universal/bottomsheet/)
- The versioned Expo reference delegates React Native APIs to RN docs. Its `/react-native/keyboardavoidingview`, `/modal`, and `/scrollview` URLs are unavailable; read the exact SDK-matched [RN 0.85 KeyboardAvoidingView](https://reactnative.dev/docs/0.85/keyboardavoidingview), [Modal](https://reactnative.dev/docs/0.85/modal), and [ScrollView](https://reactnative.dev/docs/0.85/scrollview) references instead.

## Implementation and repository-wide inventory

`KeyboardForm` owns automatic focused-input/caret scrolling; `KeyboardSurface` owns measured keyboard avoidance for pinned headers and existing sheets. Both use the Expo-installed keyboard controller 1.21.6. No keyboard height constants or JS keyboard-frame animations. The single root KeyboardProvider drives both platforms. Native form controls and existing Modal presentation/mutation lifecycles are retained: replacing these composed RN sheets with SwiftUI/Compose trees would broaden Phase 5 and introduce another presentation migration. Native UI/BottomSheet documentation was consulted before retaining the existing implementation.

Forms have handled first taps, drag dismissal, additive safe-area padding, scrollable validation/actions, and accessible field names. The profile pageSheet has its own safe-area provider. Sheet preferred heights can shrink; Save-to-List's header/search/results scroll above its footer, and its nested Create List panel scrolls independently with background accessibility hidden. Android config explicitly uses resize, while keyboard controller owns avoidance. Tab padding follows the device inset; only Explore hides its tab bar during keyboard entry, avoiding a new feed resize beneath editable modals. Existing occasional sheet transitions respect reduced motion. Small controls were enlarged or given larger hit areas; the green onboarding CTA now uses dark text for contrast. No new visual system or product flows were added.

The `TextInput` inventory regression test enumerates all 12 raw-input files and requires accessible names. Repository-wide audit also searched all input wrappers, Modal declarations, editable sheet and prompt usages. The only additional match outside `src`/tests is the historical `scratch-fix-fonts.js` source-rewriting script, which renders no UI.

| Screen / surface | Input sites and audit result |
| --- | --- |
| Profile edit | Username, Bio/job role, Name; focus-aware scrolling, error and Save/Cancel in scroll flow; busy state and modal close guard |
| Login | Email, password; focus-aware scrolling, labelled fields, password autofill/capitalization semantics |
| Email signup | Name, username, email, password; native date picker is separate; form and password validation scroll with CTA |
| Forgot password | Email; formerly fixed layout, now scrollable |
| Reset password | New password, confirmation, mismatch/link/server messages; scrollable and new-password autofill |
| Onboarding/create-profile | Name, username, date, bio; focus-aware scrolling and reachable validation/Create Account |
| Onboarding step 1 | No text input; existing SafeAreaView and scroll owner keep selection validation/Continue reachable |
| Onboarding step 2 | Custom technology input/Add; shared form inside existing SafeAreaView; Add has label and 48-unit target |
| Onboarding step 3 | No text input; Finish/error selection screen now uses safe-area-aware scroll owner |
| Explore + People search | Same shared SearchBar with All/Repositories/People/Lists; pinned measured surface, drag dismissal, clear restores focus, 48-unit search/clear targets |
| Followers / Following routes | Shared ConnectionList under measured surface; list has handled taps/drag dismissal and focus-restoring clear |
| Connection/follower sheets | Shared ConnectionList search; shrinkable sheet, measured offset, safe-area top clearance |
| Saved / Liked repository sheets | Shared ProfileRepositoryList filter; same surface, clear focus and list behavior |
| Save-to-List | Filter and selection; header/filter/results scroll, reachable pinned Save, errors retained |
| Create List | Name inside SavePopup; scrollable creation overlay, accessible background exclusion, errors/draft retained until success |
| Edit List | No edit form or rename prompt exists in this Phase 4 checkout. No new editing feature was invented |
| Comments | Single-line comment composer and send; shrinkable sheet, scrollable comments, visible inline error, 48-unit Send/Close |
| Report / feedback | No report or free-text feedback modal exists. Feed feedback is Like/Dislike actions |
| Share / README / logout / calendar | Read-only or native date controls; no text entry. Existing Share sheet respects reduced motion |
| Generic InputField | No live consumers found; retained accessible field/Continue semantics and 48-unit arrow target |

## Verification evidence

Automated checks use Node 22.23.2:

- `npm run lint`: passes, no warnings.
- `npm run typecheck`: passes.
- `npm test`: **142 passed**, no failures (136 baseline + 6 Phase 5 regression tests).
- `npm run doctor`: **20/21**, exits nonzero for the existing unmaintained `react-native-render-html` metadata warning. Not suppressed or claimed passed. Sentry also warns about absent local build-project configuration.
- `npx expo install --check`: passes; dependencies up to date.
- `npm run export:all -- --output-dir dist`: iOS/Android/web export completed.
- `cd backend && npm run build && npm test`: build passes; **139 passed, 8 opt-in integration tests skipped**, no failures. Initial bare-environment test run failed at config import; rerun used isolated loopback test DATABASE_URL and Supabase dummy keys. No production credentials/services were used and no backend source changed.
- `git diff --check`: passes.
- DESIGN.md lint: zero errors, one existing no-YAML-frontmatter warning; maintained Markdown design context retained.
- Strict frontend static audit: zero findings (`artifacts/phase-5/ui-audit.json`). This does not prove native focus/gesture behavior.

Regression coverage: raw input inventory/accessibility names, canonical form/surface wiring, provider/Android resize configuration, shrinkable editable sheets, accidental/diagonal Save motion, and Explore-only keyboard tab hiding so editable modals do not newly toggle the feed tab layout. Existing executable regressions cover feed identity and reaction patching, summary versus README, List membership keys and multi-List payloads, internal repository/search navigation, links/auth-return handling, share-result semantics, search cancellation/ranking/fallback and long-content mapping.

Browser checks use installed Chrome and the static export. All four authentication forms passed at **320×568**, **360×640**, and **320×300** constrained height: every actual input and visible button was scrolled into the viewport, with no horizontal overflow or page errors. The 300px height is a layout constraint, not an emulated native keyboard. At 320×568, intercepted local-only API fixtures exercised profile edit field reachability, save failure retaining editor/draft, Explore empty/error/retry/keyword fallback, clear/focus restoration, and onboarding long bio/invalid username. See JSON reports and screenshots in `artifacts/phase-5/`.

Expo Go was attempted first. Local Android Pixel_9 AVD booted with **640×1136 px at 320 dpi = 320×568 dp**. Initial LAN/localhost connection attempts failed to download; LAN binding with a loopback advertised host and `adb reverse` loaded successfully. Login's password was focused with the real docked Gboard visible: focused input bounds **[95,296][545,408] px**, above keyboard top **522px**. Drag dismissed the keyboard and made Log In reachable; screenshot retained. Forgot-password loaded and accepted input with Gboard's floating handwriting toolbar; this is not a docked-keyboard pass for that form. The saved emulator state also carries a pre-existing failed-session-revocation dev warning because the local backend is absent. No real account was used and no successful authentication is claimed.

No iOS device/simulator was available (`xcrun simctl` unavailable). Browser WebKit/iPhone viewport testing is not substituted for native iOS keyboard/sheet testing. Android Expo Go does not validate a newly generated standalone manifest's resize setting; standalone binary QA remains required.

## Cross-feature review and remaining manual QA matrix

**Pending rows below have not passed on device.** Source review and unit tests are explicitly distinct from runtime checks. Use iPhone SE 3 / 375×667 points (and a 320pt layout stress check), Android 320×568 dp, both docked/floating keyboards, large system text, VoiceOver/TalkBack, reduced motion, and a fresh authenticated test account against an isolated backend.

| Feature | Evidence completed | Manual checks still required |
| --- | --- | --- |
| Feed | Stable `feedId` keys and optimistic reaction cache patch reviewed; reaction identity/summary/README regressions pass; Pin absent from feed action UI | Like/Dislike repeatedly at later pages, confirm no remount/scroll reset; change orientation and return from each sheet |
| Save gesture | 20px activation/12px vertical failure, 76px reveal threshold and horizontal dominance reviewed/tested; Tech Stack Native gesture blocks the parent pan; labelled Save action exists | Right-swipe versus vertical paging and Tech Stack scrolling on both OSes; jitter/diagonals/multi-touch; use Save with screen reader |
| Repository detail | Feed, Explore/Trending, Saved/Liked and List cards use internal route helpers; tests pass; GitHub launch only explicit CTA in repository view | Navigate from each origin/back without losing position; save into two Lists, remove one, reopen and verify persistence; explicit CTA opens GitHub |
| Share | Native `Share.share`, clipboard call, generic share/copy icons, explicit completion semantics and deep-link/auth-return tests reviewed/passing | Native share/cancel, clipboard permission/failure, cold/warm deep links and post-login return on iOS/Android; no misleading brand icons |
| Explore / People / Trending | Fixture empty/error/retry/keyword fallback and clear focus verified in browser; virtualized rows, truncation, offline/loading states reviewed; Phase 4 search tests pass | Native loading/offline/reconnect and long names/summaries, populated ranked Trending, search input above docked keyboard, pending/cursor errors |
| Profile + auth + onboarding | Browser matrix above; Android login docked keyboard and drag dismissal; source inventory complete | Every field including last field with keyboard open, validation visible after failure, first-tap submit, large text; iOS pageSheet local safe area; signup/date picker handoff |
| Lists / comments / connections | Shared measured avoidance and shrink styles; creation scroll/focus and error retention reviewed; regressions enforce wiring | At smallest viewport open every sheet, keyboard, server validation and long error; scroll to action; double submit; dismissal/back; multi-List success; comment success/error; follower filter/clear |
| Accessibility | Names/roles/clear focus, enlarged key controls, reduced sheet motion, dark CTA contrast reviewed; automated input-name inventory passes | Full focus order and modal focus return; creation background exclusion with TalkBack; touch accuracy; contrast across themes/disabled states; VoiceOver/TalkBack announcement order |

Reproduce browser checks with a static server that resolves extensionless routes to `<route>.html`. Run `WEAVE_QA_BASE_URL=http://127.0.0.1:8095 node scripts/phase5-browser-qa.cjs` and `node scripts/phase5-authenticated-qa.cjs` with the same base env. Install Playwright separately or set `WEAVE_PLAYWRIGHT_MODULE` to its module location. The authenticated script intercepts all `/v2/` calls with local fixture responses; it does not prove backend persistence. Serve an export with no production backend configuration.

No push, deployment, database migration, Phase 6 work or new product flow was performed.
