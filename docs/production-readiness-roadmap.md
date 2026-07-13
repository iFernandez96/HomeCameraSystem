# Production-readiness roadmap

This is the canonical, version-controlled roadmap for moving HomeCameraSystem
from its current operator-grade beta to a production-ready, single-household
camera appliance. It records work; it does not authorize implementation or
deployment. Implement a roadmap item only when the operator explicitly requests
that item or phase.

## Roadmap metadata

| Field | Value |
|---|---|
| Last reviewed | 2026-07-13 |
| Assessment baseline | `266fe7e` on `agent/camera-reliability-and-mobile-release` |
| Assessment checkout | Dirty working tree preserved in place; it is not a release source |
| Release baseline | `release/pr-000-clean-baseline` at tag `pr-000-verified-20260713` |
| Release baseline cleanliness | Clean isolated worktree; release builds reject tracked or untracked changes |
| Target | One household, one Jetson, Android/browser clients, Tailscale-only remote access |
| Initial release model | Versioned, laptop-built artifacts and operator-driven deployment; OTA disabled; signing pending PR-302 |
| Out of initial launch | Direct Internet exposure, cloud relay, high availability, experimental hardware, unproven named-face recognition |
| Parallel plan revision | 2026-07-13; six workstreams, five execution waves, five milestone gates |

The baseline records the repository state that was inspected, not a release
candidate. Re-review links and statuses after material changes to authentication,
MediaMTX, worker transport, persistence, deployment, or systemd topology.

## How to maintain this roadmap

- Update `Last reviewed` and the baseline whenever the roadmap is reconciled
  against the live repository.
- Use only these statuses: `Not started`, `In progress`, `Partially implemented`,
  `Awaiting evidence`, `Blocked`, `Done`, and `Deferred`.
- Add a named owner when one accepts the work. `Engineering (unassigned)` means
  the work has no assigned implementer. `Operator` identifies an operator-owned
  decision or external setup, not permission for an agent to perform it.
- Set an item to `Done` only when its acceptance criteria are met and linked
  evidence identifies the tested artifact. For Jetson, Android, WebRTC, camera,
  storage, deployment, or rollback work, local tests alone are insufficient.
- Report implementation, local verification, phone installation, and Jetson
  activation separately. Edited files do not prove that a configuration is
  active.
- If scope changes, edit the existing item or add a new stable ID. Do not silently
  weaken acceptance criteria to close an item.
- Every implementation PR or intentional commit should reference its roadmap ID
  and update that item's status/evidence in the same change or an immediately
  following evidence-only change.

## Priority and ownership conventions

- **P0 — launch blocker:** unsafe to expose or depend on for production.
- **P1 — production gate:** required before declaring the constrained initial
  release production-ready.
- **P2 — post-launch:** worthwhile hardening that does not block the constrained
  initial launch.
- Effort is focused engineer-days and excludes hardware procurement, soak time,
  and waiting for the Jetson, phone, signing keys, or backup destination.

## Launch definition

The quickest safe production target deliberately narrows the product surface:

- The Jetson is not directly exposed to the public Internet.
- Remote access is through an operator-controlled Tailscale tailnet and HTTPS.
- Live video and protected APIs require authenticated, scoped grants.
- OTA apply remains disabled; the laptop performs versioned deployments.
- Audio, physical deterrence, and other optional hardware remain disabled until
  explicitly provisioned and proven.
- Named-face recognition remains beta/unavailable until real named-person parity
  evidence closes its existing proof gap.
- Single-device availability is accepted, but backup, rollback, alerting, and
  bare-metal recovery are tested.

## Phase 0 — Freeze scope and contain exposure

These items precede feature work. Phase 1 security and Phase 2 data/reliability
work may start in parallel only after PR-000 establishes an intentional source
baseline.

| ID | Minimum necessary change | Pri | Status | Owner | Dependencies | Acceptance criteria | Estimate | Relevant code/docs |
|---|---|---:|---|---|---|---|---:|---|
| PR-000 | Create a clean, intentional release branch/worktree containing only reviewed changes. Make release builds refuse dirty input. | P0 | Done | Release engineering (Codex) | None | `git status --porcelain` is empty; the release manifest identifies the Git SHA and source fingerprint and says `dirty:false`; unrelated current changes are preserved. | 0.5–1 d | [`scripts/source-fingerprint.sh`](../scripts/source-fingerprint.sh), [`deploy/build-ota-artifact.sh`](../deploy/build-ota-artifact.sh) |
| PR-001 | Apply temporary containment: configure `HOMECAM_OTA_DISABLED=1`, restrict ports 8000/8889/3000 and metrics to loopback/internal networks, constrain Tailscale ACLs, and disable unprotected Grafana. | P0 | Done | Engineering (Codex) + Operator | None | A separate LAN/tailnet client cannot reach direct FastAPI, MediaMTX, Grafana, metrics, or internal-worker surfaces; the HTTPS application remains reachable; OTA returns a typed disabled result. | 0.5 d | [`server/app/services/ota_kill_switch.py`](../server/app/services/ota_kill_switch.py), [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), [`deploy/mediamtx.yml`](../deploy/mediamtx.yml), [`deploy/docker-compose.grafana.yml`](../deploy/docker-compose.grafana.yml), [`deploy/verify-pr001-containment.sh`](../deploy/verify-pr001-containment.sh) |
| PR-002 | Freeze the initial launch feature set and mark excluded features unavailable/beta in operator-facing documentation and UI where necessary. | P0 | Done | Product owner (Israel) + Engineering (Codex) | PR-000 | OTA, optional hardware, and named-face recognition cannot be mistaken for production-supported capabilities; no launch claim exceeds collected evidence. | 0.25–0.5 d | [`CLAUDE.md`](../CLAUDE.md), [`docs/standalone_proof_plan.md`](standalone_proof_plan.md), [`README.md`](../README.md), [`client/src/pages/People.tsx`](../client/src/pages/People.tsx), [`client/src/pages/Training.tsx`](../client/src/pages/Training.tsx), [`client/src/pages/settings/DangerZone.tsx`](../client/src/pages/settings/DangerZone.tsx) |

