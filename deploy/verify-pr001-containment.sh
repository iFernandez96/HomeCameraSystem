#!/usr/bin/env bash
set -euo pipefail

: "${HOMECAM_LAN_HOST:?set HOMECAM_LAN_HOST to the Jetson LAN hostname or IP}"
: "${HOMECAM_TAILSCALE_HOST:?set HOMECAM_TAILSCALE_HOST to the Jetson tailnet hostname or IP}"
: "${HOMECAM_HTTPS_URL:?set HOMECAM_HTTPS_URL to the operator HTTPS application URL}"

command -v nc >/dev/null || { echo "ERROR: nc is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "ERROR: curl is required" >&2; exit 2; }

for host in "$HOMECAM_LAN_HOST" "$HOMECAM_TAILSCALE_HOST"; do
  for port in 8000 8554 8889 3000 9090; do
    if nc -z -w 3 "$host" "$port" >/dev/null 2>&1; then
      echo "FAIL: direct connection unexpectedly succeeded: ${host}:${port}" >&2
      exit 1
    fi
    echo "PASS: direct connection denied: ${host}:${port}"
  done
done

health_body="$(curl --fail --silent --show-error --max-time 15 \
  "${HOMECAM_HTTPS_URL%/}/healthz")"
case "$health_body" in
  *'"ok":true'*) ;;
  *)
    echo "FAIL: HTTPS health response did not contain ok=true" >&2
    exit 1
    ;;
esac

echo "PASS: HTTPS application health is reachable"
echo "PR-001 containment verification passed"
