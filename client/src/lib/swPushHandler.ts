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
  importance?: unknown
  require_interaction?: unknown
  silent?: unknown
  /** Optional server-selected notification action codes. */
  actions?: unknown
  deterrence_duration_s?: unknown
  /** One-use server capability proving this specific push reached display. */
  receipt_id?: unknown
}

export type PushActionCode =
  | 'view'
  | 'dismiss'
  | 'protect'
  | 'talk'
  | 'light'
  | 'warning'
  | 'siren'

const ACTION_TITLES: Record<PushActionCode, string> = {
  view: 'View',
  dismiss: 'Mark seen',
  protect: 'Protect clip',
  talk: 'Talk',
  light: 'Turn on light',
  warning: 'Play warning',
  siren: 'Sound siren',
}

function actionCodes(value: unknown): PushActionCode[] {
  if (!Array.isArray(value)) return []
  const result: PushActionCode[] = []
  for (const item of value) {
    const code = item === 'mark_seen' ? 'dismiss' : item
    if (
      typeof code === 'string' &&
      Object.hasOwn(ACTION_TITLES, code) &&
      !result.includes(code as PushActionCode)
    ) {
      result.push(code as PushActionCode)
    }
  }
  return result
}

type PushReceiptFields = {
  hasImage: boolean
  imageIsString: boolean
  hasEventId: boolean
  shown: boolean
  err?: string
}

type PushReceiptBaseFields = Omit<PushReceiptFields, 'shown' | 'err'>
type PendingPushReceipt = PushReceiptBaseFields & { receiptId?: string }

const pendingPushReceipts: PendingPushReceipt[] = []
let showNotificationHookInstalled = false

function pushReceiptBaseFields(data: PushPayload): PendingPushReceipt {
  return {
    hasImage: Object.prototype.hasOwnProperty.call(data, 'image'),
    imageIsString: typeof data.image === 'string',
    hasEventId:
      (typeof data.event_id === 'string' && data.event_id.length > 0) ||
      (typeof data.id === 'string' && data.id.length > 0),
    ...(typeof data.receipt_id === 'string' && data.receipt_id.length >= 24
      ? { receiptId: data.receipt_id }
      : {}),
  }
}

function errorName(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'Error'
}

export function reportPushReceived(
  data: PushPayload,
  shown: boolean,
  err?: unknown,
): void {
  publishPushReceipt(pushReceiptBaseFields(data), shown, err)
}

function sendCorrelatedReceipt(receiptId: string | undefined, shown: boolean): void {
  if (!receiptId) return
  try {
    const sw = globalThis as unknown as { fetch?: typeof fetch }
    if (!sw.fetch) return
    void sw.fetch('/api/_internal/push-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ receipt_id: receiptId, shown }),
    }).catch(() => {
      // A receipt is observability only; it must never delay notification UI.
    })
  } catch {
    // Constrained service-worker contexts may reject fetch synchronously.
  }
}

function publishPushReceipt(receipt: PendingPushReceipt, shown: boolean, err?: unknown): void {
  const { receiptId, ...safeFields } = receipt
  sendPushReceivedLog({
    ...safeFields,
    shown,
    ...(err ? { err: errorName(err) } : {}),
  })
  sendCorrelatedReceipt(receiptId, shown)
}

function sendPushReceivedLog(fields: PushReceiptFields): void {
  try {
    const sw = globalThis as unknown as {
      fetch?: typeof fetch
      navigator?: { onLine?: boolean; userAgent?: string }
    }
    if (!sw.fetch) return
    void sw.fetch('/api/_internal/client_log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        level: 'info',
        event: 'sw:push-received',
        fields,
        online: sw.navigator?.onLine ?? false,
        ua: sw.navigator?.userAgent?.slice(0, 240) ?? '',
      }),
    }).catch(() => {
      // best-effort: a failed client_log POST must be silent
    })
  } catch {
    // fetch can throw synchronously in constrained SW contexts; ignore.
  }
}

