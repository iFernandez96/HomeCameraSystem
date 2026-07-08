#!/usr/bin/env bash
# Pull a READ-ONLY snapshot of real production data off the Jetson for OFFLINE
# analysis — so "confirm with real data" never blocks on the Jetson being up.
#
# Principle (memory: feedback-dev-offline-when-jetson-off): the Jetson is often
# powered off. When a change needs validating against REAL data (events,
# clips, logs), DON'T block — run this whenever the Jetson is on, then analyze
# the snapshot locally afterward. The snapshot lives in ./.jetson-snapshot/
# (gitignored) and is the input for offline analysis + gated real-data tests.
#
# READ-ONLY on the Jetson: only SELECT/cat/journalctl/ls/scp-from. NEVER pulls
# secrets (jwt_secret, VAPID PEMs, push_subs.json device endpoints). The
# events.db is captured as a portable SQL dump via python's iterdump (no
# sqlite3 CLI needed in the container, and consistent against a live DB).
#
# Usage: deploy/fetch-jetson-data.sh [host] [clip_count] [log_days]
#   host        ssh host (default: jetson; use 'homecam' for Tailscale off-LAN)
#   clip_count  most-recent .mp4 clips to pull (default: 8; 0 = none)
#   log_days    journald lookback in days (default: 3)
set -euo pipefail

HOST="${1:-jetson}"
CLIP_COUNT="${2:-8}"
LOG_DAYS="${3:-3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.jetson-snapshot"
JETSON_ROOT="/home/israel/HomeCameraSystem"
REC_DIR="/home/israel/HomeCameraSystem/recordings"
DB_IN_CONTAINER="/app/secrets/events.db"
MEDIAMTX_YML="${JETSON_ROOT}/deploy/mediamtx.yml"
DETECTION_DIR="${JETSON_ROOT}/detection"

# --- preflight: don't hang if the box is off ------------------------------
if ! ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" true 2>/dev/null; then
  echo "ERROR: '$HOST' unreachable (Jetson off, or off-LAN)." >&2
  echo "  Power on the Jetson, then re-run. Off the home LAN, pass the" >&2
  echo "  Tailscale alias:  deploy/fetch-jetson-data.sh homecam" >&2
  exit 1
fi

mkdir -p "$OUT/db" "$OUT/clips" "$OUT/logs" "$OUT/config"

echo "==> events.db → SQL dump (consistent, secret-free)"
# python iterdump: no sqlite3 CLI needed in the container; safe on a live DB.
ssh "$HOST" "sudo docker exec homecam-server python3 -c \"import sqlite3,sys; con=sqlite3.connect('file:${DB_IN_CONTAINER}?mode=ro', uri=True); sys.stdout.write('\n'.join(con.iterdump()))\"" \
  > "$OUT/db/events.dump.sql"
echo "    $(wc -l < "$OUT/db/events.dump.sql") SQL lines"
# Rebuild a queryable local sqlite if the dev box has the CLI (optional).
if command -v sqlite3 >/dev/null 2>&1; then
  rm -f "$OUT/db/events.sqlite"
  sqlite3 "$OUT/db/events.sqlite" < "$OUT/db/events.dump.sql" \
    && echo "    rebuilt $OUT/db/events.sqlite"
else
  echo "    (no local sqlite3 CLI — load the .sql dump in python instead)"
fi

echo "==> recent clips (most-recent ${CLIP_COUNT} .mp4)"
if [ "${CLIP_COUNT}" -gt 0 ]; then
  # `ls -1t` newest-first; head bounds the size. -- guards odd names.
  mapfile -t FILES < <(ssh "$HOST" "ls -1t ${REC_DIR}/*.mp4 2>/dev/null | head -n ${CLIP_COUNT}") || true
  for f in "${FILES[@]:-}"; do
    [ -z "$f" ] && continue
    base="$(basename "$f")"
    if scp -q "$HOST:$f" "$OUT/clips/$base"; then echo "    $base"; fi
  done
fi

echo "==> journald (last ${LOG_DAYS}d)"
for unit in homecam-detect mediamtx homecam-server nvargus-daemon; do
  ssh "$HOST" "sudo journalctl -u ${unit} --since '-${LOG_DAYS} days' --no-pager 2>/dev/null" \
    > "$OUT/logs/${unit}.log" 2>/dev/null || true
done
ssh "$HOST" "sudo docker logs homecam-server --since $((LOG_DAYS * 24))h 2>&1" \
  > "$OUT/logs/homecam-server-app.log" 2>/dev/null || true
echo "==> docker json-file logs (active + rotated, fail-soft)"
LOG_PATH="$(ssh "$HOST" "sudo docker inspect --format '{{.LogPath}}' homecam-server 2>/dev/null" 2>/dev/null || true)"
if [ -n "$LOG_PATH" ]; then
  mapfile -t DOCKER_LOGS < <(ssh "$HOST" "ls -1 ${LOG_PATH}* 2>/dev/null" 2>/dev/null || true)
  for f in "${DOCKER_LOGS[@]:-}"; do
    [ -z "$f" ] && continue
    base="$(basename "$f")"
    if ssh "$HOST" "sudo cat '$f'" > "$OUT/logs/docker-${base}" 2>/dev/null; then
      echo "    docker-${base}"
    fi
  done
else
  echo "    WARN: docker LogPath unavailable; skipped rotated docker logs" >&2
fi

