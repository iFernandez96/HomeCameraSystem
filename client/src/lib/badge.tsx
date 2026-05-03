import { useEffect } from 'react'
import { getUnreadCount } from './api'
import { subscribeEvents } from './ws'

/**
 * iter-248: keep the home-screen app-icon badge in sync with unread
 * detection events. Mounted once at the AppShell level — runs only
 * while the user is authed (parent is inside RequireAuth-protected
 * shell scope).
 *
 * Behavior:
 *  - On mount: poll `/api/events/unread_count` once, push to
 *    `navigator.setAppBadge(count)`.
 *  - On each WS event: increment locally + push to setAppBadge so
 *    the home-screen indicator updates within ~1 s of detection
 *    without an extra HTTP roundtrip.
 *  - The Events page itself calls `markAllEventsSeen` + clearAppBadge
 *    when it mounts; we only INCREMENT here, never clear.
 *
 * Browser support: Chrome / Edge / Samsung Internet on Android
 * (PWA installed). Other browsers ignore the calls — feature
 * detection via optional chaining keeps the rest of the app
 * working without erroring.
 */
export function useUnreadBadge() {
  useEffect(() => {
    let count = 0
    let cancelled = false

    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>
      clearAppBadge?: () => Promise<void>
    }

    const push = () => {
      if (cancelled) return
      // setAppBadge(0) is documented to clear; some browsers prefer
      // clearAppBadge for the zero case. Use the explicit clear.
      if (count <= 0) {
        nav.clearAppBadge?.().catch(() => {})
      } else {
        // iter-356.7 (widget B1): cap at 99 to match Ring/WhatsApp/iOS
        // convention. Pre-iter-356.7 a busy day would surface "312"
        // on the home-screen icon — visually overwhelming and
        // technically meaningless past 99.
        nav.setAppBadge?.(Math.min(count, 99)).catch(() => {})
      }
    }

    const reconcile = () => {
      // iter-276 (functionality-auditor #1): re-fetch the canonical
      // server count instead of trusting the in-memory `count`. Used
      // by the visibility-resume + badge-reconcile listeners below
      // so a backgrounded → foregrounded PWA picks up any pushes the
      // SW handled while the tab was hidden, AND so a manual
      // markAllEventsSeen on the Events page reconciles back to 0
      // without round-tripping through the WS.
      getUnreadCount()
        .then((r) => {
          if (cancelled) return
          count = r.count
          push()
        })
        .catch(() => {
          // Silent — auth not ready yet OR network blip; the next
          // WS event will catch us up.
        })
    }

    reconcile()

    const unsub = subscribeEvents((e) => {
      if (e.type === 'detection') {
        count += 1
        push()
      }
    })

    // iter-276 (functionality-auditor #1): on tab-resume, the
    // in-memory `count` is stale (SW handled pushes, in-app marked
    // events seen, etc.). Re-poll the canonical count on visible.
    // Mirrors the iter-37 / iter-157 / iter-158 visibility-aware
    // channel pattern documented in CLAUDE.md sharp edges.
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconcile()
    }
    document.addEventListener('visibilitychange', onVisible)

    // iter-276: explicit reconcile signal. Pages that mutate seen-
    // state server-side (Events.tsx::markAllEventsSeen, the iter-276
    // markEventSeen on EventCard tap) dispatch this so the badge
    // re-fetches without waiting for the next WS event.
    const onReconcile = () => reconcile()
    window.addEventListener('homecam:badge-reconcile', onReconcile)

    return () => {
      cancelled = true
      unsub()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('homecam:badge-reconcile', onReconcile)
    }
  }, [])
}
