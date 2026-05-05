import type {
  DetectionConfig,
  DetectionEvent,
  EventTracks,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PushFilters,
  ServerStatus,
} from './types'

const BASE = ''

/**
 * Thrown by `req<T>` for non-2xx responses. Same `.message` shape as the
 * previous plain-Error so existing `String(err).includes(...)` consumers
 * still work, but adds typed `.status` for callers that want to branch
 * on a specific code (e.g., the Live page's 503 → "no recent frame").
 */
export class HttpError extends Error {
  readonly status: number
  readonly path: string

  constructor(path: string, status: number, detail: string) {
    super(`${path} ${status}${detail}`)
    this.name = 'HttpError'
    this.path = path
    this.status = status
  }
}

// iter-181 (Auth Plan Phase 3): one inflight refresh promise so
// concurrent 401s don't fire N parallel /api/auth/refresh calls.
// Cleared in finally of `_attemptRefresh` so a fresh attempt is
// always possible after the previous one settles.
let _refreshInflight: Promise<boolean> | null = null

async function _attemptRefresh(): Promise<boolean> {
  if (_refreshInflight) return _refreshInflight
  const p = (async (): Promise<boolean> => {
    try {
      const res = await fetch(`${BASE}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      // iter-186 (Auth Plan Phase 7): refresh-401 means the
      // session is genuinely expired (refresh cookie expired or
      // the server invalidated it via secret rotation). Dispatch
      // a window-level signal so AuthProvider can toast + flip to
      // anon. Single-flight at the api.ts level (the `_refreshInflight`
      // dedupe above) ensures the signal fires at most once per
      // burst of 401s, avoiding toast spam when N concurrent
      // requests all 401 simultaneously. Other refresh failures
      // (network, 5xx) leave state alone — might be transient.
      if (res.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('homecam:session-expired'))
      }
      return res.ok
    } catch {
      return false
    }
  })()
  _refreshInflight = p
  try {
    return await p
  } finally {
    _refreshInflight = null
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // `credentials: 'include'` so the HttpOnly cookies set by /api/auth/login
  // (Phase 3) actually flow on subsequent requests. Phase 5 (iter-183) is
  // when the rest of /api/* starts requiring them — until then this is
  // additive and harmless.
  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  let res = await doFetch()
  // Silent refresh + single retry on 401, EXCEPT for the auth routes
  // themselves (login/refresh/logout/me) — recursing into refresh on
  // a refresh-401 would loop forever, and the AuthProvider in Phase 4
  // wants to see the raw 401 from /api/auth/me to know we're anonymous.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (await _attemptRefresh()) {
      res = await doFetch()
    }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      if (text) detail = `: ${text.slice(0, 200)}`
    } catch {
      // body unreadable — proceed with status only
    }
    throw new HttpError(path, res.status, detail)
  }
  return res.json() as Promise<T>
}

export const getStatus = (init?: RequestInit) =>
  req<ServerStatus>('/api/status', init)
export const fetchEvents = (limit = 100) =>
  req<DetectionEvent[]>(`/api/events?limit=${limit}`)

/**
 * iter-356.53 — fetch the per-event bbox-track sidecar. Returns
 * `null` on a 404 (legacy clip without a track sidecar — the
 * `ClipModal` falls back to today's static `event.boxes` overlay).
 * Other non-2xx still throw `HttpError` so a real outage surfaces.
 */
export async function fetchEventTracks(
  eventId: string,
): Promise<EventTracks | null> {
  const path = `/api/events/${encodeURIComponent(eventId)}/tracks`
  const res = await fetch(path, { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      if (body && typeof body.detail === 'string') detail = body.detail
    } catch {
      /* response wasn't JSON — keep statusText */
    }
    throw new HttpError(path, res.status, detail)
  }
  return (await res.json()) as EventTracks
}
// iter-220 (Feature #6 slice 6): cursor-paginated event search. Wraps
// the iter-219 `GET /api/events/search` route. All filters optional;
// `before_ts` is the cursor passed back from `next_cursor` on the
// previous page. Returns `{items, next_cursor}` — `next_cursor` is
// null on the last page so the caller knows to stop.
export type EventSearchFilters = {
  camera_id?: string
  person_name?: string
  label?: string
  since_ts?: number
  until_ts?: number
  before_ts?: number
  limit?: number
  /**
   * iter-228 (Feature #6 polish, closes iter-221 follow-up): when
   * true, server returns only events with `person_name IS NULL`
   * (no face match). When false, only events WITH a recognized
   * face. Mutually exclusive with `person_name=...` in practice
   * (both → 0 rows; not server-enforced).
   */
  face_unrecognized?: boolean
}
export type EventSearchResult = {
  items: DetectionEvent[]
  next_cursor: number | null
}
export const searchEvents = (filters: EventSearchFilters = {}) => {
  const params = new URLSearchParams()
  if (filters.camera_id) params.set('camera_id', filters.camera_id)
  if (filters.person_name) params.set('person_name', filters.person_name)
  if (filters.label) params.set('label', filters.label)
  if (filters.since_ts != null) params.set('since_ts', String(filters.since_ts))
  if (filters.until_ts != null) params.set('until_ts', String(filters.until_ts))
  if (filters.before_ts != null) params.set('before_ts', String(filters.before_ts))
  if (filters.limit != null) params.set('limit', String(filters.limit))
  if (filters.face_unrecognized != null)
    params.set('face_unrecognized', String(filters.face_unrecognized))
  const qs = params.toString()
  return req<EventSearchResult>(`/api/events/search${qs ? '?' + qs : ''}`)
}

// iter-223 (Feature #6 slice 7b-client): per-day event counts feeding
// the calendar heatmap. Same filter set as `searchEvents` minus the
// pagination cursor — `before_ts` doesn't apply to a count aggregate.
export type EventCountFilters = {
  camera_id?: string
  person_name?: string
  label?: string
  since_ts?: number
  until_ts?: number
  /** iter-228: same semantics as `EventSearchFilters.face_unrecognized`. */
  face_unrecognized?: boolean
}
export const getEventCountsByDay = (filters: EventCountFilters = {}) => {
  const params = new URLSearchParams()
  if (filters.camera_id) params.set('camera_id', filters.camera_id)
  if (filters.person_name) params.set('person_name', filters.person_name)
  if (filters.label) params.set('label', filters.label)
  if (filters.since_ts != null) params.set('since_ts', String(filters.since_ts))
  if (filters.until_ts != null) params.set('until_ts', String(filters.until_ts))
  if (filters.face_unrecognized != null)
    params.set('face_unrecognized', String(filters.face_unrecognized))
  const qs = params.toString()
  // iter-346: route through the iter-340 ETag-aware getCachedJSON.
  // Server emits ETag on /api/events/count_by_day since iter-240;
  // pre-iter-346 the client never echoed If-None-Match → ETag was
  // dead weight. The visibility-resume path (iter-? heatmap refetch
  // on tab focus) was paying full SQLite scan + JSON parse on every
  // resume. Now 304s return the cached body invisibly.
  return getCachedJSON<{ counts: Record<string, number> }>(
    `/api/events/count_by_day${qs ? '?' + qs : ''}`,
  )
}
// iter-248 — unread count + per-event seen flag for the home-screen
// app-icon badge. `getUnreadCount` polls on Events tab mount + after
// each WS event arrival; `markEventSeen` fires on row tap;
// `markAllEventsSeen` powers the bulk-clear button.
export const getUnreadCount = () =>
  req<{ count: number }>('/api/events/unread_count')
export const markEventSeen = (eventId: string) =>
  req<{ flipped: boolean }>(`/api/events/${eventId}/seen`, { method: 'POST' })
export const markAllEventsSeen = () =>
  req<{ flipped: number }>('/api/events/seen_all', { method: 'POST' })

export const captureSnapshot = () =>
  req<{ url: string }>('/api/capture', { method: 'POST' })
// `note` is set when the server endpoint is still in scaffold mode —
// see `routes/control.py::system_reboot`. Surface it so the user
// isn't told "Reboot requested" when nothing actually rebooted.
export const rebootJetson = () =>
  req<{ ok: boolean; note?: string }>('/api/system/reboot', { method: 'POST' })
// iter-211 (Feature #10 slice 2): mirror of rebootJetson — owner-
// only POST that returns `note` while the host-helper is stubbed.
// When operator wires the helper, the response loses `note` and
// the UI reports actual success.
export const triggerBackup = () =>
  req<{ ok: boolean; note?: string }>('/api/system/backup', { method: 'POST' })
// iter-237 (Feature #12 OTA slice 6 / iter-212 client wiring):
// restore from a backup file. backup_path is a filename relative
// to settings.backup_target_dir (server-side). Two-tier path-
// traversal defense lives on the server (regex + Path.resolve()
// .relative_to()); client passes the bare filename. Returns the
// echoed `backup_path` for confirmation.
export const triggerRestore = (backupPath: string) =>
  req<{ ok: boolean; note?: string; backup_path: string }>(
    '/api/system/restore',
    {
      method: 'POST',
      body: JSON.stringify({ backup_path: backupPath }),
    },
  )
// iter-239 (Feature #10/12 follow-up): list available backup files
// from settings.backup_target_dir. Mirrors `listTimelapses` shape.
// Owner-only on the server side (iter-238). Used by the Restore
// form (iter-237) to populate a dropdown — closes the iter-237
// "user types filename" risk.
export type BackupItem = {
  filename: string
  size_bytes: number
  mtime_s: number
}
export const listBackups = () =>
  req<{ items: BackupItem[] }>('/api/system/backups')

// iter-231 (Feature #12 OTA slice 2): mirror of triggerBackup —
// owner-only POST that returns `note` while the host-helper is
// stubbed (slice 4, operator-side). Three plausible host-helper
// designs documented in iter-230 route comment + feature_12_state.
export const triggerUpdate = () =>
  req<{ ok: boolean; note?: string }>('/api/system/update', { method: 'POST' })
// iter-234 (Feature #12 OTA slice 3b): hand-bumped server version
// string from the iter-232 GET route. Auth-gated (any role) —
// informational, not destructive. Used by the Settings UI to show
// "Server version: X" + slice 3c will compare to a registry tag
// for "update available?" checks.
export const getServerVersion = () =>
  req<{ version: string }>('/api/system/version')

// iter-214 (Feature #8 slice 3): daily-timelapse client wrappers.
// `date` is YYYY-MM-DD (server-side regex `^[0-9]{4}-[01][0-9]-[0-3]
// [0-9]$`). Trigger returns the URL where the file WILL appear once
// the slice 2 host-helper runs; listing returns the live state.
export type TimelapseItem = {
  date: string
  url: string
  size_bytes: number
}
export const triggerTimelapse = (date: string) =>
  req<{ ok: boolean; note?: string; date: string; url: string }>(
    '/api/system/timelapse',
    {
      method: 'POST',
      body: JSON.stringify({ date }),
    },
  )
export const listTimelapses = () =>
  req<{ items: TimelapseItem[] }>('/api/system/timelapses')

// iter-309 (user "add the ability to delete timelapsed videos"):
// owner-only delete by date. Server returns `{deleted: bool}` so
// the UI can disambiguate "row gone" from "row never existed"
// without a 404. Mirrors the iter-299 event-delete contract.
export const deleteTimelapse = (date: string) =>
  req<{ deleted: boolean; date: string }>(
    `/api/system/timelapse?date=${encodeURIComponent(date)}`,
    { method: 'DELETE' },
  )

// iter-326 (missing-feature #5, "Familiar Faces" log): per-person
// aggregation for the new /people page. One row per distinct
// person_name with count + first_seen_ts + last_seen_ts + the
// last clip/thumb URL (for the row's "play their last visit"
// affordance). Sorted server-side newest-first.
//
// iter-328 (R2): response also carries `total` so the client can
// render "Showing N of M" when an operator has more enrolled
// faces than the page returns. Default server limit is 100; the
// caller can tighten via the optional `limit` arg (1..500).
export type PersonSummary = {
  name: string
  count: number
  last_seen_ts: number
  first_seen_ts: number
  last_clip_url: string | null
  last_thumb_url: string | null
}
export type PeopleListResponse = {
  items: PersonSummary[]
  total: number
}
// iter-340 (perf E1): per-URL ETag cache for /api/people (and any
// future ETag-bearing routes that opt in). Server emits ETag on
// every /api/people response since iter-327; pre-iter-340 the
// browser HTTP cache should have handled the round-trip, but with
// `credentials: 'include'` (HttpOnly cookies) most browsers refuse
// to cache the response. Echo If-None-Match manually so the server
// returns 304 + we hand back the cached parsed body — saves the
// SQLite window-function query + body transfer + JSON parse on
// every visibility-resume / nav-back to /people.
const _ETAG_CACHE: Map<string, { etag: string; body: unknown }> = new Map()
// iter-356.x (scalability A3): cap the ETag cache so 60 months of
// heatmap navigation × multiple person filters can't grow this Map
// without bound. JS Maps preserve insertion order, so deleting the
// oldest key on overflow gives LRU-ish behavior (set re-inserts to
// the tail on touch).
const _ETAG_CACHE_MAX = 50

// iter-346 (refactored from iter-340): generic GET wrapper that
// echoes If-None-Match on subsequent calls + returns the cached
// parsed body on 304. Used by listPeople (iter-340) AND
// getEventCountsByDay (iter-346 wires it). Other ETag-bearing
// routes can opt in by switching from `req<T>` to this helper.
//
// Cache is module-scoped Map<URL, {etag, body}> — survives across
// page-session calls, busts on hard reload. Server's ETag rotates
// on data change so stale-cache risk is bounded to one request.
export async function getCachedJSON<T>(url: string): Promise<T> {
  const cached = _ETAG_CACHE.get(url)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (cached) headers['If-None-Match'] = cached.etag
  const doFetch = () =>
    fetch(`${BASE}${url}`, { credentials: 'include', headers })
  let res = await doFetch()
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    if (await _attemptRefresh()) {
      res = await doFetch()
    }
  }
  if (res.status === 304 && cached) {
    return cached.body as T
  }
  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      if (text) detail = `: ${text.slice(0, 200)}`
    } catch {
      // unreadable body
    }
    throw new HttpError(url, res.status, detail)
  }
  const body = (await res.json()) as T
  const etag = res.headers.get('ETag') || res.headers.get('etag')
  if (etag) {
    // Refresh insertion order so this URL isn't first to evict.
    if (_ETAG_CACHE.has(url)) _ETAG_CACHE.delete(url)
    _ETAG_CACHE.set(url, { etag, body })
    if (_ETAG_CACHE.size > _ETAG_CACHE_MAX) {
      const oldest = _ETAG_CACHE.keys().next().value
      if (oldest !== undefined) _ETAG_CACHE.delete(oldest)
    }
  }
  return body
}

export const listPeople = (
  opts?: { limit?: number },
): Promise<PeopleListResponse> => {
  const qs = opts?.limit !== undefined ? `?limit=${opts.limit}` : ''
  return getCachedJSON<PeopleListResponse>(`/api/people${qs}`)
}

// iter-330 (missing-feature #3, Event Export ZIP): bundle one or
// more selected events into a downloadable ZIP. The server returns
// `application/zip` with a Content-Disposition attachment header;
// this wrapper hands back the raw Blob so the caller can either
// trigger a browser download (URL.createObjectURL → anchor click)
// or upload elsewhere. Auth handled by the same cookie flow as
// other req() calls. Capped at 50 events per request server-side.
export async function exportEvents(eventIds: string[]): Promise<Blob> {
  const res = await fetch(`${BASE}/api/events/export`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_ids: eventIds }),
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 200)
    } catch {
      // ignore — bare status is fine
    }
    throw new HttpError(
      '/api/events/export',
      res.status,
      detail ? `: ${detail}` : '',
    )
  }
  return res.blob()
}
// iter-352 (face-capture-for-retraining, Phase 2): browse face crops
// the worker saved per the iter-351 recognizer change. The /training
// page consumes both list shapes; the per-file image URL is served by
// `/api/face/captures/{name}/{filename}` (FileResponse, image/jpeg).
// All routes are gated by require_role("owner") server-side.
export type FaceCaptureDir = {
  name: string
  count: number
  latest_ts: number
}

