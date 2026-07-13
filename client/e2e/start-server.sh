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
cleanup() {
  rm -rf "$DIR"
}
trap cleanup EXIT

cd ../server

# Generate VAPID keypair into the fixture dir.
VAPID_PRIVATE_KEY_PATH="$DIR/vapid_private.pem" \
VAPID_PUBLIC_KEY_PATH="$DIR/vapid_public.pem" \
  /tmp/homecam-venv/bin/python -m app.scripts.gen_vapid >/dev/null

# Generate the worker credential fixture without exposing its value. Browser
# journeys deliberately do not receive it; they can therefore prove that the
# worker surface is not part of the authenticated UI/API surface.
umask 077
openssl rand -hex 32 >"$DIR/worker-auth.secret"

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
export HOMECAM_WORKER_AUTH_FILE="$DIR/worker-auth.secret"
export HOMECAM_WORKER_AUTH_TRUSTED_CALLERS="127.0.0.1,::1"

mkdir -p "$SNAPSHOTS_DIR" "$RECORDINGS_DIR" "$TIMELAPSES_DIR" \
  "$BACKUP_TARGET_DIR" "$OTA_ARTIFACTS_DIR" "$OTA_STAGING_ROOT" \
  "$OTA_CLIENT_DIST_TARGET"

/tmp/homecam-venv/bin/python -m uvicorn app.main:app \
  --host 127.0.0.1 --port 8000 --log-level warning &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' HUP INT TERM
# The server retains only the in-memory credential after lifespan startup.
# Remove the fixture file as soon as health proves startup completed, because
# Playwright may hard-kill its webServer process without allowing EXIT traps.
for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS http://127.0.0.1:8000/healthz >/dev/null 2>&1; then
    rm -f "$DIR/worker-auth.secret"
    break
  fi
  sleep 0.25
done
wait "$SERVER_PID"
