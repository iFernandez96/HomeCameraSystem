import { useEffect, useRef } from 'react'

export type ViewTelemetryKind = 'page' | 'event'

export type ViewTelemetryPayload = {
  v: 1
  kind: ViewTelemetryKind
  name: string
  dwell_ms: number
  ts: number
}

type Span = {
  kind: ViewTelemetryKind
  name: string
  startedAt: number
}

const ENDPOINT = '/api/telemetry/view'
const MAX_NAME = 128

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function cleanName(name: string): string {
  return name.slice(0, MAX_NAME)
}

function sendViewTelemetry(
  username: string | null | undefined,
  payload: ViewTelemetryPayload,
): void {
  if (!username) return
  try {
    const body = JSON.stringify(payload)
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (nav && typeof nav.sendBeacon === 'function') {
      const ok = nav.sendBeacon(
        ENDPOINT,
        new Blob([body], { type: 'application/json' }),
      )
      if (ok) return
    }
    if (typeof fetch === 'function') {
      void fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body,
      }).catch(() => {})
    }
  } catch {
    // Telemetry is best-effort and must never affect the app.
  }
}

function finishSpan(username: string | null | undefined, span: Span): void {
  const dwell = Math.max(0, Math.round(nowMs() - span.startedAt))
  sendViewTelemetry(username, {
    v: 1,
    kind: span.kind,
    name: cleanName(span.name),
    dwell_ms: dwell,
    ts: epochSeconds(),
  })
}

export function usePageViewTelemetry(
  username: string | null | undefined,
  pathname: string,
): void {
  const spanRef = useRef<Span | null>(null)
  const usernameRef = useRef(username)
  usernameRef.current = username

  useEffect(() => {
    if (spanRef.current) finishSpan(usernameRef.current, spanRef.current)
    spanRef.current = { kind: 'page', name: pathname, startedAt: nowMs() }
    return () => {
      const span = spanRef.current
      if (!span || span.kind !== 'page' || span.name !== pathname) return
      finishSpan(usernameRef.current, span)
      spanRef.current = null
    }
  }, [pathname])

  useEffect(() => {
    const finishCurrent = () => {
      const span = spanRef.current
      if (!span) return
      finishSpan(usernameRef.current, span)
      spanRef.current = null
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        finishCurrent()
      } else if (!spanRef.current) {
        spanRef.current = { kind: 'page', name: pathname, startedAt: nowMs() }
      }
    }
    const onPageHide = () => finishCurrent()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [pathname])
}

export function useEventViewTelemetry(
  username: string | null | undefined,
  eventId: string | null | undefined,
): void {
  const usernameRef = useRef(username)
  usernameRef.current = username

  useEffect(() => {
    if (!eventId) return
    const span: Span = { kind: 'event', name: eventId, startedAt: nowMs() }
    return () => finishSpan(usernameRef.current, span)
  }, [eventId])
}
