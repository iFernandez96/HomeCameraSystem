#!/usr/bin/env bash
# Stable fingerprint of the committed revision plus every current source change.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/source-fingerprint.sh [--require-clean]

Print a stable fingerprint for the current source. With --require-clean, fail
before printing a fingerprint unless tracked and untracked source are clean.
EOF
}

REQUIRE_CLEAN=0
case "${1:-}" in
  "") ;;
  --require-clean) REQUIRE_CLEAN=1 ;;
  -h|--help) usage; exit 0 ;;
  *) echo "ERROR: unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

[[ $# -le 1 ]] || {
  echo "ERROR: too many arguments" >&2
  usage >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git rev-parse --verify HEAD >/dev/null 2>&1 || {
  echo "ERROR: source fingerprint requires a Git revision" >&2
  exit 1
}

if ((REQUIRE_CLEAN)) &&
  [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "ERROR: release source is dirty; commit or remove every tracked and untracked change" >&2
  exit 1
fi

{
  git rev-parse HEAD
  git diff --binary --no-ext-diff HEAD -- . ':(exclude)client/dist' ':(exclude)**/build'
  while IFS= read -r -d '' path; do
    printf 'untracked:%s\n' "$path"
    sha256sum -- "$path"
  done < <(git ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
} | sha256sum | awk '{print substr($1, 1, 16)}'
