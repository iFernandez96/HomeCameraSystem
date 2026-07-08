# Notification tap -> exact event clip (client-side deep link)

UI/UX overhaul 2026-07-07. Scope: `client/src/sw.ts`, `client/src/pages/Events.tsx`, their tests. Server untouched (read-only investigation).

## Payload-chain findings (before this change)

1. **Server push payload** (`server/app/routes/_internal.py`, `_send_detection_push`, ~line 645): a real detection push already carries the event identity:
   - `"url": "/events"` (hardcoded list URL, not per-event)
   - `"event_id": evt.get("id")` (worker-generated uuid, always present)
   - plus `title`, `body`, `tag: "detection"`, optional `image` (thumb), `unread_count`.
   Non-event pushes differ: the test push in `routes/push.py` (~line 298) carries `url: "/settings"` and no `event_id`.
2. **SW push handler** (`lib/swPushHandler.ts::buildNotification`): stores `data: { url, event_id }` on the Notification; `event_id` is null for non-event pushes (timelapse ready, test push), which also gates the View / Mark seen action buttons.
3. **SW notificationclick** (`sw.ts`): `dismiss` action POSTs `/api/events/{id}/seen`; body tap / `view` focused an existing window and navigated to `data.url` — i.e. plain `/events`. **The event_id was dropped on the floor here**; the user landed on the list and had to hunt for the clip. (The "stale SW drops dismiss" pin is about old installed SWs lacking the action handler; `clientsClaim` + `skipWaiting` make a fresh dist take over immediately.)
4. **Client**: `Events.tsx` already had a `?person=` deep-link precedent (iter-326b) but nothing read an event id. `lib/api.ts` has **no fetch-single-event wrapper** because the server has **no GET /api/events/{id} route** and `/api/events/search` has **no id filter** (only camera_id / person_name / label / ts bounds / face_unrecognized). So the loaded recent list is the only client-side lookup surface. `api.ts` left untouched per the "only if a wrapper already exists server-side" rule.

## What shipped

- **`sw.ts`**: new exported pure helper `notificationClickTarget(data)` — for a real event (`event_id` present, not the generic `'event'` literal) it composes `<url>?event=<encoded id>` (`&` when the base already has a query); non-event notifications pass their `url` through; no data falls back to `/`. The body-tap/`view` branch now navigates to that target, and the iter-356.7 "skip navigate when already there" check compares `pathname + search` (pathname alone would have skipped the navigate on an already-open `/events` window and the clip would never open).
- **`Events.tsx`**: snapshots `?event=` once into a ref (same pattern as `_seededFilterRef`); once the initial fetch settles (`!loading && !error`) it strips the param via `history.replaceState` (so back/refresh cannot re-trigger), then auto-opens the ClipModal if the id is in the loaded list, else toasts: "That event is not in the recent list. It may have been removed." (info). State updates deferred out of the sync effect body (React 19 `set-state-in-effect` discipline). Mark-seen is already covered by the mount-time `markAllEventsSeen`.
- **Tests** (BDD-lite): new `client/src/sw.test.ts` (6 cases pinning the target mapping; workbox mocked at the import boundary) + 4 cases appended to `Events.test.tsx` (auto-open on deep link, param stripped, not-found toast + no dialog, no-param mount is inert).

## Verification

- `npm test -- --run src/sw.test.ts src/pages/Events.test.tsx`: 71/71 green.
- `npm run typecheck` and `npm run lint`: clean.

## Server-side follow-ups (not done here)

1. **(Optional, cosmetic)** `_internal.py` could emit `"url": "/events?event=<id>"` directly; the SW helper tolerates that (it appends with `&` or leaves an existing param alone) but composes the same thing itself, so nothing is required.
2. **(Real gap)** Deep links only resolve against the ~100 most-recent events. A notification tapped days later for a since-scrolled-off (but not deleted) event shows the "not in the recent list" toast even though the event still exists. Fix would be a `GET /api/events/{id}` route or an `id=` filter on `/api/events/search`, plus the mirrored `api.ts` wrapper + wire-contract test pins (`wire-contract-sync` skill). For the primary flow (tap within minutes of the push) the event is always in the first page.
3. Old installed SWs keep the pre-deeplink click handler until the fresh dist activates (immediate on next load thanks to `clientsClaim`); no action needed beyond the normal client deploy.
