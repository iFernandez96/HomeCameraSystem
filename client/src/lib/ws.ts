import { log, errFields } from './log'
import type { ServerEvent } from './types'

type Handler = (e: ServerEvent) => void
export type WsState = 'connecting' | 'open' | 'closed'
type StateHandler = (s: WsState) => void

let socket: WebSocket | null = null
let socketState: WsState = 'closed'
const handlers = new Set<Handler>()
const stateHandlers = new Set<StateHandler>()
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function url() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/events/ws`
}

function setSocketState(s: WsState) {
  if (socketState === s) return
  socketState = s
  stateHandlers.forEach((h) => h(s))
}

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return
  }
  try {
    socket = new WebSocket(url())
  } catch (e) {
    // `new WebSocket` can throw synchronously (e.g. SecurityError on a
    // mixed-content / disallowed-scheme URL) — without this the whole
    // realtime layer dies with no console signal at all.
    log.error('ws:constructor-throw', { url: url(), ...errFields(e) })
    socket = null
    setSocketState('closed')
    return
  }
  setSocketState('connecting')
  socket.addEventListener('open', () => {
    reconnectAttempts = 0
    setSocketState('open')
  })
  socket.addEventListener('message', (m) => {
    try {
      const evt = JSON.parse(m.data) as ServerEvent
      handlers.forEach((h) => h(evt))
    } catch (e) {
      // Malformed frame — log a bounded raw sample so a server payload-shape
      // regression (or a proxy injecting HTML) is diagnosable, not just
      // silently dropped. Never log the full frame (could be large).
      const raw = typeof m.data === 'string' ? m.data.slice(0, 200) : typeof m.data
      log.warn('ws:parse-fail', { sample: raw, ...errFields(e) })
    }
  })
  socket.addEventListener('close', (ev) => {
    socket = null
    setSocketState('closed')
    // iter-182 (Auth Plan Phase 4): WS close code 1008 (Policy
    // Violation) is either the iter-168 origin gate or — from
    // iter-185 (Phase 6) — the auth gate. Do NOT exponential-
    // backoff loop: tight retries would hammer a server that's
    // already rejecting us, and the AuthProvider remount after a
    // successful login will re-arm this subscription cleanly.
    if (ev.code === 1008) {
      // iter-185: dispatch a window-level signal so the
      // AuthProvider can re-check /api/auth/me and drop session
      // state if needed. We don't differentiate auth-vs-origin
      // by close reason here because the /me re-check is the
      // tiebreaker — if the cookie is still valid, /me 200s and
      // the AuthProvider does nothing; if invalid, /me 401s and
      // the user is flipped to anon → redirected to /login.
      // Self-healing in both directions.
      //
      // The server's close `reason` (origin-mismatch vs auth-gate) is the
      // ONLY signal that tells these two apart and was discarded — log it
      // so an unexpected origin-gate trip (e.g. a Tailscale hostname change)
      // isn't misdiagnosed as an auth problem.
      log.warn('ws:closed-1008', { reason: ev.reason || '(none)' })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('homecam:auth-failed'))
      }
      return
    }
    // Reconnect as long as someone is still listening (events OR state).
    if (handlers.size === 0 && stateHandlers.size === 0) return
    const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts++)
    // Reconnect-storm visibility: a flapping server (or a never-up backend)
    // backs off exponentially but otherwise leaves no trace. WARN once the
    // backoff has climbed (attempt > 2) so a persistent outage is greppable
    // without spamming on the normal first-reconnect.
    if (reconnectAttempts > 2) {
      log.warn('ws:reconnect-storm', {
        code: ev.code,
        attempt: reconnectAttempts,
        delayMs: delay,
      })
    }
    reconnectTimer = setTimeout(connect, delay)
  })
  socket.addEventListener('error', () => {
    // The `error` Event carries no detail by spec, but its arrival before a
    // close was previously fully swallowed — log it so a connect-time failure
    // (DNS / TLS / refused) is distinguishable from a clean close.
    log.warn('ws:error-event', {
      readyState: socket?.readyState ?? null,
      online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    })
    socket?.close()
  })
}

function maybeShutdown() {
  if (handlers.size > 0 || stateHandlers.size > 0) return
  socket?.close()
  socket = null
  setSocketState('closed')
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

export function subscribeEvents(h: Handler): () => void {
  handlers.add(h)
  if (!socket) connect()
  return () => {
    handlers.delete(h)
    maybeShutdown()
  }
}

/**
 * Subscribe to WebSocket connection-state changes. The callback fires
 * immediately with the current state, then again on every transition. Used
 * by the ConnectionBanner so the user knows when realtime is degraded.
 */
export function subscribeWsState(h: StateHandler): () => void {
  stateHandlers.add(h)
  h(socketState)
  if (!socket) connect()
  return () => {
    stateHandlers.delete(h)
    maybeShutdown()
  }
}

/**
 * Force the WebSocket to reconnect now if it's closed and there are still
 * listeners waiting on it. Cancels any pending exponential-backoff timer
 * and resets the attempt counter so the immediate retry runs without a
 * stale delay.
 *
 * Mobile (and aggressive desktop browsers) close backgrounded WebSockets;
 * the close handler then schedules a reconnect that may have already
 * backed off to ~30 s. Calling this from a `visibilitychange` handler on
 * `visible` cuts the post-refocus dead window. No-op when the socket is
 * already open/connecting, when no listeners are attached, or when SSR.
 */
export function reconnectIfClosed(): void {
  if (handlers.size === 0 && stateHandlers.size === 0) return
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    // Already open/connecting — the visibility-resume tried to reconnect but
    // there was nothing to do. DEBUG breadcrumb so a "why didn't realtime
    // wake up" investigation can confirm the no-op fired vs. never ran.
    log.debug('ws:resume-noop', { readyState: socket.readyState })
    return
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  connect()
}