export type FaceCaptureFile = {
  filename: string
  ts_ms: number
  event_id: string
  url: string
  // iter-355a: sidecar fields. Both null when the worker that wrote
  // this capture pre-dates iter-355a (no sidecar JSON), OR when the
  // crop was uploaded via the iter-354 bootstrap route. Client renders
  // a "—" badge in those cases instead of a confidence percentage.
  predicted_name?: string | null
  confidence?: number | null
}

export const listFaceCaptureDirs = () =>
  req<{ dirs: FaceCaptureDir[] }>('/api/face/captures')

export const listFaceCapturesInDir = (name: string) =>
  req<{ name: string; files: FaceCaptureFile[] }>(
    `/api/face/captures/${encodeURIComponent(name)}`,
  )

// iter-353 (Phase 3): mutating actions for the operator triage loop.
// Both routes are owner-gated server-side; the wrappers just compose
// the URL + body. The PWA's /training drill-in view calls these from
// per-thumbnail action menus.

export const moveFaceCapture = (
  name: string,
  filename: string,
  targetName: string,
) =>
  req<{ ok: true; moved_to: string }>(
    `/api/face/captures/${encodeURIComponent(name)}/${encodeURIComponent(filename)}/move`,
    {
      method: 'POST',
      body: JSON.stringify({ target_name: targetName }),
    },
  )

