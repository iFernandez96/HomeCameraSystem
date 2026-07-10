#!/usr/bin/env bash
# Build a laptop-side OTA artifact bundle for manual rsync shipment.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/build-ota-artifact.sh [--with-server-image] [--output-root DIR] [version]

Builds dist-ota/<version>/ by default. The version may be provided as the first
positional argument or via HOMECAM_VERSION.

Environment:
  HOMECAM_VERSION          Version when no positional version is provided.
  HOMECAM_OTA_OUTPUT_ROOT  Output root override, default: <repo>/dist-ota.
  HOMECAM_OTA_RSYNC_TARGET Target shown in the printed rsync command,
                           default: jetson:/home/israel/HomeCameraSystem/dist-ota/
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

WITH_SERVER_IMAGE=0
OUTPUT_ROOT="${HOMECAM_OTA_OUTPUT_ROOT:-}"
VERSION="${HOMECAM_VERSION:-}"

while (($#)); do
  case "$1" in
    --with-server-image)
      WITH_SERVER_IMAGE=1
      shift
      ;;
    --output-root)
      (($# >= 2)) || die "--output-root requires a directory"
      OUTPUT_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$VERSION" ]] || die "version provided more than once"
      VERSION="$1"
      shift
      ;;
  esac
done

[[ -n "${VERSION//[[:space:]]/}" ]] || die "version is required: pass arg1 or set HOMECAM_VERSION"
[[ "$VERSION" != */* ]] || die "version must not contain '/'"
[[ "$VERSION" != "." && "$VERSION" != ".." ]] || die "invalid version: $VERSION"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_DIST="$ROOT/client/dist"
DETECTION_DIR="$ROOT/detection"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT/dist-ota}"
OUT_DIR="$OUTPUT_ROOT/$VERSION"
PAYLOAD_NAME="homecam-ota-$VERSION"
PAYLOAD_DIR="$OUT_DIR/$PAYLOAD_NAME"
ARTIFACT_NAME="$PAYLOAD_NAME.tar.gz"
ARTIFACT_PATH="$OUT_DIR/$ARTIFACT_NAME"
MANIFEST_PATH="$OUT_DIR/manifest.json"
SERVER_IMAGE="homecam-server:latest"
SERVER_IMAGE_TAR="$PAYLOAD_DIR/server-image.tar"
RSYNC_TARGET="${HOMECAM_OTA_RSYNC_TARGET:-jetson:/home/israel/HomeCameraSystem/dist-ota/}"

require_command rsync
require_command sha256sum
require_command tar

[[ -d "$CLIENT_DIST" ]] || die "client/dist is missing. Run the client build before building the OTA artifact; this script does not run npm build."
[[ -d "$DETECTION_DIR" ]] || die "detection directory is missing: $DETECTION_DIR"

if ((WITH_SERVER_IMAGE)); then
  require_command docker
fi

rm -rf "$OUT_DIR"
mkdir -p "$PAYLOAD_DIR/client" "$PAYLOAD_DIR/detection"

rsync -rLt --delete --no-owner --no-group "$CLIENT_DIST/" "$PAYLOAD_DIR/client/dist/"
rsync -rLt --delete --no-owner --no-group \
  --exclude 'tests/' \
  --exclude '__pycache__/' \
  --exclude '.pytest_cache/' \
  "$DETECTION_DIR/" "$PAYLOAD_DIR/detection/"

if ((WITH_SERVER_IMAGE)); then
  echo "==> saving server image $SERVER_IMAGE"
  docker save "$SERVER_IMAGE" -o "$SERVER_IMAGE_TAR"
fi

echo "==> creating $ARTIFACT_PATH"
# Payload contents at the tar ROOT (client/, detection/) — the server-side
# stage/preflight contract (ota_stage + ota_layout, pinned by U17) expects
# them there, not under a version-named wrapper dir.
tar --dereference -C "$PAYLOAD_DIR" -czf "$ARTIFACT_PATH" client detection

SHA256="$(sha256sum "$ARTIFACT_PATH" | awk '{print $1}')"
SOURCE_FINGERPRINT="$("$ROOT/scripts/source-fingerprint.sh")"
SOURCE_DIRTY=false
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=normal)" ]]; then
  SOURCE_DIRTY=true
fi
ESCAPED_VERSION="$(json_escape "$VERSION")"
ESCAPED_ARTIFACT_NAME="$(json_escape "$ARTIFACT_NAME")"

cat >"$MANIFEST_PATH" <<EOF
{
  "version": "$ESCAPED_VERSION",
  "source": {
    "fingerprint": "$SOURCE_FINGERPRINT",
    "dirty": $SOURCE_DIRTY
  },
  "artifact": {
    "name": "$ESCAPED_ARTIFACT_NAME",
    "sha256": "$SHA256"
  }
}
EOF

echo "==> wrote $MANIFEST_PATH"
echo "==> artifact sha256 $SHA256"
echo "==> source fingerprint $SOURCE_FINGERPRINT (dirty=$SOURCE_DIRTY)"
echo
echo "To ship this artifact, run:"
printf 'rsync -av --delete %q %q\n' "$OUT_DIR/" "$RSYNC_TARGET$VERSION/"
