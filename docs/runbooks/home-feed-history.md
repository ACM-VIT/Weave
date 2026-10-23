# Home feed history

The product decision for [Weave #100](https://github.com/ACM-VIT/Weave/issues/100)
is a maximum of **500 cards** in Home's account-scoped query cache and in-memory
offline history. Older cards leave memory and cannot be back-scrolled. Refresh
starts a new feed session; this feature adds no persistent offline archive.

`retainHomeFeedHistory` applies the limit before QueryClient publishes fetched or
optimistically patched data. It trims rows as well as pages, preserves paired page
parameters and the final continuation/terminal cursor, and drops empty intermediate
pages. The pagination controller releases evicted page references and deduplication
IDs after a committed update. Mapper caches remain weak, and Home retains only its
current bounded projection. The limit is a card count, not a fixed byte allowance:
individual README/payload sizes and a transient in-flight response still vary.

The newest cards are retained. If a response arrives after the viewer has scrolled
back, currently visible cards are pinned within the same 500-card allowance; other
old cards leave first. A visible pinned card may therefore temporarily sit before
a gap in retained history. Paging remains forward-only. Its authoritative cursor
continues after the newest fetched page, while a refetch begins from the first
retained page's original request cursor.

Eviction preserves repository/serve/position identities. Discovery rows use a
stable repository key without a list index. Home compensates its fixed-height
scroll offset for changes before the visible identity, preserving fractional
position and the mounted row's local state. Refresh and account changes reset
presentation tracking. This preserves the visible row's impression state during
eviction; it does not introduce a global lifetime impression registry.

Local validation uses 10,000 synthetic served cards through a real infinite-query
observer, varied page lengths, partial trimming, terminal pages, retained-cursor
refetches, and mounted Home tests for personalized and discovery feeds. The mounted
Home fixture retains real query/pagination/mapping hooks and substitutes native
rendering plus an instrumented card boundary. Native-device scroll profiling and
production memory measurements remain separate acceptance work under #135.