PR-001 completion note (2026-07-13): loopback bindings and TCP-only RTSP are
the host-enforced containment boundary, so direct ports remain denied even if a
future tailnet policy is accidentally broadened. Tailscale Serve remains
tailnet-only on HTTPS 443. The centrally managed tailnet policy is not exported
to this repository; its operator rule is documented in
[`deploy/README.md`](../deploy/README.md) and must not grant the direct service
ports. No central policy contents or identity details were captured as
evidence.

PR-002 completion note (2026-07-13): the initial one-household/one-Jetson
launch candidate is documented separately from beta and unavailable features.
Named-person recognition is visibly beta on People and Training, OTA controls
are disabled with the laptop-driven deployment path stated, and optional
hardware remains fail-closed behind existing capability gates. Release signing
is explicitly pending PR-302 rather than claimed by this scope freeze.

## Phase 1 — Close security boundaries

PR-101, PR-102, PR-104, and PR-105 can run in parallel. PR-103 should integrate
with PR-101 so the final live-media proof exercises the production transport and
authorization path once.

| ID | Minimum necessary change | Pri | Status | Owner | Dependencies | Acceptance criteria | Estimate | Relevant code/docs |
|---|---|---:|---|---|---|---|---:|---|
| PR-101 | Require a short-lived, one-use authenticated media grant for every registered video WHEP read. Extend the existing audio grant store and send grants in `Authorization`, never URLs. Restrict MediaMTX origins. | P0 | Done | Engineering (Codex) | PR-000 | Missing, wrong-scope, expired, and replayed grants fail; one correct grant receives a real frame; grants never enter URLs, logs, state, telemetry, or evidence; all quality rungs and reconnects work on the phone. | 1.5–2.5 d | [`server/app/services/mediamtx_auth.py`](../server/app/services/mediamtx_auth.py), [`server/app/services/media_tokens.py`](../server/app/services/media_tokens.py), [`server/app/routes/security.py`](../server/app/routes/security.py), [`client/src/lib/webrtc.ts`](../client/src/lib/webrtc.ts), [`deploy/mediamtx.yml`](../deploy/mediamtx.yml) |
| PR-102 | Separate and authenticate worker-only internal routes. Preserve the exact-peer MediaMTX callback and move the bounded public client-log sink out of the worker trust surface. Provision a root-readable worker secret and add loopback/proxy denial as defense in depth. | P0 | Done | Engineering (Codex) + Operator | PR-000 | Remote requests to config, heartbeat, event, signal, finalized-event, and host-action endpoints fail; the real worker remains healthy; credential failures are bounded and safely logged; no credential bytes enter logs or artifacts. | 1.5–2.5 d | [`server/app/routes/_internal.py`](../server/app/routes/_internal.py), [`detection/detect.py`](../detection/detect.py), [`detection/host_action.py`](../detection/host_action.py), [`deploy/systemd/homecam-detect.service`](../deploy/systemd/homecam-detect.service), [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) |
| PR-103 | Remove authenticated LAN HTTP fallback and Android cleartext exceptions. Route the app and WHEP through Tailscale HTTPS; bind or firewall direct media/control ports. | P0 | Done | Engineering (Codex) + Operator | PR-101 | Android rejects HTTP and contains no cleartext exception; no mixed-content path remains; live view works on Wi-Fi and cellular through HTTPS; direct ports are unreachable remotely; exact development and production origins pass. | 1–1.5 d | [`android-wrapper/build.gradle`](../android-wrapper/build.gradle), [`android-wrapper/src/main/res/xml/network_security_config.xml`](../android-wrapper/src/main/res/xml/network_security_config.xml), [`client/src/lib/streamQuality.ts`](../client/src/lib/streamQuality.ts), [`client/src/lib/twoWayAudio.ts`](../client/src/lib/twoWayAudio.ts), [`deploy/mediamtx.yml`](../deploy/mediamtx.yml) |
| PR-104 | Add persistent, endpoint-specific progressive login backoff keyed by normalized account and trusted source address. Do not add global rate-limit middleware or whole-house lockout. | P1 | Done | Engineering (Codex) | PR-000; trusted-proxy policy (resolved) | Repeated failures trigger bounded 429/backoff and survive restart; a correct login clears only the intended bucket; another legitimate account remains usable; unknown-user and bad-password wire responses remain indistinguishable. | 1–1.5 d | [`server/app/routes/auth.py`](../server/app/routes/auth.py), [`server/app/services/login_backoff.py`](../server/app/services/login_backoff.py), [`server/app/services/audit_db.py`](../server/app/services/audit_db.py), [`server/tests/test_login_backoff.py`](../server/tests/test_login_backoff.py), [`server/tests/test_auth_routes.py`](../server/tests/test_auth_routes.py), [`docs/decisions/pr-104-trusted-client-address.md`](decisions/pr-104-trusted-client-address.md), [`CLAUDE.md`](../CLAUDE.md) |
| PR-105 | Make metrics and dashboards internal or authenticated; remove anonymous Grafana viewing. | P1 | Done | Engineering (Codex) + Operator | PR-001 | Remote unauthenticated metrics/dashboard requests fail; Prometheus still scrapes internally; Grafana has explicit credentials or is loopback-only; no sensitive operational identifiers leak publicly. | 0.5 d | [`server/app/routes/metrics_prom.py`](../server/app/routes/metrics_prom.py), [`server/tests/test_metrics_prom.py`](../server/tests/test_metrics_prom.py), [`server/tests/test_deploy_containment.py`](../server/tests/test_deploy_containment.py), [`deploy/docker-compose.grafana.yml`](../deploy/docker-compose.grafana.yml), [`deploy/prometheus/prometheus.yml`](../deploy/prometheus/prometheus.yml) |