function installShowNotificationReceiptHook(): void {
  if (showNotificationHookInstalled) return
  showNotificationHookInstalled = true

  try {
    const sw = globalThis as unknown as {
      registration?: {
        showNotification?: (
          title: string,
          options?: NotificationOptions,
        ) => Promise<void>
      }
    }
    const registration = sw.registration
    const showNotification = registration?.showNotification
    if (!registration || typeof showNotification !== 'function') return

    registration.showNotification = ((
      title: string,
      options?: NotificationOptions,
    ) => {
      const receipt = pendingPushReceipts.shift()
      try {
        const op = showNotification.call(registration, title, options)
        if (receipt) {
          op.then(
            () => publishPushReceipt(receipt, true),
            (error: unknown) => publishPushReceipt(receipt, false, error),
          )
        }
        return op
      } catch (error) {
        if (receipt) {
          publishPushReceipt(receipt, false, error)
        }
        throw error
      }
    }) as typeof showNotification
  } catch {
    // Observability hook installation must never affect notification display.
  }
}

installShowNotificationReceiptHook()

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
  // A REAL detection event carries event_id/id; a user-directed notification
  // (e.g. "timelapse ready") carries only `tag`. eventId stays null for the
  // latter so the event-only "Mark seen" action below isn't attached (it
  // would otherwise POST /api/events/<tag>/seen with a non-event id).
  const eventId =
    (typeof data.event_id === 'string' && data.event_id) ||
    (typeof data.id === 'string' && data.id) ||
    null
  // iter-275 per-event tag fallback chain (eventId first so detection bursts
  // stack per-event; else the caller-supplied tag; else the generic default).
  const tag =
    (typeof data.tag === 'string' && data.tag) || eventId || 'event'
  const url = typeof data.url === 'string' ? data.url : '/events'
  const image = typeof data.image === 'string' ? data.image : undefined

  const options: NotificationOptions = {
    body,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag,
    // iter-332: event_id (only when a real event) lets the notificationclick
    // "Mark seen" branch POST /api/events/{id}/seen. null for non-event
    // notifications (timelapse), which have nothing to mark seen.
    data: {
      url,
      event_id: eventId,
      deterrence_duration_s:
        typeof data.deterrence_duration_s === 'number'
          ? data.deterrence_duration_s
          : 15,
    },
    silent: data.silent === true,
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
  // Only emit View / Mark-seen actions for REAL detection events (those
  // carry an event_id). A user-directed notification (timelapse ready /
  // failed) or a test push has no event to mark seen.
  if (eventId) {
    const requested = actionCodes(data.actions)
    const selected: PushActionCode[] =
      requested.length > 0 ? requested : ['view', 'dismiss']
    const maxActions = (() => {
      const ctor = globalThis.Notification as typeof Notification & { maxActions?: number }
      return typeof ctor?.maxActions === 'number' ? Math.max(0, ctor.maxActions) : 2
    })()
    ;(options as unknown as { actions: NotificationAction[] }).actions = [
      ...selected.slice(0, maxActions).map((action) => ({
        action,
        title: ACTION_TITLES[action],
      })),
    ]
    // iter-342 (widget-usability C2 from iter-333 broad audit):
    // requireInteraction keeps the notification pinned in the shade
    // until the user explicitly acts on it (taps body or an action
    // button). Without this, Android Chrome auto-dismisses after
    // ~5s and the user never sees the iter-332 action buttons in
    // the brief render window. iOS 16.4 silently ignores both
    // `actions` and `requireInteraction` — graceful no-op there.
    ;(options as unknown as { requireInteraction: boolean }).requireInteraction =
      data.require_interaction !== false
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
  if (!event.data) {
    pendingPushReceipts.push(pushReceiptBaseFields({}))
    return {}
  }
  try {
    const parsed = event.data.json()
    if (parsed && typeof parsed === 'object') {
      const data = parsed as PushPayload
      pendingPushReceipts.push(pushReceiptBaseFields(data))
      return data
    }
    pendingPushReceipts.push(pushReceiptBaseFields({}))
    return {}
  } catch {
    try {
      const data = { body: event.data.text() }
      pendingPushReceipts.push(pushReceiptBaseFields(data))
      return data
    } catch {
      pendingPushReceipts.push(pushReceiptBaseFields({}))
      return {}
    }
  }
}
