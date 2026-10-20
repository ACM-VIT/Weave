# Braces depth-guard backport

This private local package is a maintained compatibility derivative of released
`braces@3.0.3`, not an official fixed braces release. It mitigates
[CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
without migrating the supported Expo/Metro/Tailwind toolchain or relying on an
install-time patch script. Both installed callers, micromatch and chokidar, are
routed here by scoped root overrides.

## Source and changes

- Base: official npm `braces@3.0.3` tarball, SHA-256
  `1cd18e862c8640b4568b1425a7df4ee030ff201d45b2da8f9f222d2987494ffc`.
  `index.js` and the MIT `LICENSE` are unchanged from that release.
- Apply only the five `lib/` depth-guard diffs from
  [upstream PR 72](https://github.com/micromatch/braces/pull/72), pinned to source
  commit `28d440b5dd449dbf1fe6f3506cf94ecca4d02660`.
  That PR was closed without merge; these are not maintainer-approved releases.
- Preserve the released stringify parent argument while threading traversal
  depth, including `escapeInvalid` behavior. The pinned PR includes this fix.
- Centralize maxDepth normalization and read the option once per parser/walker,
  avoiding a getter changing the value between the finite check and clamp.
- Bound expansion's parent-chain traversal as well as rejecting parent cycles,
  following the defensive correction documented in
  [AWS Labs' downstream patch](https://github.com/awslabs/cli-agent-orchestrator/blob/main/patches/%40dieub%2Bbraces-depth-guard%2B3.0.3-pn.3.patch).
  No third-party fork package is installed.

## Contract and limits

Brace and parenthesis nesting, direct AST child traversal, and expansion parent
traversal are limited to 100. A finite non-negative maxDepth can make the limit
stricter, including fractional values; larger values cannot raise the hard cap.
Non-numeric or non-finite maxDepth uses 100; negative finite values are rejected.
Excess string nesting throws SyntaxError; excess AST traversal throws RangeError.
The original input-length and expansion-range limits remain unchanged. This is
a nesting/traversal mitigation, not a general bound on expansion cardinality or
arbitrary AST width.

The local name and version `@weave/braces-compat@0.0.0` identify an unpublished
derivative, not a fictitious upstream fixed version. Version-based scanners may
not understand local source backports; do not use disappearance from their output
as proof of remediation or dismiss the upstream advisory on that basis. The
committed security/compatibility tests exercise the guarded implementation and
the real glob and watcher parents after a clean scripts-disabled install.

Monitor the upstream advisory and retire this package plus its overrides once a
compatible maintainer-reviewed fixed release is available. Review subsequent
upstream security changes until then. Reverting this backport restores the known
unbounded traversal behavior.