PR-102 completion note (2026-07-13): implementation commit `c076d64` passed the
full client, server, detection, Android build, browser, Lighthouse, contract,
Prometheus, compose, and release-source checks. The same server, client, and
detection payload was activated on the Jetson after provisioning the worker
secret with the documented ownership and modes. Direct unauthenticated and
proxy-marked worker requests returned empty denials, while 31 samples over 15
minutes kept the authenticated worker alive with the server and MediaMTX
continuously active. A connected-phone smoke displayed a decoded live frame.
Rejection logs contained only bounded request metadata; automated redaction
tests verified that credential bytes do not enter logs or response bodies.

PR-103 completion note (2026-07-13): implementation commit `5ae03c1` removed
the Android LAN URL, fallback navigation and health probe, cleartext domain
exception, mixed-content compatibility, and direct MediaMTX signaling URL
construction. Full client, server, detection, Android, browser, Lighthouse,
contract, Prometheus, Compose, and release-source checks passed. The PWA payload
was activated on the Jetson behind the existing Tailscale Serve root and
`/whep` HTTPS mappings; ports 8000, 8554, and 8889 remained unreachable from
both LAN and tailnet clients. The exact PR-103 debug wrapper decoded live frames
over both Wi-Fi and cellular, after which the phone's newer pre-existing wrapper
was restored without clearing app data. TCP/UDP 8189 remains the intentional
WebRTC ICE media listener, not an alternate signaling or application endpoint.

PR-104 completion note (2026-07-13): implementation commit `aba32ee` fixed the
canonical address contract: application code consumes only normalized
`request.client.host`, while Uvicorn accepts proxy headers solely from
`127.0.0.1`, `::1`, and the fixed `172.30.0.1` HomeCam Docker gateway. The
endpoint/account/source backoff migration is persistent, atomic, bounded, and
fail-closed; no global middleware or whole-house lockout was added. Full client
(1,620 passed), server (1,372 passed, 85 expected skips), detection (672 passed,
23 expected skips), Android, desktop/mobile browser, three-run Lighthouse,
Compose, contract, and release-source checks passed. The same server and PWA
payload was activated on the Jetson. A synthetic HTTPS request carrying a
spoofed leftmost `X-Forwarded-For` stored the real laptop Tailscale address,
returned 401/401, survived a real server-container restart, then returned
bounded 429 responses at the one- and two-second rungs; a different live probe
account remained outside the blocked bucket, while the route suite proved a
second legitimate account could still log in. The deployed browser rendered
the matching countdown, the connected-phone smoke passed, and the synthetic
backoff rows were removed.

PR-105 completion note (2026-07-13): implementation commit `640f834`
source-gated `/metrics` to loopback and the fixed `172.30.0.0/24` HomeCam
Compose network, while both exact and trailing-slash remote forms return the
ordinary unknown-route 404 without metric names. Prometheus remains unexposed
and targets `server:8000` internally; Grafana remains loopback-only with
anonymous viewing and sign-up disabled. Focused observability checks passed
(31 tests), the full contract/server gate passed (1,376 passed, 85 expected
hardware/fixture skips), layered Compose and all five Prometheus alert rules
validated, and clean-source checks passed. The server tier was activated on
the Jetson: public HTTPS `/metrics` and `/metrics/` returned 404, while both a
host-local scrape and a transient container on `homecam-net` returned 200;
`/healthz`, MediaMTX, and detection remained healthy. The optional
Prometheus/Grafana stack was not enabled solely for verification.

## Phase 2 — Make state, recovery, and alerting trustworthy

The data lane (PR-201–PR-203) and reliability lane (PR-204–PR-207) can run in
parallel. PR-206 should be completed after new backup and probe signals exist so
alert delivery is tested once against the final signal set.

