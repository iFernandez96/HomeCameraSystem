"""Pin two more sides of the wire-boundary contract triangle:

1. **WorkerMetrics** field-set: client `types.ts::WorkerMetrics`
   ↔ server `_internal.py::_ALLOWED_METRIC_FIELDS`. The
   worker→server side is already locked by
   `tests/test_internal.py::test_worker_snapshot_keys_match_whitelist`
   (iter-156). The client TS↔server allowlist side was unpinned —
   the iter-169 audit's QA Manager F10 finding.

2. **DETECTION_LIMITS** numeric bounds: client
   `types.ts::DETECTION_LIMITS` ↔ server `detection_config.py`
   THRESHOLD_MIN / THRESHOLD_MAX / COOLDOWN_MIN / COOLDOWN_MAX.
   Both sides hardcode the same numbers (0.05, 0.95, 0, 60); a
   future loosen-the-server-bounds change without touching the
   client would let the slider 422 on submit. iter-169 audit's
   QA Manager F11 finding.

iter-175 closes both with one file. Mirrors iter-173's
`test_status_client_contract.py` pattern.

If either test fires:
    Either update the side that drifted, OR if deliberate, add to
    `_CLIENT_ONLY_FIELDS` / `_SERVER_ONLY_FIELDS` (with comment) /
    accept a new pinned value in this test.
"""
from __future__ import annotations

import re
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_CLIENT_TYPES = _REPO_ROOT / "client" / "src" / "lib" / "types.ts"


# --- WorkerMetrics 3-way pin ------------------------------------------------

# Fields allowed to diverge between client TS and server allowlist.
# Default empty — every entry is a documented contract violation.
_CLIENT_ONLY_FIELDS: set[str] = set()
_SERVER_ONLY_FIELDS: set[str] = set()


def _extract_worker_metrics_keys() -> set[str]:
    """Walk `client/src/lib/types.ts` for the
    `export type WorkerMetrics = {...}` block and pull
    identifier-prefixed property lines. Same line-based extraction
    as iter-173's `_extract_server_status_keys`.
    """
    text = _CLIENT_TYPES.read_text()
    keys: set[str] = set()
    in_block = False
    for line in text.splitlines():
        stripped = line.strip()
        if not in_block:
            if re.match(r"^export\s+type\s+WorkerMetrics\s*=\s*\{", stripped):
                in_block = True
            continue
        if stripped == "}":
            break
        if not stripped or stripped.startswith(("//", "/*", "*")):
            continue
        m = re.match(r"^([a-z_][a-z0-9_]*)\??:", stripped)
        if m:
            keys.add(m.group(1))
    return keys


def test_worker_metrics_keys_match_server_allowlist():
    """iter-175 (Charter Risk #1, QA F10): symmetric set equality
    between client `WorkerMetrics` declared fields and the server
    `_ALLOWED_METRIC_FIELDS` allowlist. Closes the third side of
    the heartbeat metrics contract triangle (worker emits via
    `metrics.py::Metrics.snapshot()` ↔ server allows via
    `_ALLOWED_METRIC_FIELDS` ↔ client renders via TS shape).
    """
    from app.routes._internal import _ALLOWED_METRIC_FIELDS

    server_keys = set(_ALLOWED_METRIC_FIELDS)
    client_keys = _extract_worker_metrics_keys()

    extra_on_server = server_keys - client_keys - _CLIENT_ONLY_FIELDS
    extra_on_client = client_keys - server_keys - _SERVER_ONLY_FIELDS

    assert not extra_on_server, (
        "`_ALLOWED_METRIC_FIELDS` allows keys not declared in client "
        "TS `WorkerMetrics`: {}.\n"
        "Either add them to `client/src/lib/types.ts::WorkerMetrics`, "
        "OR remove from `server/app/routes/_internal.py::"
        "_ALLOWED_METRIC_FIELDS`, OR add to `_CLIENT_ONLY_FIELDS` "
        "with justification.".format(sorted(extra_on_server))
    )

    assert not extra_on_client, (
        "client TS `WorkerMetrics` declares keys the server "
        "allowlist rejects: {}.\n"
        "The server WILL drop these silently (per `_coerce_metric` "
        "filtering). Either remove from `client/src/lib/types.ts`, "
        "OR add to `_ALLOWED_METRIC_FIELDS` (and the worker side "
        "via `metrics.py::Metrics.snapshot`), OR add to "
        "`_SERVER_ONLY_FIELDS` with justification.".format(
            sorted(extra_on_client)
        )
    )


