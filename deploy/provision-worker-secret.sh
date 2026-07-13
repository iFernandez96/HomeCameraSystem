#!/usr/bin/env bash
set -euo pipefail

SECRET_DIR=${HOMECAM_WORKER_AUTH_DIR:-/etc/homecam}
SECRET_PATH=${HOMECAM_WORKER_AUTH_FILE:-${SECRET_DIR}/worker-auth.secret}
SECRET_GROUP=${HOMECAM_WORKER_AUTH_GROUP:-israel}
ROTATE=0

usage() {
  echo "usage: $0 [--rotate]" >&2
}

if [[ ${1:-} == "--rotate" ]]; then
  ROTATE=1
  shift
fi
if [[ $# -ne 0 ]]; then
  usage
  exit 2
fi

if ! getent group "$SECRET_GROUP" >/dev/null; then
  echo "worker secret group does not exist" >&2
  exit 1
fi

valid_secret() {
  local path=$1
  [[ $(sudo stat -c '%s' "$path" 2>/dev/null || true) == "65" ]] &&
    sudo grep -Eq '^[0-9a-f]{64}$' "$path"
}

if sudo test -e "$SECRET_PATH" && [[ $ROTATE -eq 0 ]]; then
  if ! valid_secret "$SECRET_PATH"; then
    echo "existing worker secret is invalid; refuse to replace without --rotate" >&2
    exit 1
  fi
  sudo chown "root:${SECRET_GROUP}" "$SECRET_PATH"
  sudo chmod 0640 "$SECRET_PATH"
  echo "worker secret already provisioned (content not displayed)"
  sudo stat -c 'owner=%U group=%G mode=%a bytes=%s' "$SECRET_PATH"
  exit 0
fi

umask 077
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
openssl rand -hex 32 >"$tmp"

sudo install -d -o root -g "$SECRET_GROUP" -m 0750 "$SECRET_DIR"
sudo install -o root -g "$SECRET_GROUP" -m 0640 "$tmp" "${SECRET_PATH}.new"
sudo mv -f "${SECRET_PATH}.new" "$SECRET_PATH"

if ! valid_secret "$SECRET_PATH"; then
  echo "worker secret provisioning validation failed" >&2
  exit 1
fi

echo "worker secret provisioned (content not displayed)"
sudo stat -c 'owner=%U group=%G mode=%a bytes=%s' "$SECRET_PATH"