| ID | Minimum necessary change | Pri | Status | Owner | Dependencies | Acceptance criteria | Estimate | Relevant code/docs |
|---|---|---:|---|---|---|---|---:|---|
| PR-201 | Produce SQLite-consistent system backups with the online backup API instead of archiving live WAL files. Define the complete recovery inventory and an intentional sessions/JWT policy. | P0 | Done | Engineering (Codex) | PR-000 | Concurrent writes yield a valid point-in-time snapshot; `PRAGMA integrity_check` passes; every durable database/file is included or explicitly excluded; restore forces reauthentication unless session state is intentionally restored consistently. | 1.5–2 d | [`server/app/services/backup_manifest.py`](../server/app/services/backup_manifest.py), [`server/app/services/backup_snapshot.py`](../server/app/services/backup_snapshot.py), [`server/app/services/backup_orchestrator.py`](../server/app/services/backup_orchestrator.py), [`server/app/services/backup_restore.py`](../server/app/services/backup_restore.py), [`server/tests/harness_backup/test_pr201_consistent_backup.py`](../server/tests/harness_backup/test_pr201_consistent_backup.py), [`docs/decisions/pr-201-recovery-inventory.md`](decisions/pr-201-recovery-inventory.md) |
| PR-202 | Encrypt backups before publication. Use a recipient public key on the Jetson, keep the recovery key off-device, schedule local encrypted backups, and record backup age plus the explicit replication state. Genuine automatic off-device replication is excluded from this PR and tracked by PR-208; a same-Jetson drive or intermittently present laptop is not an acceptable substitute. | P0 | In progress | Engineering (Codex) + Operator for key custody | PR-201 | Backup bytes disclose no filenames, keys, users, or configuration; tampering fails closed; no plaintext final or temporary survives; a clean scratch restore meets RTO <=60 min; status explicitly identifies off-device replication as deferred. | 2–3 d | [`server/app/services/backup_archive.py`](../server/app/services/backup_archive.py), [`server/app/services/backup_crypto.py`](../server/app/services/backup_crypto.py), [`server/app/services/backup_status.py`](../server/app/services/backup_status.py), [`server/app/routes/control.py`](../server/app/routes/control.py), [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), [`deploy/RECOVERY_DRILLS.md`](../deploy/RECOVERY_DRILLS.md), [`docs/decisions/pr-202-encrypted-local-backups.md`](decisions/pr-202-encrypted-local-backups.md) |
| PR-203 | Make restore maintenance mode honest and application-wide, or narrow the documented guarantee. Reject normal mutations while replacement/validation runs and expose typed maintenance state. | P1 | Partially implemented | Engineering (unassigned) | PR-201 | Concurrent maintenance operations and ordinary mutations are rejected with typed responses; reads can report maintenance; failed validation restores pre-restore bytes; restart cannot leave a stale in-process maintenance flag. | 0.5–1 d | [`server/app/services/backup_restore.py`](../server/app/services/backup_restore.py), [`server/app/routes/control.py`](../server/app/routes/control.py), [`server/tests/harness_backup/`](../server/tests/harness_backup/) |
| PR-204 | Implement the low-duty synthetic WHEP probe already designed. Require RTP/frame evidence, expose TTFF/result metrics, and route local failures into the existing persisted recovery ladder rather than creating another ladder. | P0 | Not started | Engineering (unassigned) | PR-101, PR-102 | Every rung is probed at bounded cadence; signaling-success/no-media is detected; debounce produces exactly one existing ladder action; external-only cellular failure alerts without restarting the camera; the worker/server/client metric contract remains synchronized. | 2–3 d | [`docs/liveview_reliability_plan.md`](liveview_reliability_plan.md), [`detection/mediamtx_watchdog.py`](../detection/mediamtx_watchdog.py), [`detection/metrics.py`](../detection/metrics.py), [`server/app/routes/_internal.py`](../server/app/routes/_internal.py), [`server/app/routes/metrics_prom.py`](../server/app/routes/metrics_prom.py) |
| PR-205 | Add bounded ongoing host supervision for the server container, distinct from camera recovery. Debounce health failures, restart only the server tier, and stop/alert on structural loops. | P0 | Partially implemented | Engineering (unassigned) | PR-001 | Killing the server container recovers service within two minutes; camera publication continues; repeated structural failure stops after a bounded count and alerts; the action and reason are visible separately from camera recovery. | 1–1.5 d | [`deploy/systemd/homecam-server.service`](../deploy/systemd/homecam-server.service), [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), [`server/app/routes/healthz.py`](../server/app/routes/healthz.py), [`docs/liveview_reliability_plan.md`](liveview_reliability_plan.md) |
| PR-206 | Deliver critical alerts off-box. Add a receiver for degraded-but-online failures and keep the Android health monitor as the independently running Jetson-offline detector. Add backup age, mount, WHEP probe, root disk, update/restore, and server-restart alerts. | P1 | Partially implemented | Engineering (unassigned) + Operator for receiver | PR-202, PR-204, PR-205 | Each critical alert is injected in a drill and arrives once off-box; recovery notice arrives; annotations are secret-safe; Jetson power-off produces an Android alert without the server running. | 1–2 d | [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml), [`deploy/docker-compose.grafana.yml`](../deploy/docker-compose.grafana.yml), [`android-wrapper/src/main/java/com/example/homecamerasystem/JetsonHealthMonitor.java`](../android-wrapper/src/main/java/com/example/homecamerasystem/JetsonHealthMonitor.java) |
| PR-207 | Complete physical-appliance operations: media-mount failure, filesystem/SMART checks where supported, SD wear, UPS/safe shutdown, spare-media provisioning, and bare-metal reimage/restore runbooks. | P1 | Partially implemented | Operator + Engineering (unassigned) | PR-202, PR-206 | Missing media prevents fallback writes and alerts; power loss behavior is documented/tested; a replacement system can be provisioned and restored using only the runbook and recovery material. | 1–2 d | [`deploy/RECOVERY_DRILLS.md`](../deploy/RECOVERY_DRILLS.md), [`deploy/recovery-drill.sh`](../deploy/recovery-drill.sh), [`deploy/recover-camera.sh`](../deploy/recover-camera.sh), [`deploy/README.md`](../deploy/README.md) |
| PR-208 | Replicate encrypted backups automatically to a genuinely off-device, independently available target and alert on stale/failed replication. Target selection is an operator prerequisite; a second drive in the Jetson and an intermittently nearby laptop do not qualify. | P0 | Deferred | Operator for target decision + Engineering (unassigned) | PR-202; always-available remote target and credentials | Scheduled replication meets RPO <=24 h; remote integrity and retention are checked; failure/recovery alerts arrive off-box; a restore uses the replicated artifact; no recovery private key is placed on the Jetson or replication target. | TBD after target selection | [`docs/decisions/pr-202-encrypted-local-backups.md`](decisions/pr-202-encrypted-local-backups.md), [`deploy/RECOVERY_DRILLS.md`](../deploy/RECOVERY_DRILLS.md), [`server/app/services/backup_status.py`](../server/app/services/backup_status.py) |

