# AGENTS.md

HomeCameraSystem is a self-hosted camera system: a Jetson Nano 2GB owns the
camera, MediaMTX, FastAPI server, and Python 3.6 detection worker; Android and
browser clients run the React/Vite PWA.

Read `CLAUDE.md` before changing code. It is the detailed source of truth for
architecture, deployment constraints, wire contracts, Python 3.6 compatibility,
camera recovery, logging, and the "Don't reintroduce" invariants. This file adds
the common agent workflow and verification entry points.

## Working rules

- Preserve unrelated changes. This repository is often intentionally dirty;
  never reset or overwrite work that is outside the requested scope.
- Develop and test with the Jetson offline. Hardware access is required only for
  deployment and live-stream verification.
- Keep `detection/` Python 3.6 compatible. It runs on the Jetson host, outside
  Docker, for libargus/TensorRT/NVDEC access.
- Never build the server image natively on the Nano. Use
  `deploy/cross-deploy-server.sh` to build ARM64 on the development machine.
- Never place credentials, cookies, JWTs, SDP bodies, private keys, camera
  frames, or recordings in logs, CI artifacts, issue text, or external error
  reporting.
- A green unit suite is not sufficient for Android/WebView, WebRTC, touch,
  fullscreen, service-worker, or camera-pipeline changes. Verify the relevant
  behavior on the connected phone and/or live Jetson.
- Prefer accessible selectors (`getByRole`, `getByLabel`) in browser tests.
  Use stable test IDs only for interaction surfaces without a natural role.

## Primary checks

Run from the repository root unless noted:

```bash
# All normal local suites
./scripts/check.sh

# Individual suites
./scripts/check.sh contracts client server detection android

# Production-like mobile browser journey
cd client && npm run test:e2e:mobile

# Existing desktop/browser integration suite
cd client && npm run test:e2e

# Lighthouse regression budgets (build first)
cd client && npm run build
npx --yes @lhci/cli@0.15.1 autorun --config=lighthouserc.cjs

# Prometheus config and alert validation
docker run --rm \
  -v "$PWD/deploy/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v2.54.1 \
  check config /etc/prometheus/prometheus.yml
```

The mobile Playwright gate covers authentication, the Home/live scene, stream
controls, tap-to-hide scene chrome, Settings navigation, and Focus Assistant.
Its FastAPI fixture deliberately has no live MediaMTX WHEP endpoint; expected
WHEP 405 logs are not proof of a production stream failure. Use the existing
live-WHEP harness for decoded-frame verification against the Jetson.

## Real Android verification

Build/install the debug wrapper, then collect bounded evidence:

```bash
./gradlew --no-daemon :android-wrapper:assembleDebug
adb -s "$HOMECAM_ADB_SERIAL" install -r \
  android-wrapper/build/outputs/apk/debug/android-wrapper-debug.apk
HOMECAM_ADB_SERIAL="$HOMECAM_ADB_SERIAL" ./scripts/verify-phone.sh
```

`scripts/verify-phone.sh` launches the wrapper and saves a screenshot, UI
hierarchy, and logcat evidence in `/tmp/homecam-phone-smoke` by default. It does
not store or type credentials. Debug APKs expose their embedded WebView over ADB
(`webview_devtools_remote_<pid>`), allowing `chrome://inspect` or compatible
DevTools automation. Release builds keep WebView debugging disabled.

Wireless-debugging ports can rotate. Do not assume a historical ADB endpoint is
current; inspect `adb devices` and use the single device in state `device`.

## CI and security

- `.github/workflows/checks.yml` runs client, Python, and Android checks.
- `.github/workflows/performance.yml` runs the Pixel 7 Playwright journey and
  Lighthouse budgets, retaining failure traces and reports as CI artifacts.
- `.github/workflows/security.yml` runs CodeQL for TypeScript, Python, and
  Java/Kotlin plus a filesystem vulnerability/secret scan.
- `.github/dependabot.yml` groups weekly npm, pip, Gradle, and Actions updates.

The Trivy GitHub Action suffered a tag supply-chain compromise in 2026. The
security workflow therefore executes the recovered official Trivy container
directly and pins it by digest. Do not replace that digest with a mutable
`aquasecurity/trivy-action` tag. Baseline a proposed scanner change locally
before making it blocking; exclude local untracked evidence such as
`.jetson-snapshot/` and never commit files containing real keys.

## Performance tooling

`client/lighthouserc.cjs` enforces explicit category and byte budgets. Reports
stay in local/CI filesystem artifacts instead of public temporary storage.

For live Chrome performance traces, configure the Chrome DevTools MCP connector
for the agent session:

```json
{
  "chrome-devtools": {
    "type": "local",
    "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
  }
}
```

Do not claim live Core Web Vitals or trace findings when this connector is not
available. Lighthouse budgets are a regression gate, not a substitute for a
trace of the deployed Watch screen and real WebRTC session.

## Jetson observability

The optional stack is defined by `deploy/docker-compose.grafana.yml`:

- Prometheus scrapes the server's unauthenticated root `/metrics` endpoint.
- Grafana provisions the overview and detection dashboards.
- `deploy/prometheus/alerts.yml` detects a dead worker, stale camera frames,
  sustained Jetson heat, low disk space, and repeated camera recovery.

Any worker metric addition is a three-way contract: update
`detection/metrics.py`, `server/app/routes/_internal.py`'s whitelist, and the
server/client metric types and tests. Dashboard expressions must reference
metrics actually exposed by `server/app/routes/metrics_prom.py`.

## Deployment and completion

Deploy only the tiers changed by the task, using the commands and safety rules
in `CLAUDE.md`. After deployment, verify the complete affected path:

```text
phone/browser -> FastAPI -> MediaMTX/camera or storage -> visible response
```

Report separately what was implemented, what was tested locally, what was
installed on the phone, and what was activated on the Jetson. Never describe a
configuration as active merely because its files were edited locally.

Before shipping an OTA bundle, record its `manifest.json`. The manifest carries
the artifact checksum plus a source fingerprint and dirty-tree flag. The Android
wrapper's user agent carries its `versionName` as `HomeCamNative/<version>`.
Together these identify the client/detection payload and installed wrapper
without treating an arbitrary dirty checkout as a release revision.
