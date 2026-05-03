"""Pin the symmetry between `app/config.py` os.getenv() calls and
`server/.env.example` KEY= lines.

Why this test exists:
    iter-110 found that `PUSH_SUBS_PATH` and `DETECTION_CONFIG_PATH` had
    been added to `config.py` (with sane defaults so things still worked)
    but never landed in `.env.example`. A developer overriding storage
    paths would have to read source. This test locks the contract so a
    future PR can't drift them apart again.

If this test fires:
    Either add the new env var to `.env.example` (with a sensible
    default + comment), OR — if it's a test-only / internal env var —
    add it to `INTERNAL_KEYS` below with a justification comment.
"""
from __future__ import annotations

import re
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parent.parent
_CONFIG_PY = _REPO_ROOT / "app" / "config.py"
_ENV_EXAMPLE = _REPO_ROOT / ".env.example"


# Env vars that intentionally don't appear in `.env.example` — typically
# test-only or rarely-touched. Keep this list tight so the contract stays
# honest.
_INTERNAL_KEYS: set[str] = set()


def _envvars_referenced_in_config() -> set[str]:
    text = _CONFIG_PY.read_text()
    return set(re.findall(r'os\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"', text))


def _envvars_documented_in_example() -> set[str]:
    keys: set[str] = set()
    for line in _ENV_EXAMPLE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Z_][A-Z0-9_]*)=", line)
        if m:
            keys.add(m.group(1))
    return keys


def test_env_example_covers_every_config_envvar():
    referenced = _envvars_referenced_in_config()
    documented = _envvars_documented_in_example()
    missing = referenced - documented - _INTERNAL_KEYS
    assert not missing, (
        f"config.py reads env vars not documented in .env.example: {sorted(missing)}.\n"
        "Either add them with a sensible default to server/.env.example, "
        "or, if internal, add them to _INTERNAL_KEYS in this test."
    )


def test_env_example_has_no_orphan_entries():
    """The reverse direction: any line in `.env.example` should
    correspond to an env var that `config.py` actually reads. Otherwise
    we accumulate dead documentation that confuses the next reader."""
    referenced = _envvars_referenced_in_config()
    documented = _envvars_documented_in_example()
    orphans = documented - referenced
    assert not orphans, (
        f".env.example documents env vars that config.py never reads: {sorted(orphans)}.\n"
        "Either remove them from server/.env.example, or, if used "
        "elsewhere (entrypoint.sh, Dockerfile.server), wire them through "
        "config.py and they'll satisfy this test."
    )