PR-201 completion note (2026-07-13): implementation commit `7338cb0`
materializes ordinary persisted files into private stable staging and copies
`users.db`, `events.db`, and `audit.db` with SQLite's online backup API. Every
path-valued server setting is classified in the recovery inventory; JWT and
session state are intentionally excluded, and production restore rotates the
signing key plus clears sessions so all prior access and refresh tokens fail.
The focused backup/restore set passed (146 tests, one absent real-fixture skip),
and the complete contract/server gate passed (1,381 tests, 85 expected
hardware/fixture skips). A real Jetson backup
`homecam-backup-20260713T213430Z.tar.gz` contained no WAL/SHM members, all three
database snapshots returned `integrity_check=ok`, its event row count was
within the live before/after bounds, and snapshot staging was removed. The same
archive restored ten included files into an isolated ARM64 scratch root,
rotated the scratch JWT, cleared scratch sessions, and left live authentication
unchanged. The deployed server remained healthy with zero restarts/OOM; no
production restore was performed.

## Phase 3 — Produce, deploy, roll back, and prove one release

PR-301 and documentation drafting may run while Phase 2 is active. PR-303 waits
for the signed artifact, consistent backup, and real WHEP health gate. PR-304
and PR-305 run against the exact same immutable candidate.

| ID | Minimum necessary change | Pri | Status | Owner | Dependencies | Acceptance criteria | Estimate | Relevant code/docs |
|---|---|---:|---|---|---|---|---:|---|
| PR-301 | Pin server base images, Python dependencies with hashes, downloaded Compose/MediaMTX checksums, and GitHub Actions commit SHAs. Produce an SBOM and retain security results with the release. | P1 | Partially implemented | Release engineering (unassigned) | PR-000 | Clean builders resolve the same dependency set; unverified downloads fail; SBOM and vulnerability results identify the artifact; normal and security CI are green. | 1.5–2.5 d | [`deploy/Dockerfile.server`](../deploy/Dockerfile.server), [`server/requirements.txt`](../server/requirements.txt), [`deploy/install-jetson.sh`](../deploy/install-jetson.sh), [`.github/workflows/checks.yml`](../.github/workflows/checks.yml), [`.github/workflows/security.yml`](../.github/workflows/security.yml) |
| PR-302 | Add a coherent signed release workflow for versioned client, Python 3.6 detection payload, ARM64 server image, and signed Android release APK. Sign a manifest containing all checksums, image digest, source SHA/fingerprint, wrapper version, and `dirty:false`. | P0 | Partially implemented | Release engineering (unassigned) + Operator for signing-key custody | PR-301 | Manifest and APK signatures verify; `versionCode` is monotonic; all hashes match; signing keys never enter the repository/artifacts; release creation rejects dirty source. | 2–3 d | [`deploy/build-ota-artifact.sh`](../deploy/build-ota-artifact.sh), [`scripts/source-fingerprint.sh`](../scripts/source-fingerprint.sh), [`android-wrapper/build.gradle`](../android-wrapper/build.gradle), [`.github/workflows/checks.yml`](../.github/workflows/checks.yml) |
| PR-303 | Add a laptop-driven, versioned multi-tier deployment transaction. Preflight mount/disk/backup, retain previous server/client/detection artifacts, apply only changed tiers, gate promotion on health plus real first-frame evidence, and roll back every changed tier on failure. | P0 | Partially implemented | Release engineering (unassigned) | PR-201, PR-202, PR-204, PR-302 | Deliberately broken server, client, and detection candidates each restore the previous healthy version; real frames return; persisted data stays unchanged; the deploy ledger has exactly one terminal outcome. | 2–3 d | [`deploy/cross-deploy-server.sh`](../deploy/cross-deploy-server.sh), [`server/app/services/ota_apply.py`](../server/app/services/ota_apply.py), [`server/app/services/ota_orchestrator.py`](../server/app/services/ota_orchestrator.py), [`server/app/services/ota_rollback.py`](../server/app/services/ota_rollback.py) |
| PR-304 | Run the complete exact-release verification matrix: contracts, client, server, detection, Android, mobile/desktop browser, Lighthouse, security, live authenticated WHEP, phone, push display/click, backup/restore, deployment rollback, and recovery drills. | P0 | Blocked | Engineering (unassigned) + Operator for hardware evidence | PR-000–PR-002, PR-101–PR-105, PR-201–PR-207, PR-301–PR-303 | Every required suite passes against the manifest-named artifact; every rung receives a real frame; the installed phone wrapper reports the expected version; backup/restore and rollback evidence identify the same release; local, phone, and Jetson results are reported separately. | 1–2 d | [`scripts/check.sh`](../scripts/check.sh), [`scripts/verify-phone.sh`](../scripts/verify-phone.sh), [`docs/standalone_proof_plan.md`](standalone_proof_plan.md), [`deploy/recovery-drill.sh`](../deploy/recovery-drill.sh), [`AGENTS.md`](../AGENTS.md) |
| PR-305 | Execute the final fault and performance gate: server/MediaMTX/worker failures, stream-without-frames, network loss, low/full disk simulation, missing mount, reboot, clock jump, bad deploy/restore, four-hour baseline soak, and an overnight 12–24 h final run. | P1 | Blocked | Engineering (unassigned) + Operator | PR-206, PR-303, PR-304 candidate fixed | Every fault yields the intended bounded recovery or alert; no competing ladder/reboot loop/data loss/false success; soak passes existing thermal, memory, inference, dropped-frame, restart, and kernel-error thresholds; every scripted WHEP connection gets a frame within 8 s. | 1–2 d plus 12–24 h | [`deploy/soak/README.md`](../deploy/soak/README.md), [`deploy/soak/run_scenario.sh`](../deploy/soak/run_scenario.sh), [`client/lighthouserc.cjs`](../client/lighthouserc.cjs), [`.github/workflows/performance.yml`](../.github/workflows/performance.yml), [`docs/liveview_reliability_plan.md`](liveview_reliability_plan.md) |
| PR-306 | Reconcile operational documentation with current code and remove stale scaffold/missing claims. Publish one deployment matrix, rollback procedure, backup-key procedure, alert-response table, and release checklist. | P1 | Not started | Documentation owner (unassigned) | Behavior stabilized; PR-303–PR-305 evidence | A second operator can deploy, roll back, restore, rotate a secret, and diagnose stale video without repository archaeology; historical plans are clearly marked historical; documentation never describes edited-only configuration as active. | 1 d | [`README.md`](../README.md), [`CLAUDE.md`](../CLAUDE.md), [`docs/standalone_proof_plan.md`](standalone_proof_plan.md), [`deploy/README.md`](../deploy/README.md), [`deploy/RECOVERY_DRILLS.md`](../deploy/RECOVERY_DRILLS.md) |

