#!/usr/bin/env bash
# Inject every critical operational alert through Alertmanager, then resolve it.
# Dry-run is the safe default because execution sends real device notifications.
set -euo pipefail

MODE="${1:---dry-run}"
ALERTMANAGER_URL="${HOMECAM_ALERTMANAGER_URL:-http://127.0.0.1:9093}"
RULES_FILE="${HOMECAM_ALERT_RULES:-$(dirname "$0")/prometheus/alerts.yml}"
DRILL_ID="${HOMECAM_DRILL_ID:-pr206-$(date +%s)}"

if [[ "$MODE" != "--dry-run" && "$MODE" != "--execute" ]]; then
  echo "usage: $0 [--dry-run|--execute]" >&2
  exit 2
fi
if [[ "$MODE" == "--execute" && "${HOMECAM_DRILL_CONFIRM:-}" != "YES" ]]; then
  echo "refusing notification drill: export HOMECAM_DRILL_CONFIRM=YES" >&2
  exit 2
fi
if [[ ! "$DRILL_ID" =~ ^pr206-[0-9]{10}$ ]]; then
  echo "refusing invalid drill id" >&2
  exit 2
fi

mapfile -t ALERT_NAMES < <(
  awk '
    /- alert:/ { name=$3 }
    /labels: \{ severity: critical \}/ { print name }
  ' "$RULES_FILE"
  # Server restart is warning-level after successful bounded recovery, but it
  # is an explicit PR-206 delivery path and belongs in the same drill.
  printf '%s\n' HomecamServerRestarted
)

if [[ "$MODE" == "--dry-run" ]]; then
  printf 'DRY RUN: would inject firing then resolved notifications via %s:\n' "$ALERTMANAGER_URL"
  printf '  %s\n' "${ALERT_NAMES[@]}"
  exit 0
fi

build_payload() {
  local state="$1" ends_at="$2" first=1 name
  printf '['
  for name in "${ALERT_NAMES[@]}"; do
    if (( first )); then first=0; else printf ','; fi
    printf '{"labels":{"alertname":"%s","severity":"critical","drill":"%s"},' "$name" "$DRILL_ID"
    printf '"annotations":{"summary":"PR-206 alert delivery drill","description":"Synthetic operational alert; no production data is included."},'
    printf '"startsAt":"%s","endsAt":"%s","generatorURL":""}' "$STARTED_AT" "$ends_at"
  done
  printf ']'
}

curl --fail --silent --show-error "$ALERTMANAGER_URL/-/ready" >/dev/null
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_SINCE="$STARTED_AT"
FIRING_ENDS_AT=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
build_payload firing "$FIRING_ENDS_AT" |
  curl --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    --data-binary @- "$ALERTMANAGER_URL/api/v2/alerts" >/dev/null

echo "injected ${#ALERT_NAMES[@]} firing alerts; waiting for grouped delivery"
wait_for_delivery() {
  local status="$1" deadline=$((SECONDS + 180)) logs name count ready
  while (( SECONDS < deadline )); do
    logs=$(docker logs --since "$LOG_SINCE" homecam-alert-receiver 2>&1 || true)
    ready=1
    for name in "${ALERT_NAMES[@]}"; do
      count=$(grep -c "operational alert delivered status=$status alertname=$name drill=$DRILL_ID " <<<"$logs" || true)
      if [[ "$count" != "1" ]]; then
        ready=0
        break
      fi
    done
    if (( ready )); then
      return 0
    fi
    sleep 2
  done
  return 1
}

if ! wait_for_delivery firing; then
  echo "timed out waiting for all firing deliveries; not resolving before the delivery evidence is complete" >&2
  exit 1
fi
RESOLVED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
build_payload resolved "$RESOLVED_AT" |
  curl --fail --silent --show-error \
    -H 'Content-Type: application/json' \
    --data-binary @- "$ALERTMANAGER_URL/api/v2/alerts" >/dev/null

echo "injected recovery states; waiting for Alertmanager group interval"
if ! wait_for_delivery resolved; then
  echo "timed out waiting for all recovery deliveries" >&2
  exit 1
fi
LOGS=$(docker logs --since "$LOG_SINCE" homecam-alert-receiver 2>&1 || true)
failed=0
for name in "${ALERT_NAMES[@]}"; do
  firing=$(grep -c "operational alert delivered status=firing alertname=$name drill=$DRILL_ID " <<<"$LOGS" || true)
  resolved=$(grep -c "operational alert delivered status=resolved alertname=$name drill=$DRILL_ID " <<<"$LOGS" || true)
  if [[ "$firing" != "1" || "$resolved" != "1" ]]; then
    echo "FAIL $name: delivered firing=$firing resolved=$resolved" >&2
    failed=1
  else
    echo "PASS $name: one firing delivery and one recovery delivery"
  fi
done
if (( failed )); then
  echo "alert drill failed; inspect secret-safe homecam-alert-receiver and Alertmanager logs" >&2
  exit 1
fi
echo "alert drill passed at the Web Push gateway boundary; confirm notification display on an off-box device"
