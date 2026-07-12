# Operations control center

The owner-only **Control Center** route at `/control` combines the existing camera
policy, recording assurance, event database, incident system, automation engine,
and push service. It is separate from preference-oriented Settings and does not
create a second capture or detection pipeline.

## Recording integrity jobs

The worker's JSON clip-state ledger remains the capture source of truth. The
server reconciles its 500 most recent events into the private
`recording-jobs.db` SQLite ledger every 30 seconds. That ledger preserves state
transitions, full `ffprobe` validation, capture-end-to-playback latency, and
plain-language failure details across worker and container restarts.

Only an MP4 with a real video stream may remain `available`. A final that fails
validation is marked failed and the exact event-owned corrupt file is removed;
the reconciler never deletes unrelated files. The manual camera test uses the
existing constrained host action to run the real RTSP
capture/decode/fsync/cleanup canary.

## USB recording guardian

The scheduled canary reports the host block device, mountpoint, filesystem,
read-only state, free space, fsync latency, and SMART verdict when available.
Production writers also require the `/srv/homecam-media` mount and marker. If
the USB drive disappears, writers stop rather than silently spilling private
footage onto the SD card. The Android wrapper independently checks both the
Tailscale and LAN health endpoints and notifies on outage and recovery.

## Household modes and schedules

Home, Away, Sleep, Vacation, and Privacy map to the existing detection worker
operating modes. Schedules are evaluated in the server's local timezone. A
schedule is idempotent within its matching minute and survives server restarts.

## Notification inbox

Each alert addressed to an authenticated subscription receives a durable inbox
row before push delivery. The row separately reports queued, gateway accepted,
gateway failed, displayed, display failed, or snoozed. A gateway acceptance is
never presented as proof that Android displayed the notification. Owner actions
can permanently retain the attached event or start an incident case.

## Retention

Clips use four explicit classes: ordinary, important, incident, and permanent.
Important clips receive the longer configured window. Incident and permanent
clips are excluded from age and disk-pressure deletion. Under disk pressure,
ordinary clips are considered before important clips. The UI previews upcoming
age deletions and measured bytes per class.

## Independent archive

Set `EXTERNAL_ARCHIVE_DIR` to a separately mounted NAS or host filesystem and
create an empty `.homecam-external-archive` marker at its root. HomeCam refuses
to sync without both the marker and a filesystem device distinct from the
recordings filesystem; it never silently falls back to the
recordings disk. Protected clips are copied atomically, SHA-256 verified, and
listed in a mode-0600 manifest. Source clips are not deleted by archive sync.
Use `deploy/docker-compose.archive.example.yml` as the opt-in Compose override;
the primary stack deliberately does not invent or auto-create an archive mount.

## Optional semantic companion

The companion is disabled by default and accepts only a private or loopback IP
literal. The token remains in the private mode-0600 security state and is never
returned to the browser. Queries are limited per user, responses are size
bounded, and all returned IDs are revalidated against the local event database.
The 2 GB Jetson does not run a heavyweight visual model.

Companion request contract:

```text
POST /v1/search
Authorization: Bearer <optional token>
{"query":"red backpack","limit":20}
```

Companion response contract:

```json
{"event_ids":["local-event-id"]}
```
