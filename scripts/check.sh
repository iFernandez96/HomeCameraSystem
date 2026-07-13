#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PYTHON="$ROOT/.venv/bin/python"
elif [[ -x /tmp/homecam-venv/bin/python ]]; then
  PYTHON=/tmp/homecam-venv/bin/python
else
  PYTHON=python3
fi

run_contracts() {
  "$PYTHON" scripts/generate-contracts.py --check
  PYTHON="$PYTHON" bash scripts/test-release-source.sh
}
run_client() { (cd client && npm run lint && npm run typecheck && npm test -- --run && npm run build); }
run_server() { PYTHONPATH="$ROOT:$ROOT/server" "$PYTHON" -m pytest -q server/tests; }
run_detection() { PYTHONPATH="$ROOT/detection" "$PYTHON" -m pytest -q detection/tests; }
run_android() { ./gradlew --no-daemon :android-wrapper:assembleDebug; }

if [[ $# -eq 0 ]]; then
  set -- contracts client server detection android
fi

for suite in "$@"; do
  case "$suite" in
    contracts) run_contracts ;;
    client) run_client ;;
    server) run_server ;;
    detection) run_detection ;;
    android) run_android ;;
    *) echo "unknown check suite: $suite" >&2; exit 2 ;;
  esac
done
