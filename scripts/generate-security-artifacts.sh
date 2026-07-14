#!/usr/bin/env bash
# Build the production ARM64 server artifact and retain its SBOM/scan evidence.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

readonly TRIVY_IMAGE="aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e"
readonly TARGET_PLATFORM="linux/arm64"
OUT_DIR="${1:-$ROOT/security-artifacts}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
cache_dir=$(mktemp -d "${TMPDIR:-/tmp}/homecam-trivy-cache.XXXXXX")
trap 'rm -rf "$cache_dir"' EXIT HUP INT TERM

source_sha=$(git rev-parse --verify HEAD)
source_fingerprint=$(bash scripts/source-fingerprint.sh)
short_sha=${source_sha:0:12}
artifact_name="homecam-server-${short_sha}-linux-arm64"
image_archive="$OUT_DIR/${artifact_name}.docker.tar"
metadata="$OUT_DIR/${artifact_name}.build-metadata.json"
sbom="$OUT_DIR/${artifact_name}.cdx.json"
image_scan="$OUT_DIR/${artifact_name}.vulnerabilities.json"
source_scan="$OUT_DIR/source-${short_sha}.vulnerabilities-and-secrets.json"
identity="$OUT_DIR/${artifact_name}.identity.json"

rm -f "$image_archive" "$metadata" "$sbom" "$image_scan" "$source_scan" "$identity"

docker buildx build \
    --platform "$TARGET_PLATFORM" \
    --file deploy/Dockerfile.server \
    --tag "homecam-server:${short_sha}" \
    --provenance=false \
    --metadata-file "$metadata" \
    --output "type=docker,dest=$image_archive" \
    .

artifact_sha256=$(sha256sum "$image_archive" | awk '{print $1}')
dirty=false
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    dirty=true
fi

python3 - "$metadata" "$identity" "$source_sha" "$source_fingerprint" \
    "$TARGET_PLATFORM" "$artifact_name" "$artifact_sha256" "$dirty" <<'PY'
import json
import sys

metadata_path, identity_path, source_sha, source_fingerprint, platform, artifact_name, artifact_sha256, dirty = sys.argv[1:]
with open(metadata_path, encoding="utf-8") as handle:
    metadata = json.load(handle)
identity = {
    "schema_version": 1,
    "artifact": artifact_name,
    "artifact_sha256": artifact_sha256,
    "container_digest": metadata.get("containerimage.digest"),
    "dirty": dirty == "true",
    "platform": platform,
    "source_fingerprint": source_fingerprint,
    "source_sha": source_sha,
}
if not identity["container_digest"]:
    raise SystemExit("build metadata did not contain containerimage.digest")
with open(identity_path, "w", encoding="utf-8") as handle:
    json.dump(identity, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

trivy() {
    docker run --rm \
        --user "$(id -u):$(id -g)" \
        -v "$OUT_DIR:/artifacts" \
        -v "$cache_dir:/cache" \
        "$TRIVY_IMAGE" --cache-dir /cache "$@"
}

trivy image --input "/artifacts/$(basename "$image_archive")" \
    --format cyclonedx --output "/artifacts/$(basename "$sbom")" \
    --skip-version-check

scan_status=0
trivy image --input "/artifacts/$(basename "$image_archive")" \
    --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --format json --output "/artifacts/$(basename "$image_scan")" \
    --skip-version-check || scan_status=$?

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT:/workspace:ro" \
    -v "$OUT_DIR:/artifacts" \
    -v "$cache_dir:/cache" \
    "$TRIVY_IMAGE" --cache-dir /cache fs /workspace \
    --scanners vuln,secret --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
    --skip-dirs /workspace/.git \
    --skip-dirs /workspace/.jetson-snapshot \
    --skip-dirs /workspace/security-artifacts \
    --format json --output "/artifacts/$(basename "$source_scan")" \
    --skip-version-check || scan_status=$?

if [ "${KEEP_IMAGE_TAR:-0}" != "1" ]; then
    rm -f "$image_archive"
fi

printf 'Security evidence: %s\n' "$OUT_DIR"
exit "$scan_status"