def test_extract_worker_metrics_keys_finds_canonical_fields():
    """Sanity check on the regex parser. Same shape as iter-173's
    sister test.
    """
    keys = _extract_worker_metrics_keys()
    # `fps` is the first field in WorkerMetrics; `face_recog_names`
    # is the last. If either is missing, the parser broke.
    assert "fps" in keys, (
        "Parser didn't find `fps` in `WorkerMetrics` body — the "
        "`export type WorkerMetrics = {` line may have been "
        "reformatted (e.g. split across multiple lines)."
    )
    assert "face_recog_names" in keys, (
        "Parser didn't reach the last field `face_recog_names` — "
        "likely a JSDoc comment or union-type line is being "
        "misinterpreted as the closing brace."
    )


# --- DETECTION_LIMITS 3-way pin ---------------------------------------------


def _extract_detection_limits() -> dict[str, float]:
    """Walk `client/src/lib/types.ts` for the
    `export const DETECTION_LIMITS = { ... }` block and pull
    `name: number` pairs. Returns a dict camelCase→float.
    """
    text = _CLIENT_TYPES.read_text()
    pairs: dict[str, float] = {}
    in_block = False
    for line in text.splitlines():
        stripped = line.strip()
        if not in_block:
            if re.match(r"^export\s+const\s+DETECTION_LIMITS\s*=\s*\{", stripped):
                in_block = True
            continue
        # End-of-block marker is `} as const` or just `}`.
        if stripped.startswith("}"):
            break
        if not stripped or stripped.startswith(("//", "/*", "*")):
            continue
        # Match `name: <number>,` with optional trailing comma and
        # optional inline `// comment` (iter-257 added explanatory
        # comments after the value).
        m = re.match(
            r"^([a-z][a-zA-Z0-9_]*):\s*(-?\d+(?:\.\d+)?),?\s*(?://.*)?$",
            stripped,
        )
        if m:
            pairs[m.group(1)] = float(m.group(2))
    return pairs


def test_detection_limits_match_server_bounds():
    """iter-175 (Charter Risk #1, QA F11): the client slider
    `DETECTION_LIMITS` and the server's
    `THRESHOLD_MIN/MAX/COOLDOWN_MIN/MAX` bounds must agree. Either
    side loosened or tightened in isolation produces a slider that
    422s on submit (or rejects user input that the server would
    accept).
    """
    from app.services.detection_config import (
        CLIP_POST_ROLL_MAX,
        CLIP_POST_ROLL_MIN,
        CLIP_PRE_ROLL_MAX,
        CLIP_PRE_ROLL_MIN,
        COOLDOWN_MAX,
        COOLDOWN_MIN,
        THRESHOLD_MAX,
        THRESHOLD_MIN,
    )

    client = _extract_detection_limits()

    expected_pairs = (
        ("thresholdMin", THRESHOLD_MIN),
        ("thresholdMax", THRESHOLD_MAX),
        ("cooldownMin", COOLDOWN_MIN),
        ("cooldownMax", COOLDOWN_MAX),
        # iter-254 + iter-256: per-event clip duration bounds.
        ("clipPostRollMin", CLIP_POST_ROLL_MIN),
        ("clipPostRollMax", CLIP_POST_ROLL_MAX),
        ("clipPreRollMin", CLIP_PRE_ROLL_MIN),
        ("clipPreRollMax", CLIP_PRE_ROLL_MAX),
    )

    for camel_name, server_value in expected_pairs:
        assert camel_name in client, (
            "client `DETECTION_LIMITS` is missing `{}`. The server "
            "side has it as the matching constant.".format(camel_name)
        )
        # Use float equality with a small tolerance — these are
        # configured values, not floating-point computations, so
        # exact equality is the right check.
        assert client[camel_name] == server_value, (
            "client `DETECTION_LIMITS.{} = {}` != server "
            "constant ({}). Both sides hardcode the same number; "
            "if the server bound changed, update the client.".format(
                camel_name, client[camel_name], server_value
            )
        )

    # Symmetric: client should not have extras the server doesn't
    # know about (would imply a slider that bounds something the
    # server doesn't validate).
    extras = set(client) - {name for name, _ in expected_pairs}
    assert not extras, (
        "client `DETECTION_LIMITS` declares keys with no matching "
        "server constant: {}. Either drop them, OR add the matching "
        "server constant + bound check.".format(sorted(extras))
    )


def test_extract_detection_limits_finds_all_keys():
    """Sanity check that the parser reads all documented keys.
    iter-254 added the four clipPost/clipPre roll limits to the same
    block."""
    pairs = _extract_detection_limits()
    expected = {
        "thresholdMin",
        "thresholdMax",
        "cooldownMin",
        "cooldownMax",
        "clipPostRollMin",
        "clipPostRollMax",
        "clipPreRollMin",
        "clipPreRollMax",
    }
    assert set(pairs) == expected, (
        "Parser found {} but expected {}. The "
        "`export const DETECTION_LIMITS = {{}}` block in "
        "`client/src/lib/types.ts` may have been reformatted "
        "or had keys added/removed.".format(set(pairs), expected)
    )
