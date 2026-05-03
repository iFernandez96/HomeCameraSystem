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
  socket = new WebSocket(url())
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
      console.error('bad event', e)
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
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('homecam:auth-failed'))
      }
      return
    }
    // Reconnect as long as someone is still listening (events OR state).
    if (handlers.size === 0 && stateHandlers.size === 0) return
    const delay = Math.min(30_000, 500 * 2 ** reconnectAttempts++)
    reconnectTimer = setTimeout(connect, delay)
  })
  socket.addEventListener('error', () => socket?.close())
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
  if (socket && socket.readyState !== WebSocket.CLOSED) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  connect()
}
