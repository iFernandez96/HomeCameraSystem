#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT=$(mktemp -d /tmp/homecam-pr301-test.XXXXXX)
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

# A valid download is installed atomically.
printf 'verified artifact\n' >"$TMP_ROOT/origin"
expected_sha256=$(sha256sum "$TMP_ROOT/origin" | awk '{print $1}')
bash "$ROOT/deploy/download-verified.sh" \
    "file://$TMP_ROOT/origin" "$expected_sha256" "$TMP_ROOT/destination"
cmp "$TMP_ROOT/origin" "$TMP_ROOT/destination"

# A tampered replacement fails closed and preserves the last verified bytes.
printf 'tampered artifact\n' >"$TMP_ROOT/origin"
if bash "$ROOT/deploy/download-verified.sh" \
    "file://$TMP_ROOT/origin" "$expected_sha256" "$TMP_ROOT/destination" \
    >"$TMP_ROOT/tamper.stdout" 2>"$TMP_ROOT/tamper.stderr"; then
    echo "tampered artifact unexpectedly passed SHA-256 verification" >&2
    exit 1
fi
grep -Fq "SHA-256 verification failed" "$TMP_ROOT/tamper.stderr"
printf 'verified artifact\n' | cmp - "$TMP_ROOT/destination"

python3 - "$ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])

for workflow in sorted((root / ".github/workflows").glob("*.yml")):
    text = workflow.read_text(encoding="utf-8")
    refs = re.findall(r"^\s*- uses:\s*([^\s#]+)", text, re.MULTILINE)
    assert refs, "no action refs found in {}".format(workflow)
    for ref in refs:
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", ref), \
            "mutable GitHub Action ref in {}: {}".format(workflow, ref)

for lock_name in ("requirements.txt", "requirements-dev.txt"):
    path = root / "server" / lock_name
    lines = path.read_text(encoding="utf-8").splitlines()
    starts = [index for index, line in enumerate(lines)
              if line and not line[0].isspace() and not line.startswith("#")]
    assert starts, "empty dependency lock: {}".format(path)
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        requirement = lines[start]
        block = "\n".join(lines[start:end])
        assert "==" in requirement, "unpinned dependency in {}: {}".format(path, requirement)
        assert "--hash=sha256:" in block, "unhashed dependency in {}: {}".format(path, requirement)

dockerfile = (root / "deploy/Dockerfile.server").read_text(encoding="utf-8")
assert re.search(r"^FROM python:3\.11\.15-slim-bookworm@sha256:[0-9a-f]{64}$", dockerfile, re.MULTILINE)
assert "pip install --no-cache-dir --prefer-binary --require-hashes" in dockerfile

installer = (root / "deploy/install-jetson.sh").read_text(encoding="utf-8")
assert "releases/latest" not in installer
for name in ("COMPOSE_SHA256", "MEDIAMTX_ARCHIVE_SHA256", "MEDIAMTX_BINARY_SHA256"):
    assert re.search(r'^readonly {}="[0-9a-f]{{64}}"$'.format(name), installer, re.MULTILINE)
assert "deploy/download-verified.sh" in installer

security = (root / "scripts/generate-security-artifacts.sh").read_text(encoding="utf-8")
assert re.search(r'aquasec/trivy@sha256:[0-9a-f]{64}', security)
for evidence in (".cdx.json", ".vulnerabilities.json", ".identity.json"):
    assert evidence in security
PY

echo "PR-301 supply-chain checks passed"
