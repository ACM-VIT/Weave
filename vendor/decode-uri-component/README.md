# Decoder compatibility backport

This private local package contains the official `decode-uri-component@0.5.0`
scanner as a source backport, not a published Weave release. It replaces the
vulnerable recursive decoder used by `query-string@7.1.3`, while preserving its
CommonJS function export. In addition to adapting the module export, a local
security correction decodes each original encoded run once instead of repeatedly
replacing runs across already decoded output. BOM and truncated-C2 handling occur
only at original byte positions inside the existing upstream UTF-8 scanner.
Query-string already handles form-style `+` to space conversion before decoding.

The local correction removes repeated whole-input searches for distinct runs and
prevents double decoding such as `%2541-%41-%FF` becoming `A-A-%FF`; the result is
`%41-A-%FF`. Newly decoded percent signs are not interpreted again, including as
BOM/C2 replacements. Malformed sequences are handled left-to-right, so overlapping
invalid BOM sequences can differ from upstream's ordered global replacements.
The official upstream UTF-8 fixtures and focused Router regressions cover this
backport; it is no longer an export-only copy of upstream 0.5.0.

## Provenance

- Upstream: https://github.com/SamVerschueren/decode-uri-component
- Security fix: https://github.com/SamVerschueren/decode-uri-component/commit/fa479da
- Advisory: https://github.com/advisories/GHSA-vcc3-ghjq-m6fr
- Source: official npm `decode-uri-component@0.5.0` tarball, SHA-256
  `f42d289f996e6c9f0e33d8f31de1fe9a7a077c612dca489cafdb2df4cbb6122f`
- Unmodified upstream `index.js` SHA-256:
  `9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa`
- The upstream MIT license is retained in `LICENSE`.

The root npm override routes only query-string's decoder here. No install script
patches node_modules, so clean installs with scripts disabled use the same code.
The local version `0.0.0` identifies this as a compatibility package, not an
upstream release or a security-version assertion.

Remove this package and the override when the supported Expo Router/query-string
chain can consume an upstream patched decoder directly. Until then, review
upstream decoder security changes and keep the malformed-input and query-string
compatibility regression tests passing.
