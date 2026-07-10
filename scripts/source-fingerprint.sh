#!/usr/bin/env bash
# Stable fingerprint of the committed revision plus every current source change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

{
  git rev-parse HEAD
  git diff --binary --no-ext-diff HEAD -- . ':(exclude)client/dist' ':(exclude)**/build'
  while IFS= read -r -d '' path; do
    printf 'untracked:%s\n' "$path"
    sha256sum -- "$path"
  done < <(git ls-files --others --exclude-standard -z | LC_ALL=C sort -z)
} | sha256sum | awk '{print substr($1, 1, 16)}'