## Post-launch hardening

These items are deferred only for the constrained initial launch. Moving to a
commercial product, direct Internet exposure, or multiple independently managed
households changes their priority and requires a fresh threat model.

| ID | Minimum necessary change | Pri | Status | Owner | Dependencies | Acceptance criteria | Estimate | Relevant code/docs |
|---|---|---:|---|---|---|---|---:|---|
| PR-401 | Complete signed, anti-rollback, transactional multi-tier OTA. Replace synthetic/deferred health with real restart and first-frame proof; apply server image and detection payload, not only client bytes. Remove the kill switch only after proof. | P2 | Deferred | Release engineering (unassigned) | PR-302, PR-303 | Invalid signature/downgrade/replay fail before unpack; unhealthy update restores every tier; persisted data is untouched; route reports success only after real restart and media health; live Jetson parity evidence exists. | 4–6 d | [`server/app/routes/control.py`](../server/app/routes/control.py), [`server/app/services/ota_manifest.py`](../server/app/services/ota_manifest.py), [`server/app/services/ota_orchestrator.py`](../server/app/services/ota_orchestrator.py), [`server/app/services/ota_apply.py`](../server/app/services/ota_apply.py), [`deploy/build-ota-artifact.sh`](../deploy/build-ota-artifact.sh) |
| PR-402 | Add owner passkey/WebAuthn or TOTP with recovery codes and tested account recovery. | P2 | Deferred | Engineering (unassigned) + Product owner (unassigned) | PR-104 | Owner can enroll, authenticate, revoke, and recover; recovery material is one-way stored/appropriately encrypted; lost-factor and clock-skew paths are tested; role checks remain unchanged. | 2–4 d | [`server/app/auth/`](../server/app/auth/), [`server/app/routes/auth.py`](../server/app/routes/auth.py), [`client/src/lib/auth.tsx`](../client/src/lib/auth.tsx) |
| PR-403 | Add full-disk or recording-volume encryption if physical theft is in the accepted threat model. | P2 | Deferred | Operator + Engineering (unassigned) | Threat-model decision; PR-207 | Stolen powered-off media reveals no recordings, crops, identities, or secrets; unattended restart and recovery tradeoffs are documented and tested. | 2–4 d | [`deploy/docker-compose.yml`](../deploy/docker-compose.yml), [`deploy/systemd/homecam-server.service`](../deploy/systemd/homecam-server.service), [`CLAUDE.md`](../CLAUDE.md) |
| PR-404 | Migrate the host worker/camera stack from EOL Jetson Nano/JetPack 4/Python 3.6 to supported hardware and a maintained OS/toolchain. | P2 | Deferred | Product owner (unassigned) + Engineering (unassigned) | Hardware decision and procurement | Single-owner camera, Privacy, inference, adaptive streams, recordings, phone behavior, performance, recovery, and rollback all pass on the new platform before cutover. | 1–3 wk plus hardware | [`deploy/README.md`](../deploy/README.md), [`detection/tests/test_py36_compat.py`](../detection/tests/test_py36_compat.py), [`CLAUDE.md`](../CLAUDE.md) |
| PR-405 | Close real named-person recognition parity before promoting the capability from beta. | P2 | Awaiting evidence | Engineering (unassigned) + Operator for consented fixtures | Representative named-person production data | A fresh consented snapshot contains named results; real modules reproduce Jetson decisions within the agreed threshold; false-match/unknown behavior is reviewed; the existing R15 proof gate closes. | 0.5–1 d after data exists | [`docs/standalone_proof_plan.md`](standalone_proof_plan.md), [`detection/face_recog/`](../detection/face_recog/), [`server/tests/harness_face_recog/`](../server/tests/harness_face_recog/) |

## Parallel delivery plan

PR-001's operator-only runtime containment may proceed immediately because it
reduces current exposure without depending on a release branch. Any
version-controlled implementation, including tracked PR-001 configuration, must
wait for PR-000 so unrelated working-tree changes are not absorbed into a
release. After that baseline exists, the following workstreams are intentionally
independent unless a dependency or shared-component constraint below says
otherwise.

### Workstreams

