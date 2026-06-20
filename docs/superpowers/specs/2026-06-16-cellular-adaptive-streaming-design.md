# Cellular-first adaptive streaming — design

**Date:** 2026-06-16
**Status:** Approved (design); pending spec review
**Motivation:** Viewing the live feed over cellular is a primary use case. The
current single 720p/2.5 Mbps CBR stream has no adaptive bitrate, so on a slow
or Tailscale-relayed cellular path it stalls or never starts. We want cellular
to work *nicely* without degrading the LAN/Wi-Fi experience.

## Goal

Offer three quality tiers of the live feed, auto-selected by the client's
connection with a manual override. Keep the existing 720p stream untouched for
LAN. Add lower-bitrate variants for cellular, transcoded on the Nano on demand
(zero idle cost).

## Non-goals

- Fixing Tailscale CGNAT / relay path in code. Low bitrate is the practical
  mitigation for a relayed path; "force a direct path" stays operator guidance.
- Two-way audio, recording changes, or any camera-side capture change.
- Per-user or per-device quality persistence on the server. Selection is a
  client-local preference (`localStorage`).

## Architecture

Three MediaMTX paths, **all derived from the one published camera stream**. The
transcodes consume the already-published `cam` RTSP stream — they do **not** add
a second `nvarguscamerasrc` or a GStreamer `tee`, so the single-owner-libargus
rule in CLAUDE.md is preserved.

| Path             | Resolution | Bitrate   | fps | Source                         |
|------------------|------------|-----------|-----|--------------------------------|
| `cam` (existing) | 1280×720   | 2.5 Mbps  | 30  | publisher (unchanged)          |
| `cam_lq` (new)   | 854×480    | ~700 kbps | 24  | on-demand transcode of `cam`   |
| `cam_uq` (new)   | 640×360    | ~400 kbps | 15  | on-demand transcode of `cam`   |

### Transcode pipeline (server, on Jetson host)

Each new path is launched by MediaMTX `runOnDemand` and torn down by
`runOnDemandCloseAfter` once no readers remain — so a transcode only runs while
a phone is actually watching that tier; idle Nano cost is zero.

GStreamer (proven Jetson HW elements; ffmpeg on Jetson needs a special L4T
build, so we avoid it):

```
gst-launch-1.0 rtspsrc location=rtsp://localhost:8554/cam latency=0 !
  rtph264depay ! h264parse ! nvv4l2decoder !            # NVDEC
  nvvidconv ! 'video/x-raw(memory:NVMM),width=854,height=480' !
  nvv4l2h264enc insert-sps-pps=true iframeinterval=24 control-rate=1 \
    bitrate=700000 vbv-size=700000 peak-bitrate=900000 \
    EnableTwopassCBR=false maxperf-enable=true !
  h264parse ! rtspclientsink location=rtsp://localhost:8554/cam_lq
```

`cam_uq` is the same with 640×360, `bitrate=400000`, `iframeinterval=15`, and a
matching framerate cap (`videorate`/caps `framerate=15/1`) to hold fps down.

Encoder tuning mirrors the existing `cam` encode style (CBR, single-pass,
short keyframe gap, bounded VBV) so behaviour under motion is predictable.

### Client

- New quality preference state: `auto | hq | sd | xs`, persisted in
  `localStorage` (key e.g. `homecam:streamQuality`), default `auto`.
- **Auto resolution** via `navigator.connection`:
  - `saveData === true` → `cam_uq`
  - `type === 'cellular'` or `effectiveType` in `{'slow-2g','2g'}` → `cam_uq`
  - `effectiveType === '3g'` → `cam_lq`
  - Wi-Fi / ethernet / `4g` / API unavailable (iOS Safari) → `cam` (HQ)
- Manual override: a quality control in `VideoTile` (Auto / HQ / Data-saver /
  Ultra-low). Selecting a tier maps to a path and re-runs the WHEP connect.
- WHEP URL composition extends today's `${origin}/whep/cam/whep` to
  `${origin}/whep/<path>/whep` where `<path>` ∈ `{cam, cam_lq, cam_uq}`. The
  Tailscale Serve `/whep/*` proxy forwards any path to MediaMTX :8889, so no
  new proxy config is needed.
- Transport config is unchanged: `iceServers: []`, single recv-only video
  transceiver, 250 ms LAN-fast ICE fallback. Only the path differs.
- Switching tiers tears down the current `WhepConnection` and connects the new
  path (same code path as the existing manual Retry).

## Data flow

```
Phone selects Data-saver
  → WHEP GET /whep/cam_lq/whep (same-origin, auth-protected)
  → MediaMTX sees first reader on cam_lq → runOnDemand spawns the gst transcode
  → transcode pulls rtsp://localhost:8554/cam, re-encodes, publishes cam_lq
  → WebRTC delivers ~700 kbps stream to the phone
  → phone disconnects → after runOnDemandCloseAfter, transcode process exits
```

First switch to a cellular tier incurs a ~1–2 s spin-up (accepted trade-off for
zero idle cost). Switching back to HQ is instant (cam is always published).

## Error handling

- If a transcode fails to start (e.g. NVENC session exhausted), MediaMTX yields
  no stream; the client's existing 8 s media-timeout + manual Retry path
  surfaces it as a connection error. No new error UI required, but the quality
  control should let the user fall back to another tier.
- iOS Safari / browsers without `navigator.connection`: Auto resolves to HQ;
  the manual override is the escape hatch.

## Risks / validation

1. **Nano headroom (must validate on device).** A transcode adds a 2nd NVDEC
   session + a 2nd NVENC session on top of detection (which already NVDEC-decodes
   `cam`) and the main `cam` NVENC encode. At 480p/360p low-bitrate, single
   viewer, on-demand, this is expected to fit — but it requires a `tegrastats`
   measurement under load before declaring done. **Operator-side verification.**
2. **Tailscale relay** (`relay "sfo"` observed) is the deeper transport issue.
   Low bitrate makes a relayed path usable; document "toggle Tailscale / prefer
   Wi-Fi to force a direct path" as operator guidance.
3. **CLAUDE.md audit risk.** A future camera-library/algorithm audit might flag
   "second encode path." Document inline in `mediamtx.yml` that the transcodes
   consume the *published* stream, not the camera — compliant by construction.

## Testing

- Client unit tests:
  - quality auto-resolution logic (table-driven over `navigator.connection`
    shapes, including the missing-API case) — BDD-lite Given/When/Then.
  - WHEP URL composition for each tier (`/whep/cam_lq/whep`, etc.).
  - quality preference persistence (localStorage round-trip + default).
- `mediamtx.yml` config-shape assertion (paths present, on-demand + closeAfter
  set) — lightweight, matches existing config-pinning style.
- No new server route → no server wire-contract test, but note the WHEP path
  surface in the client tests per the wire-symmetry rule.

## Out of scope for this slice (possible follow-ups)

- WebRTC simulcast / SVC (single encode advertises multiple layers) — not
  supported cleanly by `nvv4l2h264enc` + MediaMTX WHEP today.
- Server-driven adaptive bitrate (auto-downshift mid-stream on packet loss).
- Always-running transcodes for instant switching (constant Nano load).
