# Weave Explore

## Context and ownership
Weave helps developers discover repositories, people and curated Lists. Phase 4 changes Explore only. Existing repository, user and board routes remain the destination contracts. Components in `src/components/explore` own Explore styling; `src/models/repository.ts` and `src/models/list.ts` own product data shapes.

## Visual direction
Follow the existing dark Weave surfaces and the supplied Spotify pill reference. Palette: canvas #000000, surface #1C1C1E, pill #272729, text #FFFFFF, secondary #B8B8C0, action #63E6A9. Typography uses the existing system family: 30/700 screen title, 18/700 featured repository names, 15/600 row names, 13/19 summaries, tabular ranking numerals. Spacing uses 8/12/16/20; cards use radius 16, pills 24. Tokens are local constants/inline styles in the existing Explore components, not a new global theme.

## Signature and behavior
Trending uses actual backend ranks: large medal-colored numerals and restrained outlines for the top three, compact rows below. Summaries are bounded to two lines for featured rows and one otherwise. Stars, forks, language and score remain visible; full trend features stay in the mapped model. Only backend-populated periods appear as controls.

Search pills: All, Repositories, People, Lists. Additional content types stay hidden until supported. All interleaves groups while preserving within-group ranking. Selection preserves the query. The search is transient native discovery state rather than persisted URL state, avoiding private query text in navigation/history. Clear acts immediately and restores input focus. The 300ms debounce and transport share an AbortSignal; two characters are required. Web IME composition pauses search. FlatList owns vertical scrolling; horizontal pill strips own only horizontal scrolling. Explicit Load more supports bounded pages. Cached results survive refresh failures, with loading, empty, offline, error and keyword-fallback feedback. Internal routes are mandatory for every result.
