#!/bin/sh
# Container entrypoint: ensure VAPID keys exist before starting the server.
set -e

if [ ! -f "$VAPID_PRIVATE_KEY_PATH" ] || [ ! -f "$VAPID_PUBLIC_KEY_PATH" ]; then
    echo "[entrypoint] VAPID keys not found — generating into $(dirname "$VAPID_PRIVATE_KEY_PATH")"
    python -m app.scripts.gen_vapid
fi

exec "$@"