| Workstream | Items and internal sequence | Start gate | Can proceed concurrently with | Required handoff or sequencing constraint |
|---|---|---|---|---|
| A — Media and transport security | PR-101 → PR-103; PR-104 in parallel; PR-105 after PR-001 | PR-000, except operator-only PR-001 containment | B, C, D, and E | PR-103 must consume the final PR-101 grant flow. Finish PR-001 MediaMTX/network containment before merging PR-101, then merge PR-103 last. PR-104 needs the trusted-proxy policy fixed before implementation. |
| B — Worker trust and media-health probe | PR-102 → PR-204 | PR-000 | A, C, D, and E | PR-204 also waits for PR-101. PR-102 establishes the worker authentication and metric transport contract that PR-204 extends. Detection changes retain Python 3.6 compatibility and the existing recovery ladder. |
| C — Backup and restore integrity | PR-201 → (PR-202 and PR-203 in parallel) | PR-000 | A, B, D, and E | Merge PR-201's snapshot/manifest contract first. PR-202 and PR-203 may then proceed concurrently, but their `control.py` and backup-service changes require one integration owner and a manual reconciliation before either is considered complete. |
| D — Host reliability, alerting, and appliance operations | PR-205; then PR-206 → PR-207 | PR-001 for PR-205 | A, B, C, and E | PR-206 waits for PR-202, PR-204, and PR-205 so final signals are wired once. PR-207 waits for PR-202 and PR-206; runbook drafting may start earlier, but drills and final wording must reflect the deployed topology. |
| E — Reproducible release and rollback | PR-301 → PR-302 → PR-303 | PR-000 | A, B, C, and D until PR-303 | PR-303 waits for PR-201, PR-202, PR-204, and PR-302. PR-302 may be developed beside PR-103, but its Android build/version changes must be rebased onto the final PR-103 transport configuration before signing a candidate. |
| F — Scope, documentation, and evidence | PR-002; early PR-207/PR-306 drafts; final PR-306 | PR-000 for PR-002; stabilization for final PR-306 | All implementation workstreams | Drafting may proceed concurrently. PR-306 final reconciliation is sequential after PR-303–PR-305 evidence and must not describe edited-only configuration as active. |

### Dependency convergence

This is the merge-level dependency graph. Items on the same brace or the same
horizontal level may proceed concurrently; arrows are required completion or
integration gates, not merely preferred ordering.

```text
Immediate risk reduction: PR-001 runtime containment

PR-000 clean baseline
  ├──► PR-002 launch scope
  ├──► PR-101 media grants ──► PR-103 HTTPS-only media
  ├──► PR-102 worker trust ─┐
  │                         ├──► PR-204 real WHEP probe
  │   PR-101 media grants ──┘
  ├──► PR-104 login backoff
  ├──► PR-201 consistent backup ─┬──► PR-202 encryption/local schedule
  │                              └──► PR-203 maintenance mode
  └──► PR-301 pinned supply chain ──► PR-302 signed release

PR-001 tracked containment ─┬──► PR-105 protected observability
                            └──► PR-205 server supervision

{PR-202 implemented signals, PR-204, PR-205} ──► PR-206 off-box alerts ──► PR-207 appliance ops
{PR-201, PR-202, PR-204, PR-302} ──► PR-303 deploy/rollback

All launch implementation ──► immutable candidate ──► PR-304 verification
  ──► PR-305 fault/soak ──► PR-306 final docs ──► production decision
```

### Execution waves and milestones

| Wave | Parallel work allowed | Milestone exit criteria |
|---|---|---|
| 0 — Contain and baseline | Operator-only PR-001 containment can run while PR-000 creates the intentional release baseline. PR-002 scope decisions can be prepared but merge after PR-000. | **M0 — Controlled baseline:** PR-000 is complete; containment state is recorded; PR-002 launch scope and owners are explicit. |
| 1 — Establish independent foundations | PR-101, PR-102, PR-104, PR-201, PR-301, and tracked PR-001 integration may run in parallel. PR-105 and PR-205 may start as soon as PR-001 is merged. | **M1 — Foundation contracts fixed:** media-grant, worker-auth, backup snapshot, supply-chain, trusted-proxy, and host-supervision contracts are reviewed and their owning workstreams can build on them without redesign. |
| 2 — Build dependent controls | PR-103 after PR-101; PR-202 and PR-203 after PR-201; PR-204 after PR-101 and PR-102; PR-302 after PR-301. These four lanes may run concurrently. Complete PR-105 and PR-205 during this wave. | **M2 — Launch controls implemented:** PR-101–PR-105, PR-201–PR-205, and PR-301–PR-302 have complete implementations and passing pre-candidate checks; hardware-only acceptance evidence may remain for M4; unresolved integration conflicts are closed. |
| 3 — Integrate operations and deployment | PR-206 and PR-303 may run in parallel once their respective dependencies are met. PR-207 implementation follows PR-206; PR-306 drafting continues. | **M3 — Candidate-capable system:** off-box alerts and appliance operations are proven; a signed, encrypted-backup-aware deployment can roll back all changed tiers; all prerequisite P0/P1 implementation is merged. |
| 4 — Freeze and prove | Create one immutable manifest-named candidate, then run PR-304, fix/rebuild if necessary, run PR-304 again, and only then run PR-305 against the unchanged passing candidate. Finalize PR-306 after evidence is stable. | **M4 — Production decision:** PR-304 and PR-305 pass against the same candidate; PR-306 matches that release; every remaining P1 has either closed or received explicit risk acceptance. |

### Shared components and merge coordination

These files and contracts make otherwise parallel work likely to conflict. A
single integration owner should serialize changes in the listed order; parallel
branches should rebase after each predecessor merges.

