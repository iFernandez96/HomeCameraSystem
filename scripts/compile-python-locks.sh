#!/usr/bin/env bash
# Rebuild the Python 3.11/3.12 compatible, platform-universal hash locks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UV_VERSION="0.11.7"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv $UV_VERSION is required to compile Python locks" >&2
  exit 1
fi
if [[ "$(uv --version)" != "uv $UV_VERSION "* ]]; then
  echo "expected uv $UV_VERSION; found $(uv --version)" >&2
  exit 1
fi

common=(--generate-hashes --universal --python-version 3.11 --no-header)
uv pip compile "${common[@]}" \
  "$ROOT/server/requirements.in" \
  -o "$ROOT/server/requirements.txt"
uv pip compile "${common[@]}" \
  "$ROOT/server/requirements-dev.in" \
  -o "$ROOT/server/requirements-dev.txt"
