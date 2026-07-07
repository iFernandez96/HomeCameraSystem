# Live View Reliability, Latency & Observability Plan

Drafted 2026-07-07 from three GPT-5.5 (codex) design sessions + a code-level defect hunt + real-device fuzzing on a Galaxy S24 Ultra. Status: DESIGN for approval — except the "Already fixed" section, which shipped today.

## 1. What "up" means (the guarantee)

**Live-view availability** = a WHEP POST answers 2xx AND a decoded first frame arrives within **8 s** of request. Track per rung (cam / cam_lq / cam_uq): p50/p95 time-to-first-frame (TTFF), timeout rate, consecutive-failure count.

Layered guarantee — each layer has one watcher and one recovery action:

| Layer | Detector | Recovery | Exists today? |
|---|---|---|---|
| Worker process alive | systemd `Type=notify` + `WatchdogSec=90` | systemd restart | yes |
| Capture wedged (no frames into worker) | mediamtx_watchdog frame-freshness | persisted ladder: mediamtx ×2 → nvargus ×2 → reboot | yes (clock-jump hardened today) |
| Stream stale at server (worker up, frames stale) | `seconds_since_last_frame` in heartbeat | NEW: after N×stale threshold, watchdog restarts mediamtx via existing ladder rung (do not add a second ladder) | partial (detected, not acted on) |
| WHEP reachable end-to-end | NEW synthetic probe (below) | restart mediamtx on local-probe failure; cellular-only failures alert, never restart camera | no |
| Server container down, camera fine | systemd `homecam-server` unit health | systemd restart; report separately from camera health | partial |
| Client-side truth | TTFF metrics + client_log ship | manual Retry (policy) + stale-pill reconnect (shipped today) | shipped today |

**Synthetic WHEP probe** (the one new moving part): a low-duty host-side probe on the Jetson — every 60 s against `cam`, every 5–10 min against adaptive rungs. One short recv-only WebRTC session, closed on first RTP packet (no decode — no CPU cost that matters on the Nano; serialize probes, never concurrent). Feeds `/metrics` + `/api/status`: `whep_probe_last_ok_ts`, `whep_probe_ttff_ms`, `whep_probe_fail_reason`, `whep_probe_consecutive_failures`. Probe failures with local network OK → mediamtx restart through the existing ladder (persisted, cooldown-respecting). This closes the "MediaMTX answers but no media flows" blind spot the current stack cannot see.

## 2. First-frame latency

Codex-corrected budget (the live path already runs `iframeinterval=8` ≈ 133 ms GOP at 60 fps — the notorious 4.3 s GOP is the RECORDED segment path, not live join):

| Stage | Today (est.) | Target | How |
|---|---|---|---|
| Mount → WHEP POST | ~0–50 ms warm / 50–2500 ms cold | warm ≥90% of connects | Warmup exists (auth→mount). ADD: re-warm on rung switch + after tile error, so retry/rung paths are warm too |
| ICE gathering (cold) | ≤2500 ms cap, usually ≈STUN RTT | resolve on FIRST srflx | Early-exit when a srflx candidate appears instead of waiting for `complete` (cellular needs srflx only); keep the 2500 ms cap as backstop. Behind a kill switch + measured before/after |
| WHEP POST → answer | 1 RTT | — | fine |
| ICE connect + DTLS | 100–500 ms | — | fine (LAN host or srflx path) |
| First decodable frame | ≤~133 ms (GOP 8 @ 60fps) | — | already short; do NOT rely on MediaMTX keyframe-on-demand (unverified) |
| Decode → render | ~1 frame | measured | `requestVideoFrameCallback` marks true first paint |

Ranked optimizations: (1) srflx early-exit — biggest cold-path win, low risk with kill switch; (2) warm-on-retry/rung-switch; (3) nothing else until measurements justify it.

## 3. Observability — "triage in one grep"

Principle: every stage of the live path emits `operation + reason + ids`, rate-limited on hot paths, secrets/IP-safe (candidate COUNTS, never SDP). Three sinks already exist (client_log → journald, worker heartbeat metrics whitelist, server logging) — we add FIELDS, not new infrastructure.

**Client (new `lib/liveMetrics.ts`)** — per connection attempt, one INFO log + ship():
`webrtc:attempt {attempt_id, rung, warm|cold, trigger: mount|retry|rung|resume}` then a single summary on settle:
`webrtc:settled {attempt_id, outcome: first-frame|error|aborted, ttff_ms, ice_ms, whep_rtt_ms, first_frame_via_rvfc_ms, candidates: {host,srflx,relay}, error_stage?}`.
TTFF breakdown timestamps: t0 attempt, t1 localDescription set, t2 gathering settled (+reason complete|srflx-exit|timeout), t3 POST sent, t4 answer applied, t5 ontrack, t6 first `requestVideoFrameCallback`. Error/warn levels ship automatically (existing log.ts); INFO summaries ship at a sampled rate (1:1 initially, revisit if journald noisy).

**Worker heartbeat additions** (extend `_ALLOWED_METRIC_FIELDS` + 3-way contract test): `whep_probe_ttff_ms`, `whep_probe_consec_fails`, `stream_stale_restarts`. (Watchdog ladder level + last action are already observable via logs; add `watchdog_level` gauge for the Settings health card.)

**Server**: log WHEP-relevant nginx/MediaMTX-adjacent events it can see (status transitions of worker_alive / stream freshness with reasons + clamped ages — clamping shipped today).

**Perf surfacing**: Settings → Jetson health card gains a "Live view" block: last TTFF, p95 TTFF (24 h), probe status lamp, watchdog ladder level. Anything red on this card names its reason string — the same string greppable in journald. Fast triage = UI reason → `journalctl | grep <reason>`.

## 4. Defects found & fixed today (GPT-5.5 hunt + device fuzz)

Shipped (commits b4e3a58..HEAD):
- ws.ts stale-socket handler races (dup sockets / wrong-socket close)
- watchdog clock-jump suppression + corrupt `last_reboot_at` TypeError at the reboot rung
- /api/status negative ages / false-dead worker on clock jumps (monotonic + clamps, wire shape unchanged)
- stale-stream pill now an actual reconnect control; in-flight WHEP abort on unmount/rung-switch; stale-ontrack srcObject guard; coalesced resume reconnect (in review)
- Full device-fuzz UI findings list: `.superpowers/sdd/fuzz-findings.md` (F1–F18; all fixed or in flight)

## 5. Implementation order (pending approval)

1. `lib/liveMetrics.ts` + webrtc.ts/VideoTile instrumentation (client-only, ships with next client deploy)
2. Settings "Live view" health block + heartbeat metric additions (wire-contract-sync: 3-way)
3. Synthetic WHEP probe service on the Jetson host + stream-stale → ladder action (operator-side deploy; needs Jetson on)
4. srflx early-exit + warm-on-retry (measured against #1's TTFF data, kill switch env)

Each step is independently shippable; #1 first so #4 has before/after numbers.