| Shared file or contract | Items | Merge or coordination order |
|---|---|---|
| `deploy/docker-compose.yml` and network topology | PR-001, PR-102, PR-202, PR-205; later PR-403 | PR-001 → PR-102 → PR-202 → PR-205. Keep PR-403 post-launch. |
| `deploy/mediamtx.yml` and WHEP exposure | PR-001, PR-101, PR-103 | PR-001 containment → PR-101 authenticated grants/origins → PR-103 HTTPS-only transport. |
| `server/app/routes/_internal.py` and worker metric wire shape | PR-102, PR-204 | PR-102 auth/route separation → PR-204 probe fields, with worker/server/client contract tests updated as one change. |
| Metrics, Grafana, and alert rules | PR-105, PR-204, PR-206 | PR-105 access boundary → PR-204 final probe metrics → PR-206 receivers and alert drills. |
| Backup services and `server/app/routes/control.py` | PR-201, PR-202, PR-203; later PR-401 | PR-201 defines the consistent snapshot/manifest interface. PR-202 and PR-203 may branch in parallel, but reconcile manually before merge; PR-401 consumes the stabilized interface later. |
| Release manifests, build scripts, and workflows | PR-000, PR-301, PR-302, PR-303; later PR-401 | PR-000 clean-source rule → PR-301 pinned inputs/SBOM → PR-302 signed manifest → PR-303 deployment transaction. |
| Android build and network configuration | PR-103, PR-206, PR-302 | PR-103 owns cleartext/network removal; PR-302 owns version/signing. PR-206 owns only the health-monitor alert path. Rebase PR-302 after PR-103 before candidate signing. |
| Operator documentation | PR-002, PR-207, PR-306; later PR-405 | PR-002 defines supported scope. PR-207 may draft procedures, but PR-306 is the final authority after proof; PR-405 changes named-face claims only after its evidence exists. |

### Work that must remain sequential

- PR-000 precedes all tracked implementation merges. Runtime-only PR-001
  containment is the sole exception.
- PR-101 precedes PR-103; PR-101 and PR-102 both precede PR-204.
- PR-201 precedes PR-202 and PR-203. PR-202 and PR-203 are concurrent only after
  that common snapshot/manifest contract is merged.
- PR-202, PR-204, and PR-302 all precede PR-303. PR-206 separately waits for
  PR-202, PR-204, and PR-205.
- PR-207 final drills wait for PR-202 and PR-206.
- Integration freeze, immutable candidate creation, PR-304 verification, PR-305
  fault/soak testing, PR-306 final reconciliation, and the production decision
  occur in that order. Any candidate-changing fix invalidates downstream
  evidence and restarts the sequence at candidate creation.
- Post-launch PR-401 reuses PR-302/PR-303 contracts and waits for their live
  release evidence; it must not run in parallel with the initial production
  decision.

## Production decision checklist

The constrained release is production-ready only when all of the following are
true:

- [ ] Every P0 item is `Done`.
- [ ] Every P1 item is `Done`, or a written risk acceptance names the owner,
      expiry, mitigation, and follow-up item.
- [ ] Live video cannot be read anonymously.
- [ ] Worker/control endpoints cannot be reached by remote clients.
- [ ] No authenticated cleartext transport remains.
- [ ] OTA is disabled.
- [ ] A clean signed release can be reproduced and identified on Jetson/phone.
- [ ] A failed multi-tier deployment returns to the previous healthy release.
- [ ] An encrypted off-device backup has been restored successfully.
- [ ] Camera, server, storage, network, reboot, and alert drills have passed.
- [ ] The final hardware soak has passed without an investigate/fail verdict.
- [ ] The EOL platform risk and physical-security threat model have explicit
      operator decisions.

## Evidence log

Add compact entries here when an item changes to `Awaiting evidence` or `Done`.
Do not paste secrets, cookies, tokens, SDP, private IP details, camera frames, or
recordings.

| Date | Item | Artifact/revision | Evidence | Result |
|---|---|---|---|---|
| 2026-07-13 | Roadmap baseline | `266fe7e` plus dirty working tree | Static repository assessment; no implementation or live activation performed | Roadmap created |
| 2026-07-13 | PR-000 | `release/pr-000-clean-baseline`; tag `pr-000-verified-20260713`; `pr000-verification/manifest.json` | Clean/dirty regression gate; 55 OTA tests passed with 2 expected skips; manifest Git SHA, source fingerprint, `dirty:false`, and artifact checksum verified; original dirty checkout preserved | Done |
| 2026-07-13 | PR-001 | `release/pr-001-containment`; `67c8e5f` | Compose topology and containment regressions passed; 55 OTA tests passed with 2 documented skips; Prometheus config and 5 alerts validated; separate LAN/tailnet probes denied every direct service port while HTTPS health passed; live Jetson decoded one RTSP and one WHEP 1280x720 frame; OTA environment and typed rejection verified; original dirty checkout preserved | Done |
| 2026-07-13 | PR-002 | `release/pr-002-launch-scope`; `d3d774c` | Focused People, Training, Danger Zone, Settings, and optional-hardware suites passed (199 tests); full client suite passed serially (1,613 tests), plus lint, typecheck, and production build; server OTA containment/typed-disabled checks passed (6 selected tests); direct claim audit found no supported-feature overclaim; no phone install or Jetson activation was required or performed | Done |
| 2026-07-13 | PR-101 | `release/pr-101-media-grants`; `24a7a0d` | Missing, wrong-scope, expired, replayed, unknown-path, and anonymous grant checks passed; full server (1,326 passed) and client (1,618 passed) suites, lint, typecheck, production build, mobile/desktop journeys, and WHEP reconnect harness passed. MediaMTX v1.18 loaded the finite-origin configuration. The deployed Jetson accepted authenticated WHEP and denied ungranted reads; the live harness decoded every rung and reconnect/resume scenario; the physical phone presented frames on UHQ, HQ, Data-saver, and Ultra-low while quality switches closed the prior session and established the exact new path. Raw grants were absent from URLs, logs, state, telemetry, and retained evidence; temporary verification accounts were removed; server, MediaMTX, detection, RTSP, and HTTPS health were green after activation. | Done |
