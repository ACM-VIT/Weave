---
name: Weave
colors:
  background: '#000000'
  surface: '#1C1C1E'
  accent: '#30D158'
  text: '#FFFFFF'
typography:
  sans:
    fontFamily: 'Nata Sans, system-ui, sans-serif'
omitted:
  - section: spacing
    reason: Existing runtime Spacing tokens remain authoritative.
  - section: rounded
    reason: Existing shared components own their corner geometry.
---

# Weave

Weave is a phone-first open-source discovery product. Preserve its existing dark,
compact repository cards and green actions. The runtime source of truth is
`src/constants/theme.ts`: `REFERENCE_THEME` for content, `APP_THEME` for the tab
shell, and `Spacing` for layout. This document records those choices; it does not
generate a second token system.

Explore reuses SearchBar, RepoCard and TabBar. Trending uses compact ranked rows
in a virtualized list, with gold/silver/bronze reserved for the top three ranks.
Repository results open inside Weave; people and lists use existing routes.
The detail screen reads the existing repository API and presents README source
as selectable text, without introducing another HTML renderer.

Search stays local to the Explore tab, follows the existing English UI, and uses
explicit Load more. Preserve loaded results offline; label keyword fallback;
provide loading, empty, failure and retry states. Cancel superseded searches and
restart expired pagination. Use accessible controls and the existing safe-area
layout. Avoid decorative gradients, new font families and unrelated screen
restyling in this feature.
