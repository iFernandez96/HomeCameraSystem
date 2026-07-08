#!/usr/bin/env bash
# Enable bounded persistent journald storage on the Jetson.
set -euo pipefail

DROPIN_DIR="/etc/systemd/journald.conf.d"
DROPIN_FILE="${DROPIN_DIR}/homecam-persistent.conf"

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

storage_mode() {
  local mode

  mode="$(
    {
      if [ -d "$DROPIN_DIR" ]; then
        grep -hE '^[[:space:]]*Storage[[:space:]]*=' "$DROPIN_DIR"/*.conf 2>/dev/null
      fi
      grep -hE '^[[:space:]]*Storage[[:space:]]*=' /etc/systemd/journald.conf 2>/dev/null
    } | tail -n 1 | sed -E 's/^[[:space:]]*Storage[[:space:]]*=[[:space:]]*//' || true
  )"

  if [ -n "$mode" ]; then
    printf '%s\n' "$mode"
  else
    printf 'auto (default)\n'
  fi
}

echo "journald Storage before: $(storage_mode)"

run_root mkdir -p /var/log/journal "$DROPIN_DIR"
run_root tee "$DROPIN_FILE" >/dev/null <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=300M
EOF

run_root systemctl restart systemd-journald

echo "journald Storage after: $(storage_mode)"
echo "configured $DROPIN_FILE with SystemMaxUse=300M"
