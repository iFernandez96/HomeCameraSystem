## Codex Round 1 Critique

### Inventory Misses

The draft undercounts “features” that can silently break production:

- **Service worker cache/update semantics**: `client/src/sw.ts` caches `/api/events*` and precaches app shell. A bad SW can serve stale event history or strand clients on old code.
- **WebSocket event bus under load**: `server/app/services/event_bus.py` drops per-subscriber events when queues fill; tests cover unit overflow, not real browser fanout/backpressure.
- **SQLite under concurrent writes/reads**: `events_db` uses connection-per-call + WAL, but the proof is synthetic temp DBs, not the live event cadence plus UI search/count/unread polling.
- **Systemd/sudo interactions**: `homecam-detect.service`, watchdog recovery, `sudo -n systemctl restart ...`, `sd_notify`, restart limits, and Docker oneshot behavior are production features.
- **Health/status truthfulness**: `/api/status`, heartbeat, stalled-frame detection, worker gear, CPU/temp probes can make broken capture look healthy.
- **Training/export/person capture flows**: face/person captures, sidecars, purge, consent, and ZIP normalization exist beyond “face recognition.”
- **Snapshot latest/thumb unauth carve-out**: push hero images depend on `/snapshots/thumb_*.jpg` serving without auth.
- **Camera registry/adaptive MediaMTX paths**: `HOMECAM_CAMERAS`, `/api/cameras`, WHEP path selection, legacy `cam1` normalization.
- **Control-plane stubs**: reboot/backup/restore/update return `ok: true` with “stubbed”; treating those as shipped features is dangerous.

### Ranked Gaps

Ranked by silent-production-breakage risk x real-fixture feasibility:

1. **Push notifications E2E**: high silent failure, feasible with one real phone subscription.
2. **WebRTC/WHEP resilience**: live feed can fail while app looks fine; feasible against live MediaMTX + phone/Chromium.
3. **Auth/session lifecycle**: user already saw sign-outs; feasible with compressed TTL and real cookies.
4. **Retention + byte-budget evictor**: disk-full kills everything silently; feasible from real manifest.
5. **Snapshot/thumb pipeline**: push images/events UI silently degrade; feasible from real snapshots.
6. **Face recognition/capture/training**: high feature value, but privacy + dlib fixture capture make it slower.
7. **Export ZIP**: feasible, but breakage is usually visible to operator.
8. **Multicam**: important soon, lower current risk with one camera.
9. **OTA update flow**: currently stubbed; high future risk but no real implementation to prove.
10. **Backup/restore**: also stubbed; cannot honestly prove round-trip yet.

### Top 5 Contracts + Real Fixtures

1. **Push notifications**
Contract: real detection event with `{camera_id, person_name, ts, thumb_url, clip_url}` plus persisted real subscription -> `send_matching` delivers exactly matching subscriptions, prunes only 404/410, preserves transient failures, phone displays notification with image, click opens `/events?event=<id>`, dismiss POSTs seen.
Fixture: on phone, enable push once; pull `push_subs.json` only into an encrypted/local ignored fixture, or better run harness on Jetson. Capture event rows/thumbs via:
`deploy/fetch-jetson-data.sh homecam 8 3`
Then live-send a test payload through `/api/push/test` and an event-shaped payload through server push service with VAPID keys present.

2. **WebRTC/WHEP**
Contract: `/api/cameras` camera path -> client WHEP URL -> POST SDP to MediaMTX -> first video frame appears; quality/path switches close old PC; network drop recovers or surfaces retry; cellular gathers srflx/relay candidates.
Fixture: live Jetson MediaMTX plus real phone Chrome. Use Playwright for desktop, manual/ADB for phone. Capture server side:
`ssh homecam "sudo journalctl -u mediamtx -u homecam-server --since '-30 min' --no-pager"`
Use existing `deploy/soak/synthetic_load.sh` for a second RTSP path.

3. **Auth/session lifecycle**
Contract: access expiry -> refresh succeeds without route failure; refresh expiry/deleted user -> UI transitions to login; WS closes 1008 and does not reconnect-storm; HttpOnly cookies keep correct path/secure semantics.
Fixture: run server with `ACCESS_TOKEN_TTL_S=5 REFRESH_TOKEN_TTL_S=20 COOKIE_SECURE=false`, real browser login, sleep across boundaries, assert `/api/status`, `/api/events/ws`, and route navigation behavior.

4. **Retention/eviction**
Contract: given real recordings dir with mtimes/sizes and current free bytes, startup `sweep_and_evict` deletes expired clips first, then oldest clips until `SERVER_MIN_FREE_BYTES`, never touches non-mp4, sidecars follow safe policy, worker floor remains higher than server floor.
Fixture:
`ssh homecam "find /home/israel/HomeCameraSystem/recordings -maxdepth 1 -type f -printf '%f\t%s\t%T@\n' | sort -k3n" > .jetson-snapshot/recordings.manifest.tsv`
Also capture `df -B1 /home/israel/HomeCameraSystem/recordings`.

5. **Snapshot/thumb pipeline**
Contract: worker writes `latest.jpg` and `thumb_<ms>.jpg`; event `thumb_url` points to real JPEG; unauth `/snapshots/thumb_<digits>.jpg` serves bytes; auth `/api/snapshots/*` gates other images; retention does not delete the thumb before notification render.
Fixture:
`rsync -av homecam:/home/israel/HomeCameraSystem/snapshots/ .jetson-snapshot/proof_fixtures/snapshots/`
Pair with real events DB rows where `thumb_url IS NOT NULL`.

### Mock-Hollow Tests

- `client/src/lib/webrtc.test.ts`: mocks `RTCPeerConnection` and `fetch`; proves lifecycle logic, not MediaMTX, ICE, first frame, cellular, or video rendering.
- `client/e2e/tests/push.spec.ts`: explicitly has no real PushManager subscription; `/api/push/test` returns `sent: 0`.
- `server/tests/test_push_service.py`: `webpush` is mocked; does not hit FCM/APNs/Mozilla gateways or phone display/click paths.
- `client/src/sw.test.ts`: mocks Workbox and SW globals; does not prove install/update/cache behavior.
- `client/src/__viewport__/viewport.test.tsx`: comments say API, status, push, VideoTile/WHEP are stubbed.
- `detection/tests/test_recognizer.py` and `test_detector.py`: mostly graceful-degrade/mocked cv2/numpy paths; not real dlib embeddings from household images.
- `server/tests/test_recording_service.py`: fake disk usage and tiny files; not real SD-card pressure, open visit interaction, or ffmpeg temp amplification.
- `server/tests/test_events_db.py`: temp SQLite and serial operations; not concurrent worker writes plus UI search/count/unread load on the live DB.
- `server/tests/test_snapshots_route.py`: fake JPEG bytes; proves routing/auth carve-out, not actual worker JPEG encode/write/retention.
- `server/tests/test_real_snapshot.py`: good direction, but narrow: only schema and `clip_url` pattern. It is not a proof of event search, concurrency, snapshots, or clip existence.
