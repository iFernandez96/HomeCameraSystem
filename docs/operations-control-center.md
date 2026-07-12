# Operations control center

The owner-only **Settings → Control center** page combines the existing camera
policy, recording assurance, event database, incident system, automation engine,
and push service. It does not create a second capture or detection pipeline.

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
to sync without both the mount and marker; it never silently falls back to the
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
