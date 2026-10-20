# Weave usability contract

Existing routing and API contracts are described in `docs/handoffs/phase-4-search.md`; visual ownership remains in `DESIGN.md`.

| Capability | Canonical owner | Variants | Verification |
| --- | --- | --- | --- |
| Form | `src/components/keyboard/keyboard-layout.tsx` | `KeyboardForm` for scrolling forms, `KeyboardSurface` for pinned searches and existing RN sheets | Keyboard inventory tests, narrow browser QA, native manual matrix |
| Fields | Existing `components/Auth` primitives and named native TextInputs | Password, email, username, multiline bio, search, comment | Accessible names; normal platform editing and focus order |
| Sheet | Existing Modal implementations | Save/List creation, comments, connections, profile editor | Measured screen offset, shrinkable preferred size, scrollable content and validation, reachable action |
| Navigation | Existing Expo Router routes and `repository-links.ts` | Repository, person, List | Routing/deep-link tests; explicit GitHub CTA only |
| Feedback | Existing inline form/sheet state | Loading, success, error, retry | Draft retained on failure; busy controls prevent duplicate submits |

KeyboardProvider is mounted once beneath the gesture root. Form scrolling uses the SDK 56-compatible keyboard controller's measured focus/caret and real keyboard frame; it never guesses keyboard height. Forms must not nest another keyboard avoider or enable a second automatic keyboard inset. Surfaces use KeyboardAvoidingView with measured automaticOffset and padding on both platforms. Existing custom headers are inside each surface. Safe-area padding is additive on forms; a form already inside SafeAreaView opts out. Modal profile forms have their own SafeAreaProvider. Android app config explicitly uses resize; a new binary is required to validate config outside Expo Go. Tab-bar height/padding follows the bottom safe area. Only Explore hides its tab bar while editing; modal keyboards must not toggle the underlying feed tab layout.

Scroll containers use handled first taps and platform drag dismissal. Validation and submit actions remain in the scroll flow or in a reachable sheet footer. New input sites must extend the regression inventory and QA matrix. Search clear acts immediately and restores field focus. Small screens must support scrolling instead of clipping validation/actions. Native controls use accessible names and roles; existing sheet motion respects reduced motion. Save remains available through a labelled button independently of its gesture. Creation overlays hide background controls from screen-reader traversal.

Private text stays in transient form state. Do not log field contents. Do not change List privacy, search ranking, session semantics, or external sharing behavior as part of keyboard fixes. No Edit List or report/feedback form exists at the Phase 4 tip; adding those product flows is outside this usability phase.
