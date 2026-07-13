/**
 * Tiny client logging shim (see docs/logging_plan.md).
 *
 * Two sinks:
 *  - `console` for the developer who has the device's devtools open.
 *  - a best-effort fire-and-forget POST to `/api/client-log`
 *    (error + warn only) so a failure on a phone the operator can't
 *    physically inspect still lands in the Jetson journald stream
 *    alongside the server logs.
 *
 * Hard rules:
 *  - NEVER throws and is NEVER awaited by callers — a failure inside the
 *    logger must not mask the error being reported.
 *  - The ship() POST swallows its own failure and never recurses into
 *    `log.*` (it uses raw `fetch`, not the api.ts `req()` wrapper).
 *  - Callers must NEVER pass passwords, cookie/token values, or full
 *    SDP. Log HTTP status + server detail, WS close code+reason, ICE
 *    gatheringState + candidate counts, `errName:errMessage`. Include
 *    `navigator.onLine` on network-edge failures (added automatically
 *    below) so "server down" vs "request rejected" vs "client offline"
 *    are distinguishable.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFields = Record<string, unknown>

const SHIP_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(['error', 'warn'])

// Shipping is disabled under the vitest test runner so the fire-and-forget
// POST can't interfere with fetch-mock assertions (`MODE === 'test'` is set
// by Vitest). Console logging stays on — vitest captures it harmlessly.
const SHIP_ENABLED =
  typeof import.meta !== 'undefined' &&
  (import.meta as { env?: { MODE?: string } }).env?.MODE !== 'test'

// Cap the serialized field payload so a looping client can't pump
// megabytes into the journal; the server also bounds this independently.
const MAX_FIELDS_BYTES = 2000

function safeFields(fields: LogFields): LogFields {
  try {
    const json = JSON.stringify(fields)
    if (json.length > MAX_FIELDS_BYTES) {
      return { _truncated: true, size: json.length }
    }
    return fields
  } catch {
    // circular / unserializable — don't let it crash the logger
    return { _unserializable: true }
  }
}

function ship(level: LogLevel, event: string, fields: LogFields): void {
  if (!SHIP_ENABLED) return
  try {
    void fetch('/api/client-log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      // keepalive lets the POST survive a page unload (e.g. an error
      // during navigation away from a failing screen).
      keepalive: true,
      body: JSON.stringify({
        level,
        event,
        fields: safeFields(fields),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        ua:
          typeof navigator !== 'undefined'
            ? navigator.userAgent.slice(0, 240)
            : null,
      }),
    }).catch(() => {
      // best-effort: a failed client_log POST must be silent
    })
  } catch {
    // fetch threw synchronously (no global fetch) — ignore
  }
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  // SSR / non-browser safety. In jsdom (tests) window IS defined, so
  // console emit still runs there — that's intentional and harmless.
  if (typeof window === 'undefined') return
  const tag = `[${event}]`
  if (level === 'error') console.error(tag, fields)
  else if (level === 'warn') console.warn(tag, fields)
  else if (level === 'info') console.info(tag, fields)
  else console.debug(tag, fields)
  if (SHIP_LEVELS.has(level)) ship(level, event, fields)
}

/**
 * Structured logger. `event` is a short stable scope token
 * (e.g. `webrtc:whep-failed`, `api:request-failed`, `auth:me-failed`);
 * `fields` carries the express reason + identifying ids.
 */
export const log = {
  error: (event: string, fields: LogFields = {}) => emit('error', event, fields),
  warn: (event: string, fields: LogFields = {}) => emit('warn', event, fields),
  info: (event: string, fields: LogFields = {}) => emit('info', event, fields),
  debug: (event: string, fields: LogFields = {}) => emit('debug', event, fields),
}

/**
 * Normalize an unknown thrown value into safe log fields. Pulls
 * `HttpError.status` / `.path` when present, otherwise `name:message`.
 * Never includes a stack by default (can be large / leak paths).
 */
export function errFields(err: unknown): LogFields {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; status?: number; path?: string }
    const out: LogFields = {}
    if (typeof e.status === 'number') out.status = e.status
    if (typeof e.path === 'string') out.path = e.path
    if (typeof e.name === 'string') out.name = e.name
    if (typeof e.message === 'string') out.message = e.message.slice(0, 300)
    return out
  }
  return { value: String(err).slice(0, 300) }
}
