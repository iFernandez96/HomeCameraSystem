// iter-282 (test-coverage gap #1+#2): pure helpers extracted from
// `client/src/sw.ts` so the push-handler logic can be unit-tested
// without spinning up a real ServiceWorkerGlobalScope. The SW
// itself just wires `event.data.json()` + `self.registration` to
// these functions; the real-world contract is unchanged.
//
// We deliberately avoid importing `workbox-core` / `workbox-precaching`
// here because those depend on a real SW global. Tests that import
// `sw.ts` would have to mock them; tests that import this module
// don't.

export type PushPayload = {
  title?: unknown
  body?: unknown
  /** Per-event tag (iter-275/276 server side). Falls back to `id`,
   *  then `data.tag`, finally the literal "event" for test pushes. */
  event_id?: unknown
  id?: unknown
  tag?: unknown
  url?: unknown
  /** iter-188 hero image — the detection thumbnail URL. Chrome /
   *  Edge / Firefox render it; Safari ignores. Absent when the
   *  worker emitted no thumb_url. */
  image?: unknown
  /** iter-276 server-side. Server refreshes from events_db on every
   *  fanout; SW forwards to setAppBadge so a closed PWA's badge
   *  doesn't stale. */
  unread_count?: unknown
}

/** Build the `(title, NotificationOptions)` arg pair for
 *  `self.registration.showNotification`. The returned options carry
 *  the iter-275 per-event `tag` + iter-280 `renotify: true` so
 *  detection bursts stack instead of silently collapsing.
 */
export function buildNotification(
  data: PushPayload,
): { title: string; options: NotificationOptions } {
  const title = typeof data.title === 'string' ? data.title : 'Home Camera'
  const body = typeof data.body === 'string' ? data.body : 'New event'
  // iter-275 per-event tag fallback chain.
  const tag =
    (typeof data.event_id === 'string' && data.event_id) ||
    (typeof data.id === 'string' && data.id) ||
    (typeof data.tag === 'string' && data.tag) ||
    'event'
  const url = typeof data.url === 'string' ? data.url : '/events'
  const image = typeof data.image === 'string' ? data.image : undefined

  const options: NotificationOptions = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag,
    // iter-332: include event_id in data so the iter-332
    // notificationclick "Mark seen" branch can POST
    // /api/events/{id}/seen without re-parsing the tag fallback
    // chain. URL stays for the default click destination.
    data: { url, event_id: tag },
  }
  if (image) {
    ;(options as unknown as { image: string }).image = image
  }
  // `renotify` is on the spec but not in lib.dom.d.ts. Same cast
  // pattern as `image` above.
  ;(options as unknown as { renotify: boolean }).renotify = true
  // iter-332 (missing-feature #2, Notification Action Buttons):
  // inline View / Mark seen actions. Android Chrome renders both
  // as buttons under the notification body; iOS Safari 16.4 ignores
  // `actions` entirely (silent degradation — the tap-body fallback
  // continues to work via the iter-? notificationclick handler).
  // Only emit actions when the tag is a real event_id (the "event"
  // fallback indicates a test push or malformed payload that can't
  // be marked seen).
  if (tag !== 'event') {
    ;(options as unknown as { actions: NotificationAction[] }).actions = [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Mark seen' },
    ]
    // iter-342 (widget-usability C2 from iter-333 broad audit):
    // requireInteraction keeps the notification pinned in the shade
    // until the user explicitly acts on it (taps body or an action
    // button). Without this, Android Chrome auto-dismisses after
    // ~5s and the user never sees the iter-332 action buttons in
    // the brief render window. iOS 16.4 silently ignores both
    // `actions` and `requireInteraction` — graceful no-op there.
    ;(options as unknown as { requireInteraction: boolean })
      .requireInteraction = true
  }
  return { title, options }
}

/** iter-332: shape of the per-action object exposed via the
 *  Notifications spec. lib.dom.d.ts has `NotificationAction` since
 *  TS 5.4 but older typings may not — declare locally to be safe. */
type NotificationAction = {
  action: string
  title: string
  icon?: string
}

/** Apply `setAppBadge(unread_count)` (or `clearAppBadge()` for 0)
 *  via the SW's registration. Browser support varies; we no-op
 *  silently when the API is missing OR when the call rejects (e.g.
 *  feature flag disabled). Returns void — the badge is a UI side-
 *  effect and MUST NOT delay the notification itself, so callers
 *  intentionally don't `event.waitUntil(...)` on it.
 */
export function applyBadge(
  registration: {
    setAppBadge?: (count: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  },
  payload: PushPayload,
): void {
  const unread = payload.unread_count
  if (typeof unread !== 'number' || unread < 0) return
  const op =
    unread === 0
      ? registration.clearAppBadge?.()
      : registration.setAppBadge?.(unread)
  if (op) {
    op.catch(() => {
      // Browser without the API throws TypeError; silent.
    })
  }
}

/** Parse a push event's data into a PushPayload object. Handles
 *  the JSON-or-text fallback the iter-188 SW already used. */
export function parsePushData(
  event: { data?: { json: () => unknown; text: () => string } | null },
): PushPayload {
  if (!event.data) return {}
  try {
    const parsed = event.data.json()
    if (parsed && typeof parsed === 'object') return parsed as PushPayload
    return {}
  } catch {
    try {
      return { body: event.data.text() }
    } catch {
      return {}
    }
  }
}
