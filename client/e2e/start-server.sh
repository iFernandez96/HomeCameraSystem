#!/bin/sh
# iter-245: Spin up a clean FastAPI server for the Playwright E2E suite.
#
# Lives in `client/e2e/` so it can be invoked from Playwright's
# webServer config (Playwright runs from `client/`). Starts uvicorn
# from `../server/` with:
#   - HOMECAM_SIMULATOR=1 — no real camera; fake detection events
#     stream so Live tab tests can assert WS event flow.
#   - Temp DB / VAPID paths under /tmp/homecam-e2e-XXX so each run
#     starts from a clean state and doesn't pollute dev `users.db`
#     or VAPID keys.
#   - Admin user seeded (admin / admin) via gen_admin's --hash-only
#     mode + the iter-179 env-seed bootstrap.
#
# Stays Python-3.11-on-host (the dev venv) — production uses the
# Docker container, but tests don't need the container layer.

set -e

DIR="$(mktemp -d /tmp/homecam-e2e-XXXXXX)"
echo "[e2e] fixture dir: $DIR" >&2

cd ../server

# Generate VAPID keypair into the fixture dir.
VAPID_PRIVATE_KEY_PATH="$DIR/vapid_private.pem" \
VAPID_PUBLIC_KEY_PATH="$DIR/vapid_public.pem" \
  /tmp/homecam-venv/bin/python -m app.scripts.gen_vapid >/dev/null

# Generate argon2 hash for "admin" via the gen_admin --hash-only
# path. Pipes the password twice on stdin to satisfy getpass's
# confirmation prompt.
ADMIN_HASH=$(printf "admin\nadmin\n" | \
  /tmp/homecam-venv/bin/python -m app.scripts.gen_admin admin --hash-only \
  2>/dev/null | tail -1)

if [ -z "$ADMIN_HASH" ]; then
  echo "[e2e] failed to generate admin hash" >&2
  exit 1
fi

# Hand-off env vars to uvicorn. Server boots, env-seed bootstrap
# inserts the admin user with the generated hash, then accepts
# requests on :8000.
export HOMECAM_SIMULATOR=1
export VAPID_PRIVATE_KEY_PATH="$DIR/vapid_private.pem"
export VAPID_PUBLIC_KEY_PATH="$DIR/vapid_public.pem"
export PUSH_SUBS_PATH="$DIR/push_subs.json"
export DETECTION_CONFIG_PATH="$DIR/detection_config.json"
export USERS_DB_PATH="$DIR/users.db"
export JWT_SECRET_PATH="$DIR/jwt_secret.bin"
export EVENTS_DB_PATH="$DIR/events.db"
export AUDIT_DB_PATH="$DIR/audit.db"
export SESSIONS_DB_PATH="$DIR/sessions.db"
export HOST_ACTION_STATE_PATH="$DIR/host_action.json"
export SNAPSHOTS_DIR="$DIR/snapshots"
export RECORDINGS_DIR="$DIR/recordings"
export TIMELAPSES_DIR="$DIR/timelapses"
export BACKUP_TARGET_DIR="$DIR/backups"
export BACKUP_LEDGER_PATH="$DIR/backup-ledger.jsonl"
export OTA_ROOT="$DIR/dist-ota"
export OTA_MANIFEST_PATH="$DIR/dist-ota/update-manifest.json"
export OTA_ARTIFACTS_DIR="$DIR/dist-ota/artifacts"
export OTA_STAGING_ROOT="$DIR/dist-ota/staging"
export OTA_ACTIVE_POINTER="$DIR/dist-ota/active-version"
export OTA_LEDGER_PATH="$DIR/dist-ota/ota-ledger.jsonl"
export OTA_CLIENT_DIST_TARGET="$DIR/client-dist"
export COOKIE_SECURE=false
export HOMECAM_ADMIN_USER=admin
export HOMECAM_ADMIN_PASSWORD_HASH="$ADMIN_HASH"

mkdir -p "$SNAPSHOTS_DIR" "$RECORDINGS_DIR" "$TIMELAPSES_DIR" \
  "$BACKUP_TARGET_DIR" "$OTA_ARTIFACTS_DIR" "$OTA_STAGING_ROOT" \
  "$OTA_CLIENT_DIST_TARGET"

exec /tmp/homecam-venv/bin/python -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8000 --log-level warning
