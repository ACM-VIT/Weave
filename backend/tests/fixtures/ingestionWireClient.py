"""Actual Python client -> registered Express ingestion router wire acceptance.

All records are synthetic, isolated from product storage. The Node harness replaces
only persistence and checks parser/auth/controller behavior over loopback HTTP.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import urlparse

import requests

origin, ml_root = sys.argv[1:]
assert urlparse(origin).hostname == "127.0.0.1"
assert Path(ml_root).is_absolute()
sys.path.insert(0, str(Path(ml_root).resolve()))
import acquisition.backend_client as transport

LIMIT = 8 * 1024 * 1024
assert transport.MAX_BODY_BYTES == LIMIT and transport.MAX_RECORDS == 100
HEADERS = {"content-type": "application/json", "x-internal-secret": "ingestion-wire-contract-secret"}


def source(index: int, readme: str | None = None):
    name = f"wire-fixture/repo-{index}"
    return SimpleNamespace(payload={
        "full_name": name, "github_id": str(index + 1), "github_node_id": f"R_wire_{index}", "owner_github_id": "800000",
        "html_url": f"https://github.com/{name}", "description": "Synthetic transport fixture",
        "observed_at": "2026-10-23T00:00:00Z", "languages": ["Python", "Rust"], "primary_language": "Rust", "topics": ["transport"],
        "language_breakdown": [{"name": "Python", "color": "#3572A5", "size": 300, "percentage": 30},
                               {"name": "Rust", "color": None, "size": 200, "percentage": 20}],
        "language_total_size": 1000, "language_breakdown_complete": False,
    }, raw_repository={}, warnings=[], readme=SimpleNamespace(
        raw_markdown=readme if readme is not None else '# Fixture\n\n![Preview](images/demo.png)\n\n```sh\nprintf "界é"\n```\n',
        source_path="docs/README.md", default_branch="main",
        base_url=f"https://raw.githubusercontent.com/{name}/refs/heads/main/docs/",
    ))


def encoded(sources):
    return json.dumps({"repositories": [transport.repository_upsert_record(item) for item in sources]},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def exact_sources(size):
    items = [source(index) for index in range(4)]
    # Fill with three-byte BMP characters; each record stays below one million
    # JS UTF-16 units as well as Python code points. Length-digit growth is
    # accounted for by recomputing the real production encoding before top-up.
    for item in items:
        remaining = size - len(encoded(items)) - 20
        item.readme.raw_markdown += "界" * min(850_000, max(0, remaining // 3))
    while len(encoded(items)) < size:
        gap = size - len(encoded(items))
        items[-1].readme.raw_markdown += "x" * gap
    assert len(encoded(items)) == size
    assert all(len(item.readme.raw_markdown) <= 1_000_000 for item in items)
    return items


class ObservedSession(requests.Session):
    def __init__(self):
        super().__init__()
        self.trust_env = False
        self.sent = []

    def send(self, request, **kwargs):
        assert urlparse(request.url).hostname == "127.0.0.1"
        if request.method == "POST":
            self.sent.append(request.body.encode("utf-8") if isinstance(request.body, str) else bytes(request.body))
        return super().send(request, **kwargs)


session = ObservedSession()
client = transport.BackendIngestionClient(base_url=origin, internal_secret=HEADERS["x-internal-secret"],
                                          session=session, timeout=10, max_retries=3)


def stats():
    response = session.get(origin + "/wire-test-stats", timeout=10)
    response.raise_for_status()
    return response.json()


def expected_records(items):
    # Expectations are independent of the production conversion under test.
    return [{"github_id": item.payload["github_id"],
             **{key: item.payload[key] for key in ("languages", "primary_language", "language_breakdown", "language_total_size", "language_breakdown_complete")},
             "readme_hash": hashlib.sha256(item.readme.raw_markdown.encode()).hexdigest(),
             "readme_source_path": item.readme.source_path,
             "readme_default_branch": item.readme.default_branch,
             "readme_base_url": item.readme.base_url} for item in items]


def assert_received(items, accepted_before):
    received = [item for batch in stats()["accepted"][accepted_before:] for item in batch]
    assert received == expected_records(items), "batch lost, repeated, reordered or changed source records"


def send_and_check(items, expected_sizes):
    before = len(session.sent)
    accepted_before = len(stats()["accepted"])
    result = client.upsert_repositories_detailed(items)
    assert not result.failed, result.failed
    assert result.count == len(items)
    bodies = session.sent[before:]
    assert [len(body) for body in bodies] == expected_sizes
    actual = [item for batch in stats()["accepted"][accepted_before:] for item in batch]
    assert actual == expected_records(items), "canonical Markdown/media provenance changed across HTTP"


for size in (LIMIT - 1, LIMIT):
    send_and_check(exact_sources(size), [size])

above = encoded(exact_sources(LIMIT + 1))
before = stats()
response = session.post(origin + "/api/internal/v2/ingestion/repositories/upsert", data=above, headers=HEADERS, timeout=10)
assert response.status_code == 413 and "8 MiB" in response.json()["error"]
assert stats()["accepted"] == before["accepted"], "oversize reached persistence"
attempts_before = len(session.sent)
try:
    client._post_encoded("/api/internal/v2/ingestion/repositories/upsert", above)
    raise AssertionError("oversize passed production preflight")
except ValueError as error:
    assert "8 MiB" in str(error)
assert len(session.sent) == attempts_before, "oversize preflight made an HTTP request"

# Exercise HTTP 413 handling separately from the normal preflight rejection.
# Lift only the local preflight ceiling by one byte so the real production
# Express parser returns 413; the production limit itself is never changed.
transport.MAX_BODY_BYTES = LIMIT + 1
attempts_before = len(session.sent)
try:
    try:
        client._post_encoded("/api/internal/v2/ingestion/repositories/upsert", above)
        raise AssertionError("413 was accepted")
    except RuntimeError as error:
        assert "413" in str(error)
finally:
    transport.MAX_BODY_BYTES = LIMIT
assert len(session.sent) - attempts_before == 1

items = exact_sources(LIMIT + 1)
offset = len(session.sent)
accepted_before = len(stats()["accepted"])
result = client.upsert_repositories_detailed(items)
assert result.count == len(items) and not result.failed
assert len(session.sent) - offset == 2
assert all(len(body) <= LIMIT for body in session.sent[offset:])
assert_received(items, accepted_before)

for count in (100, 101):
    items = [source(index + 100) for index in range(count)]
    offset = len(session.sent)
    accepted_before = len(stats()["accepted"])
    result = client.upsert_repositories_detailed(items)
    assert result.count == count and not result.failed
    assert [len(json.loads(body)["repositories"]) for body in session.sent[offset:]] == ([100] if count == 100 else [100, 1])
    assert_received(items, accepted_before)
before = stats()
response = session.post(origin + "/api/internal/v2/ingestion/repositories/upsert", data=encoded(items), headers=HEADERS, timeout=10)
assert response.status_code == 400 and "1-100" in response.json()["error"]
assert stats()["accepted"] == before["accepted"]

offset = len(session.sent)
bad, good = source(500, "界" * (LIMIT // 3 + 1)), source(501)
accepted_before = len(stats()["accepted"])
result = client.upsert_repositories_detailed([bad, good])
assert result.succeeded == [good.payload["full_name"]]
assert "8 MiB" in result.failed[bad.payload["full_name"]]
assert len(session.sent) - offset == 1
assert_received([good], accepted_before)

before = stats()
response = session.post(origin + "/api/internal/v2/ingestion/repositories/upsert", data=above,
                        headers={"content-type": "application/json"}, timeout=10)
assert response.status_code == 401, "auth must precede the 8 MiB parser"
response = session.post(origin + "/api/v2/wire-test", data=json.dumps({"padding": "x" * 300_000}), headers=HEADERS, timeout=10)
assert response.status_code == 413 and "256 KB" in response.json()["error"]
assert stats()["accepted"] == before["accepted"]
observed = next(record for batch in stats()["accepted"] for record in batch if record["github_id"] == "1")
assert observed["languages"] == ["Python", "Rust"] and observed["primary_language"] == "Rust"
assert observed["language_breakdown"] == source(0).payload["language_breakdown"]
assert observed["language_total_size"] == 1000 and observed["language_breakdown_complete"] is False
session.close()
print(json.dumps({"byte_boundaries": [LIMIT - 1, LIMIT, LIMIT + 1], "record_boundaries": [100, 101],
                  "non_retryable_413_attempts": 1, "oversized_record_isolated": True}))