// iter-356.6X (tiered-inference slice 4): training-data export +
// per-name purge + consent. All routes are owner-gated server-side.
//
// `getTrainingExport` returns the raw Blob for the `application/zip`
// stream so the caller can trigger a browser download via
// `URL.createObjectURL`. `kind` ∈ {face, person}; `size` ∈ the
// server whitelist {64, 96, 128, 224, 320, 416, 640}. Non-2xx
// throws `HttpError` with the status code (422 invalid args,
// 413 capture dir > 5000 entries, 401 if non-owner).
export async function getTrainingExport(
  kind: 'face' | 'person',
  size: number,
): Promise<Blob> {
  const path = `/api/training/export?kind=${encodeURIComponent(kind)}&size=${size}`
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.text()).slice(0, 200)
    } catch {
      // ignore — bare status is fine
    }
    throw new HttpError(path, res.status, detail ? `: ${detail}` : '')
  }
  return res.blob()
}

// Purge every JPEG + sidecar under both face_captures_dir/<name>/
// AND person_captures_dir/<name>/. consent.json is preserved
// server-side (see training_admin.py::_purge_dir).
export const deleteTrainingCaptures = (name: string) =>
  req<{ ok: true; deleted: number }>(
    `/api/training/captures?name=${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  )

// Per-name consent record. Server returns the default-deny shape
// (granted=false, all other fields null) on miss — the client does
// NOT need to branch on 404. Pinned by the api.test wire test.
export type ConsentRecord = {
  granted: boolean
  recorded_at_ms: number | null
  consent_text_version: string | null
  recorded_by: string | null
}

export const getNameConsent = (name: string) =>
  req<ConsentRecord>(`/api/face/captures/${encodeURIComponent(name)}/consent`)

export const setNameConsent = (
  name: string,
  granted: boolean,
  consentTextVersion: string,
) =>
  req<ConsentRecord>(
    `/api/face/captures/${encodeURIComponent(name)}/consent`,
    {
      method: 'POST',
      body: JSON.stringify({
        granted,
        consent_text_version: consentTextVersion,
      }),
    },
  )

export const deleteFaceCapture = (name: string, filename: string) =>
  req<{ ok: true }>(
    `/api/face/captures/${encodeURIComponent(name)}/${encodeURIComponent(filename)}`,
    { method: 'DELETE' },
  )

// iter-356.12 (Sam Critical from iter-356.8): the iter-355c1 server
// review_queue route shipped with full server tests but ZERO client
// UI consumed it. This wrapper closes the gap so the new /training/
// review page can list uncertain crops for operator triage.
export type ReviewQueueItem = {
  filename: string
  ts_ms: number
  event_id: string
  predicted_name: string | null
  confidence: number
  current_dir: string
  url: string
}

export const getReviewQueue = (limit?: number) =>
  req<{
    items: ReviewQueueItem[]
    total_uncertain: number
    limit: number
  }>(
    `/api/face/review_queue${limit != null ? `?limit=${limit}` : ''}`,
  )

// iter-354 (Phase 4 scaffold): bootstrap + re-train. Both routes
// today are stub-with-note (server returns `{ok, note: "scaffold..."}`)
// — client surfaces the note via toast so the operator sees the honest
// "encoding NOT updated; SSH and run encode_known_faces.py" message
// instead of pretending it worked. iter-355 wires the real subprocess.

export const bootstrapFace = (
  name: string,
  image: File,
): Promise<{ ok: true; saved_to?: string; note?: string }> => {
  // Multipart upload, NOT JSON. Cannot use the standard `req()` wrapper
  // because that JSON-encodes the body. Build FormData by hand and let
  // the browser set the Content-Type with boundary.
  const fd = new FormData()
  fd.append('name', name)
  fd.append('image', image)
  return fetch('/api/face/bootstrap', {
    method: 'POST',
    credentials: 'include',
    body: fd,
  }).then(async (res) => {
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        // ignore
      }
      throw new HttpError(
        '/api/face/bootstrap',
        res.status,
        detail ? `: ${detail}` : '',
      )
    }
    return res.json()
  })
}

export const retrainFace = () =>
  req<{ ok: true; note?: string }>('/api/face/retrain', { method: 'POST' })

export const toggleDetection = () =>
  req<{ active: boolean }>('/api/detection/toggle', { method: 'POST' })

export const getDetectionConfig = () =>
  req<DetectionConfig>('/api/detection/config')

export const patchDetectionConfig = (patch: Partial<DetectionConfig>) =>
  req<DetectionConfig>('/api/detection/config', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

export const subscribePush = (sub: PushSubscription) =>
  req<{ ok: boolean }>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(sub.toJSON()),
  })

export const unsubscribePush = (endpoint: string) =>
  req<{ ok: boolean }>('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  })

// `sent` is the count of subscriptions pywebpush actually delivered to.
// Useful for honest UX: if 0, the user pressed "Send test" but no
// notification will arrive — likely no subscriptions registered (or
// they all 410'd and got pruned by send_all).
export const sendTestPushReq = () =>
  req<{ ok: boolean; sent: number }>('/api/push/test', { method: 'POST' })

export const getVapidPublicKey = () => req<{ key: string }>('/api/push/vapid-public-key')

// iter-181 (Auth Plan Phase 3): four auth wrappers. Routes are LIVE
// but `/api/*` outside `/api/auth/*` is NOT yet gated — Phase 5
// (iter-183) does that. The `req<T>` helper above adds credentials +
// 401-retry for free.
export const login = (body: LoginRequest) =>
  req<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  })

export const logout = () =>
  req<{ ok: boolean }>('/api/auth/logout', {
    method: 'POST',
    body: '{}',
  })

export const refresh = () =>
  req<LoginResponse>('/api/auth/refresh', {
    method: 'POST',
    body: '{}',
  })

export const getMe = () => req<MeResponse>('/api/auth/me')

// iter-264: password-change client wrappers (closes the iter-258
// half-shipped gap surfaced by test-coverage-auditor D2). Both
// routes return `{ok: true}` on success; the change_password
// route 401s on a wrong current_password; the admin reset route
// 403s for non-owner callers and 404 for unknown usernames.
export const changePassword = (currentPassword: string, newPassword: string) =>
  req<{ ok: boolean }>('/api/auth/change_password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  })
export const adminResetPassword = (username: string, newPassword: string) =>
  req<{ ok: boolean }>('/api/auth/admin/reset_password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, new_password: newPassword }),
  })

// iter-265: owner-only user management. List + create + delete.
// Used by the Settings "Manage users" panel. All three routes
// return 403 for non-owner callers; create returns 409 on duplicate
// username; delete returns 400 on self-delete or last-owner-delete.
export type AdminUserRow = {
  username: string
  role: string
  created_at: number
}

export type AdminRole = 'owner' | 'family' | 'viewer' | 'admin'

export const adminListUsers = () =>
  req<{ users: AdminUserRow[] }>('/api/auth/admin/users')

export const adminCreateUser = (
  username: string,
  password: string,
  role: AdminRole,
) =>
  req<{ ok: boolean; username: string; role: string }>(
    '/api/auth/admin/users',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    },
  )

export const adminDeleteUser = (username: string) =>
  req<{ ok: boolean }>('/api/auth/admin/delete_user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  })

// iter-208 (Feature #4 slice 3b): per-user push filter management.
// Mirrors the iter-207 server routes. `filters: null` means match-
// all (legacy default); set on the wire to reset filtering.
export const getMyPushFilters = () =>
  req<{ filters: PushFilters | null }>('/api/push/filters')

export const setMyPushFilters = (filters: PushFilters | null) =>
  req<{ filters: PushFilters | null }>('/api/push/filters', {
    method: 'PUT',
    body: JSON.stringify({ filters }),
  })

// iter-303 (user "instead of free-typing for the notifications, have
// a fuzzy search and a toggle on or off for each option"): server
// returns distinct camera_ids + person_names from the events table,
// plus the user's own current filter values mixed in (so editing a
// filter that includes "alice" still shows "alice" in the picker
// even if no alice events have been observed yet).
export const getKnownFilterOptions = () =>
  req<{ cameras: string[]; person_names: string[] }>(
    '/api/push/known_filter_options',
  )

// iter-307 (user "be able to delete events manually with a
// confirmation, or to delete all events for a day"): owner-only
// destructive ops. Server returns `{deleted: bool}` for single,
// `{deleted: N}` for bulk so the UI can toast specifically.
export const deleteEvent = (eventId: string) =>
  req<{ deleted: boolean }>(`/api/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  })

export const deleteEventsByDay = (day: string) =>
  req<{ deleted: number }>(
    `/api/events?day=${encodeURIComponent(day)}`,
    { method: 'DELETE' },
  )
