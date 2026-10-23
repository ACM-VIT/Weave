# Repository ingestion transport

`POST /api/internal/v2/ingestion/repositories/upsert` accepts **1–100 canonical
records** in `{"repositories":[...]}`. The complete UTF-8 JSON body, including its
envelope, commas and JSON escaping, must be at most **8,388,608 bytes (8 MiB)**.
The ML client sends identity-encoded JSON and computes this exact body before
delivery. Express also bounds the inflated body if a caller uses compression.
Canonical README text is independently limited to 1,000,000 JavaScript UTF-16
units per record; the body limit does not relax field validation.

The registered ingestion router authenticates the internal secret before its
8 MiB parser. Unrelated JSON routes and lookalike path prefixes retain their
256 KiB parser. An oversized body returns `413` with `Request payload exceeds
8 MiB.`; an invalid record/count returns `400`. Neither is a transient delivery
failure. The Python client splits at the byte or record boundary, rejects an
individually oversized record without dropping good peers, and does not retry
HTTP `413`. Retryable network/429/5xx failures retain the exact encoded batch.

## Reverse proxy compatibility

Ingress must permit the complete 8 MiB identity-encoded ingestion body. A smaller
proxy limit rejects otherwise valid batches before Express. Keep tighter defaults
for other routes. For an Nginx ingress, adapt these settings inside the existing
server configuration; `weave_backend` denotes its existing upstream:

```nginx
client_max_body_size 256k;
location /api/internal/v2/ingestion/ {
    client_max_body_size 8m;
    proxy_pass http://weave_backend;
}
```

Retain the deployment's TLS, network restrictions, authentication, timeouts and
forwarding configuration. This example is a configuration contract, not evidence
that a deployed proxy uses it. Other ingress products must enforce an equivalent
body bound. Headers are outside this JSON-body budget. Do not enable compression
to circumvent either the wire or inflated-body limit.

## Paired local acceptance

From `backend/`, with dependencies installed in both primary checkouts:

```bash
WEAVE_ML_INGESTION_ROOT="$(realpath ../../Weave-ml)" \
  npx --no-install tsx --test tests/http/ingestionWireContract.test.ts
```

The explicit absolute ML checkout supplies its `.venv/bin/python` and actual
`acquisition.backend_client`. The test opens a unique loopback Express listener
with the registered ingestion router, real middleware/controller validation and
a persistence stub. No database, model, GitHub, Redis or Qdrant is contacted.
Records are synthetic and are never stored in the product catalogue.

Coverage includes 8 MiB minus one/exact/plus one UTF-8 bytes, 100/101 records,
byte/count splitting, canonical Markdown and relative-media provenance hashes,
oversize rejection before persistence, preflight rejection, actual HTTP 413
without repeated delivery, isolated oversized records, authentication-first and
unchanged public body bounds. A dedicated CI workflow pins the compatible ML
source revision and installs only its two Python transport imports, without
downloading encoder/ranker dependencies. Default backend tests skip this paired
case when the explicit ML checkout is absent; CI enables it separately.

Passing this test proves the transport boundary. It does not establish SQL
durability, deployed ingress configuration, production throughput or rollout.
