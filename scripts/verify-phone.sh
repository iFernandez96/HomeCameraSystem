#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${HOMECAM_ANDROID_PACKAGE:-com.example.homecamerasystem}"
ARTIFACT_DIR="${HOMECAM_PHONE_ARTIFACT_DIR:-/tmp/homecam-phone-smoke}"
SERIAL="${HOMECAM_ADB_SERIAL:-}"

if [[ -z "$SERIAL" ]]; then
  mapfile -t DEVICES < <(adb devices | awk 'NR > 1 && $2 == "device" {print $1}')
  if [[ ${#DEVICES[@]} -ne 1 ]]; then
    echo "Set HOMECAM_ADB_SERIAL; expected one connected device, found ${#DEVICES[@]}." >&2
    exit 2
  fi
  SERIAL="${DEVICES[0]}"
fi

ADB=(adb -s "$SERIAL")
mkdir -p "$ARTIFACT_DIR"
START_EPOCH="$(date +%s)"

"${ADB[@]}" get-state >/dev/null
"${ADB[@]}" shell pm path "$PACKAGE" >/dev/null
"${ADB[@]}" shell am force-stop "$PACKAGE"
"${ADB[@]}" shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null

for _ in {1..20}; do
  PID="$("${ADB[@]}" shell pidof "$PACKAGE" | tr -d '\r')"
  [[ -n "$PID" ]] && break
  sleep 0.5
done
[[ -n "${PID:-}" ]] || { echo "App did not start." >&2; exit 1; }

"${ADB[@]}" shell uiautomator dump /sdcard/homecam-window.xml >/dev/null
"${ADB[@]}" pull /sdcard/homecam-window.xml "$ARTIFACT_DIR/window.xml" >/dev/null
"${ADB[@]}" exec-out screencap -p > "$ARTIFACT_DIR/screenshot.png"
"${ADB[@]}" logcat -d -T "$START_EPOCH.000" > "$ARTIFACT_DIR/logcat.txt" || true

if ! "${ADB[@]}" shell dumpsys window windows | grep -q "$PACKAGE"; then
  echo "HomeCam is not the foreground window." >&2
  exit 1
fi

if grep -Eqi 'FATAL EXCEPTION|AndroidRuntime.*Process: com\.example\.homecamerasystem' "$ARTIFACT_DIR/logcat.txt"; then
  echo "Android runtime failure detected; see $ARTIFACT_DIR/logcat.txt" >&2
  exit 1
fi

echo "Phone smoke passed on $SERIAL (pid $PID). Evidence: $ARTIFACT_DIR"
