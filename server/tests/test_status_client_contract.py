"""Pin /api/status response keys against client TS `ServerStatus` type.

iter-173: closes the third side of the wire-boundary contract triangle
(Charter Risk #1, iter-169 audit's QA Manager F1). Pre-iter-173:

- `server/tests/test_status.py:73-102` (`test_status_response_has_
  exact_documented_field_set`) locks the server-emitted keys to a
  literal Python set.
- `client/src/lib/types.ts::ServerStatus` declares the client-side
  type for the same response.
- Nothing cross-checks the two sides.

A future iter could add or remove a key on the server without
touching the client TS (or vice versa), leaving `ServerStatus` a lie.
The runtime cost is silent: TS would type-check fine because the
server response is `Record<string, unknown>` to the client until
narrowed; mismatches would only surface as `undefined` reads at
render time.

This test mirrors the iter-110 `test_env_example_contract.py` pattern
(env vars in `config.py` ↔ documented in `.env.example`) for the
status payload. Mirrors iter-156's `test_worker_snapshot_keys_match_
whitelist` for the worker-side heartbeat triangle.

If this test fires:
    Either add/remove the key on whichever side is missing, OR if the
    discrepancy is deliberate (e.g., server emits something the
    client deliberately ignores), add it to `_CLIENT_ONLY_KEYS` /
    `_SERVER_ONLY_KEYS` below WITH a justification comment.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient


# Repo root: server/tests/test_status_client_contract.py → up 3 = repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_CLIENT_TYPES = _REPO_ROOT / "client" / "src" / "lib" / "types.ts"


# Keys allowed to diverge between the two sides. Keep TIGHT — every
# entry is a documented contract violation that the next reader needs
# to understand. Default empty.
_CLIENT_ONLY_KEYS: set[str] = set()
_SERVER_ONLY_KEYS: set[str] = set()


def _extract_server_status_keys() -> set[str]:
    """Walk `client/src/lib/types.ts` for the `export type ServerStatus
    = {...}` block and pull identifier-prefixed property lines.

    Line-based extraction (not a balanced-brace parser): scan for the
    opening `export type ServerStatus = {` line, then collect every
    `name:` or `name?:` line until a line that is just `}`. Tolerates
    inline JSDoc comments, blank lines, and union-typed fields. Does
    NOT tolerate nested object types inside `ServerStatus` (none today;
    if added, this parser needs upgrading to brace-counting — the test
    would fail loudly first).
    """
    text = _CLIENT_TYPES.read_text()
    keys: set[str] = set()
    in_block = False
    for line in text.splitlines():
        stripped = line.strip()
        if not in_block:
            if re.match(r"^export\s+type\s+ServerStatus\s*=\s*\{", stripped):
                in_block = True
            continue
        # Inside the ServerStatus body. End on a bare `}`.
        if stripped == "}":
            break
        # Skip JSDoc comment lines and blanks.
        if not stripped or stripped.startswith(("//", "/*", "*")):
            continue
        # Match `name:` or `name?:` at line start.
        m = re.match(r"^([a-z_][a-z0-9_]*)\??:", stripped)
        if m:
            keys.add(m.group(1))
    return keys


def test_server_status_keys_match_client_typescript(client: TestClient):
    """Symmetric set equality between `/api/status` response keys and
    `client/src/lib/types.ts::ServerStatus` declared fields.

    iter-173 (Charter Risk #1): the third side of the contract triangle
    that iter-156 / iter-110 established for heartbeat metrics and
    config env vars. Closes the wire-boundary drift gap surfaced as
    QA F1 in the iter-169 audit synthesis.
    """
    server_keys = set(client.get("/api/status").json().keys())
    client_keys = _extract_server_status_keys()

    extra_on_server = server_keys - client_keys - _CLIENT_ONLY_KEYS
    extra_on_client = client_keys - server_keys - _SERVER_ONLY_KEYS

    assert not extra_on_server, (
        "`/api/status` emits keys not declared in client TS "
        "`ServerStatus`: {}.\n"
        "Either add them to `client/src/lib/types.ts::ServerStatus`, "
        "OR remove from `app/main.py::status()` handler, OR add to "
        "`_CLIENT_ONLY_KEYS` here with a justification comment.".format(
            sorted(extra_on_server)
        )
    )

    assert not extra_on_client, (
        "client TS `ServerStatus` declares keys `/api/status` doesn't "
        "emit: {}.\n"
        "Either remove from `client/src/lib/types.ts`, OR emit from "
        "`app/main.py::status()` handler, OR add to `_SERVER_ONLY_KEYS` "
        "here with a justification comment.".format(
            sorted(extra_on_client)
        )
    )


def test_extract_server_status_keys_finds_canonical_fields():
    """Sanity check on the regex parser: a future `ServerStatus`
    refactor (extract fields into a helper type, change indentation
    style, reformat with prettier) could silently break the
    line-based extraction. Pin a few canonical keys to catch this.
    """
    keys = _extract_server_status_keys()
    # `ok` is always the first field. If missing, the parser didn't
    # enter the block.
    assert "ok" in keys, (
        "Parser didn't find `ok` in `ServerStatus` body — "
        "the `export type ServerStatus = {` line may have been "
        "reformatted (e.g., split across multiple lines)."
    )
    # `memory_total_mb` is mid-block. If missing, the parser broke
    # somewhere before the end.
    assert "memory_total_mb" in keys, (
        "Parser didn't reach the mid-block fields — likely a "
        "JSDoc comment or union-type line is being misinterpreted "
        "as the closing brace."
    )
    # `push_subs_count` is the last field today. If missing, the
    # parser bailed early.
    assert "push_subs_count" in keys, (
        "Parser didn't reach the last field — likely an embedded "
        "`}` (unlikely) or the closing brace logic is wrong."
    )
