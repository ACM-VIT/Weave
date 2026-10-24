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

## Phase 5 usability ownership
The existing dark identity and component tokens remain authoritative. Phase 5 adds no new palette or typography system. `src/components/keyboard/keyboard-layout.tsx` owns focus-aware form scrolling and measured keyboard avoidance; form fields remain the existing Auth primitives. See `UX-CONTRACT.md` and `docs/handoffs/phase-5-usability.md` for behavior and verification. No visual-token drift was introduced; the onboarding green button uses dark text for readable contrast.

## Feed summary refinement
The existing feed card, colours and type remain unchanged. README summary height follows remaining feed layout space; the preview reserves two lines before the existing pill action, now called “Read more”. The popup reuses the existing README presentation, with a distinct README SUMMARY heading for summarized content. Existing `REFERENCE_THEME` and component styles own all colours/type; no new token system is introduced.

## Home service recovery

When the recommendation API explicitly reports personalized feed unavailability, Home uses the existing canonical repository catalogue and keeps the same card layout. The fixed header adds a quiet, readable “Recently updated / Not personalized” source label. Catalogue pages never masquerade as recommendation serves. Real counts, viewer state, summaries and internal navigation continue to use the shared repository model.

## Feed repository labels

`RecommendationReason` owns the single badge slot below README summary and above
the owner. Labels use Nata Sans Medium, 11/16pt, 11pt horizontal and 6pt vertical
padding, an 8pt corner radius and natural height of at least 30pt. The existing
repository details gap supplies separation from the owner; 3pt/2pt badge margins
add breathing room. Text wraps and scales with system fonts, without fixed height
or a one-line truncation cap. The summary keeps its existing flexible measured
viewport as the metadata row grows.

`REFERENCE_THEME.repositoryLabel` owns semantic tones: amber for a verified
GitHub trending rank, green for recent Weave likes, muted green-gray for GitHub
popularity. `repository-label-presentation.ts` is the typed central icon/copy/tone
registry. The wire union and validation live in `models/repository-label.ts`.
The API label is independent of recommendation source and feed position. Missing,
malformed, unknown and expired labels use the existing source explanation. Labels
are static metadata, with one accessible spoken phrase and no chevron or tap action.
