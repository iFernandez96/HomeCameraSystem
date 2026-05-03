import { useEffect, useState } from 'react'
import { getStatus } from './api'
import type { ServerStatus } from './types'

/**
 * Poll /api/status on an interval. Returns the most recent payload, or
 * null if the last fetch failed.
 *
 * Each new tick aborts the previous in-flight request — protects against
 * pile-up on slow networks where one /api/status takes longer than the
 * polling interval (3G, captive portal, server under GC, etc).
 *
 * Polling pauses while `document.visibilityState === 'hidden'` (tab
 * backgrounded, PWA off-screen on Android, screen locked) and resumes
 * with an immediate fetch on the next visibility change. Reduces
 * background load on the Jetson and cuts the client's battery cost
 * when the user isn't watching.
 */
// iter-177: how many consecutive non-Abort failures before we surface
// "server unreachable" by clearing `status` to null. Pre-iter-177 a
// single 5 s polling failure flipped state to null, collapsing every
// LiveStats / Settings readout to em-dashes for one tick — visible
// flicker on a flaky LAN where the next poll usually recovers. With
// the threshold at 2, a single transient failure preserves the last
// known-good payload (worth a stale-by-5-s value over a flicker on
// every micro-blip). When the server is genuinely down, consumers
// see the stale value for ~10 s before clearing — acceptable: the
// ConnectionBanner already shows "Realtime disconnected" via the
// independent WS-state signal.
const FAILURE_STREAK_THRESHOLD = 2

export function useStatus(intervalMs = 5000): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let inFlight: AbortController | null = null
    let intervalId: ReturnType<typeof setInterval> | null = null
    let failureStreak = 0

    const tick = () => {
      inFlight?.abort()
      const ctrl = new AbortController()
      inFlight = ctrl
      getStatus({ signal: ctrl.signal })
        .then((s) => {
          if (cancelled) return
          setStatus(s)
          failureStreak = 0
        })
        .catch((e) => {
          if (cancelled) return
          // AbortError is expected — we cancelled it on the next tick.
          // Don't treat it as "server unreachable".
          if (e instanceof DOMException && e.name === 'AbortError') return
          if (typeof e === 'object' && e && 'name' in e && e.name === 'AbortError') return
          failureStreak += 1
          // iter-177: hold last-known-good through transient blips.
          if (failureStreak >= FAILURE_STREAK_THRESHOLD) {
            setStatus(null)
          }
        })
    }

    const start = () => {
      if (intervalId !== null) return
      tick()
      intervalId = setInterval(tick, intervalMs)
    }
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
      inFlight?.abort()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        start()
      }
    }

    if (document.visibilityState === 'hidden') {
      // Don't fetch while backgrounded; wait for the tab to come back.
    } else {
      start()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])

  return status
}
