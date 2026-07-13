#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
TMP_ROOT="$(mktemp -d /tmp/homecam-pr000-test.XXXXXX)"
REPO="$TMP_ROOT/repo"
OUTPUT_ROOT="$TMP_ROOT/output"
STDOUT_LOG="$TMP_ROOT/build.stdout"
STDERR_LOG="$TMP_ROOT/build.stderr"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p \
  "$REPO/client/dist" \
  "$REPO/deploy" \
  "$REPO/detection" \
  "$REPO/scripts"
cp "$ROOT/deploy/build-ota-artifact.sh" "$REPO/deploy/"
cp "$ROOT/scripts/source-fingerprint.sh" "$REPO/scripts/"
printf '%s\n' '<!doctype html><title>PR-000 fixture</title>' \
  >"$REPO/client/dist/index.html"
printf '%s\n' 'print("PR-000 fixture")' >"$REPO/detection/worker.py"

git -C "$REPO" init -q
git -C "$REPO" config user.name "HomeCam PR-000 test"
git -C "$REPO" config user.email "pr000-test@invalid.example"
git -C "$REPO" add .
git -C "$REPO" commit -qm "test: clean release fixture"

EXPECTED_SHA="$(git -C "$REPO" rev-parse HEAD)"
EXPECTED_FINGERPRINT="$(bash "$REPO/scripts/source-fingerprint.sh" --require-clean)"
CLEAN_VERSION="pr000-clean"
bash "$REPO/deploy/build-ota-artifact.sh" \
  --output-root "$OUTPUT_ROOT" \
  "$CLEAN_VERSION" >"$STDOUT_LOG" 2>"$STDERR_LOG"

MANIFEST="$OUTPUT_ROOT/$CLEAN_VERSION/manifest.json"
ARTIFACT="$OUTPUT_ROOT/$CLEAN_VERSION/homecam-ota-$CLEAN_VERSION.tar.gz"
"$PYTHON" - "$MANIFEST" "$ARTIFACT" "$EXPECTED_SHA" "$EXPECTED_FINGERPRINT" <<'PY'
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
artifact_path = pathlib.Path(sys.argv[2])
expected_sha = sys.argv[3]
expected_fingerprint = sys.argv[4]

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
assert manifest["source"] == {
    "git_sha": expected_sha,
    "fingerprint": expected_fingerprint,
    "dirty": False,
}
assert manifest["artifact"]["sha256"] == hashlib.sha256(
    artifact_path.read_bytes()
).hexdigest()
PY

[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=normal)" ]] \
  || { echo "clean fixture became dirty after release build" >&2; exit 1; }

DIRTY_VERSION="pr000-dirty"
DIRTY_OUT="$OUTPUT_ROOT/$DIRTY_VERSION"
mkdir -p "$DIRTY_OUT"
printf '%s\n' 'preserve-me' >"$DIRTY_OUT/sentinel"
printf '%s\n' '# tracked dirty source' >>"$REPO/detection/worker.py"
if bash "$REPO/deploy/build-ota-artifact.sh" \
  --output-root "$OUTPUT_ROOT" \
  "$DIRTY_VERSION" >"$STDOUT_LOG" 2>"$STDERR_LOG"; then
  echo "dirty tracked source unexpectedly produced a release artifact" >&2
  exit 1
fi
grep -Fq "release artifact requires a clean source worktree" "$STDERR_LOG"
[[ -f "$DIRTY_OUT/sentinel" ]] \
  || { echo "dirty-source rejection modified existing output" >&2; exit 1; }
[[ ! -e "$DIRTY_OUT/manifest.json" ]] \
  || { echo "dirty-source rejection wrote a manifest" >&2; exit 1; }
git -C "$REPO" restore detection/worker.py

printf '%s\n' 'untracked dirty source' >"$REPO/untracked.txt"
if bash "$REPO/scripts/source-fingerprint.sh" --require-clean \
  >"$STDOUT_LOG" 2>"$STDERR_LOG"; then
  echo "untracked source unexpectedly passed the clean-source gate" >&2
  exit 1
fi
grep -Fq "release source is dirty" "$STDERR_LOG"

echo "PR-000 release-source checks passed"