echo "==> config (no secrets)"
ssh "$HOST" "sudo docker exec homecam-server cat ${DB_IN_CONTAINER%/*}/detection_config.json 2>/dev/null" \
  > "$OUT/config/detection_config.json" 2>/dev/null || true
ssh "$HOST" "cat ${MEDIAMTX_YML} 2>/dev/null" \
  > "$OUT/config/mediamtx.yml" 2>/dev/null || true
ssh "$HOST" "cat ${REC_DIR}/.watchdog_state.json 2>/dev/null" \
  > "$OUT/config/watchdog_state.json" 2>/dev/null || true

echo "==> hardware profile (recent clip ffprobe, fail-soft)"
if ! ssh "$HOST" "REC_DIR='$REC_DIR' MEDIAMTX_YML='$MEDIAMTX_YML' python3 -" > "$OUT/hardware-profile.json" <<'PY'; then
import json
import os
import re
import subprocess
import sys
import time

rec_dir = os.environ["REC_DIR"]
mediamtx_yml = os.environ["MEDIAMTX_YML"]

def warn(msg):
    print("WARN: {}".format(msg), file=sys.stderr)

def run(args):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL).decode("utf-8", "replace")

try:
    clips = [
        os.path.join(rec_dir, name)
        for name in os.listdir(rec_dir)
        if name.endswith(".mp4") and os.path.isfile(os.path.join(rec_dir, name))
    ]
except OSError as exc:
    warn("cannot list recordings: {}".format(exc))
    sys.exit(2)

if not clips:
    warn("no .mp4 clips found; skipped hardware profile")
    sys.exit(2)

clip = max(clips, key=lambda path: os.path.getmtime(path))

try:
    stream_raw = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate",
        "-of", "json", clip,
    ])
except (OSError, subprocess.CalledProcessError) as exc:
    warn("ffprobe stream probe failed: {}".format(exc))
    sys.exit(2)

try:
    stream = json.loads(stream_raw).get("streams", [{}])[0]
except (ValueError, IndexError):
    stream = {}

gop_frames = None
try:
    frames_raw = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-read_intervals", "%+5", "-show_frames",
        "-show_entries", "frame=key_frame", "-of", "csv=p=0", clip,
    ])
    distances = []
    since_key = None
    for line in frames_raw.splitlines():
        value = line.split(",", 1)[0].strip()
        if value not in ("0", "1"):
            continue
        if value == "1":
            if since_key is not None:
                distances.append(since_key)
            since_key = 1
        elif since_key is not None:
            since_key += 1
    if distances:
        gop_frames = int(round(sum(distances) / float(len(distances))))
except (OSError, subprocess.CalledProcessError):
    pass

encoder_elements = []
try:
    with open(mediamtx_yml, "r") as fh:
        text = fh.read()
    encoder_elements = sorted(set(re.findall(r"\b(?:nv[a-z0-9]*enc|x264enc|openh264enc|v4l2h264enc|nvv4l2h264enc)\b", text)))
except OSError:
    pass

profile = {
    "v": 1,
    "measured_at": int(time.time()),
    "clip": clip,
    "codec": stream.get("codec_name"),
    "width": stream.get("width"),
    "height": stream.get("height"),
    "fps": stream.get("avg_frame_rate"),
    "gop_frames": gop_frames,
    "encoder_elements": encoder_elements,
}
json.dump(profile, sys.stdout, sort_keys=True)
sys.stdout.write("\n")
PY
  echo "    WARN: hardware profile unavailable; skipped" >&2
  rm -f "$OUT/hardware-profile.json"
else
  echo "    wrote hardware-profile.json"
fi

RUNNING_IMAGE_DIGEST="$(ssh "$HOST" "sudo docker inspect --format '{{.Image}}' homecam-server 2>/dev/null" 2>/dev/null || true)"
HOMECAM_VERSION="$(ssh "$HOST" "sudo docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' homecam-server 2>/dev/null | awk -F= '\$1==\"HOMECAM_VERSION\" {print substr(\$0, index(\$0,\"=\")+1); exit}'" 2>/dev/null || true)"
DETECTION_CONFIG_SHA256="$(ssh "$HOST" "sudo docker exec homecam-server sha256sum ${DB_IN_CONTAINER%/*}/detection_config.json 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
MEDIAMTX_YML_SHA256="$(ssh "$HOST" "sha256sum ${MEDIAMTX_YML} 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
DETECTION_TREE_NEWEST="$(ssh "$HOST" "find ${DETECTION_DIR} -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1" 2>/dev/null || true)"

{
  echo "host=$HOST"
  echo "fetched_unix=$(date -u +%s 2>/dev/null || echo 0)"
  echo "clips=${CLIP_COUNT} log_days=${LOG_DAYS}"
  echo "running_image_digest=${RUNNING_IMAGE_DIGEST}"
  echo "homecam_version=${HOMECAM_VERSION}"
  echo "detection_config_sha256=${DETECTION_CONFIG_SHA256}"
  echo "mediamtx_yml_sha256=${MEDIAMTX_YML_SHA256}"
  echo "detection_tree_newest=${DETECTION_TREE_NEWEST}"
} > "$OUT/SNAPSHOT_INFO"

# Drop empty files so absence is unambiguous to downstream tooling/tests.
find "$OUT" -type f -empty -delete 2>/dev/null || true

echo "==> done → $OUT (gitignored). Analyze offline; real-data tests skip until present."
