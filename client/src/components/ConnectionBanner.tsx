import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { reconnectIfClosed, subscribeWsState, type WsState } from '../lib/ws'

/**
 * Thin top-of-page banner that appears whenever the realtime WebSocket is
 * not connected. Hidden when state is `open` (the steady-state success
 * case). Subscribes via subscribeWsState so it reflects the *actual* socket
 * state, not just an HTTP probe.
 *
 * iter-182 (Auth Plan Phase 4): also hidden when the user is unauth'd.
 * The /login page doesn't open a WS (no listeners attached) so the
 * banner would otherwise sit at "Realtime disconnected — retrying"
 * indefinitely on the login screen, which is misleading.
 */
export function ConnectionBanner() {
  const { state: authState } = useAuth()
  const [state, setState] = useState<WsState>('closed')
  // iter-356.48: post-auth grace period before the "disconnected"
  // banner can render. Pre-iter-356.48 every page load (and every
  // anon→authed transition) flashed a loud red "Realtime
  // disconnected — retrying" for the ~200-1500 ms it takes the WS
  // to handshake, since the initial useState value is 'closed' and
  // the first transition lands on 'connecting' a beat later. Now:
  // first 2 s after auth-resolved, suppress the closed-state banner
  // (the 'connecting' yellow can still render — it's accurate).
  // 2 s is long enough to swallow normal handshakes on LAN +
  // Tailscale, short enough that a real outage still surfaces
  // promptly.
  const [graceElapsed, setGraceElapsed] = useState(false)
  useEffect(() => {
    // iter-356.66 (Mira critic last-mile): React 19's
    // react-hooks/set-state-in-effect rule rejects a synchronous
    // setState inside an effect body. The reset on a non-authed
    // transition + the elapsed-flip on the 2-s timer are both
    // legitimate state writes; route them through Promise.resolve()
    // and a cancelled flag (CLAUDE.md sharp edge) so the rule clears
    // and the behaviour is preserved.
    let cancelled = false
    if (authState !== 'authed') {
      Promise.resolve().then(() => {
        if (!cancelled) setGraceElapsed(false)
      })
      return () => {
        cancelled = true
      }
    }
    const t = setTimeout(() => {
      if (!cancelled) setGraceElapsed(true)
    }, 2000)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [authState])

  useEffect(() => subscribeWsState(setState), [])

  // When the tab returns to visible, force-reconnect the WS if it's closed.
  // Without this the user can sit on a stale "Realtime disconnected" banner
  // for up to 30 s of backed-off reconnect delay after a mobile resume.
  // Symmetric to iter-37 (useStatus visibility-pause) and iter-157 (Events
  // visibility-refetch); this closes the realtime-channel side of the gap.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectIfClosed()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  if (state === 'open') return null
  if (authState !== 'authed') return null
  // iter-356.48: swallow the closed-state banner during the post-auth
  // grace window. 'connecting' (yellow) still renders — accurate
  // signal that the WS is mid-handshake, calmer color than red.
  if (state === 'closed' && !graceElapsed) return null

  const label =
    state === 'connecting' ? 'Connecting to camera…' : 'Realtime disconnected — retrying'
  // iter-356.25 (light theme): tinted-surface tokens (warning/danger)
  // give soft warm-orange + soft red bg with darker text on the cream
  // page. Pre-iter-356.25 was bg-yellow-900/90 + text-yellow-100 which
  // was correct for dark bg but reads as a heavy bruise on cream.
  const tone =
    state === 'connecting'
      ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning-border)]'
      : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-border)]'

  // iter-356.63 (Slice D a11y): split the live-region scope by
  // severity. 'connecting' is a transient handshake — polite is
  // accurate, the user can keep typing without interruption. The
  // 'disconnected — retrying' state is the one that means the
  // realtime channel actually broke; bumping it to role="alert"
  // (implicitly assertive) so AT users get the same urgency
  // sighted users get from the red banner.
  const isDisconnected = state !== 'connecting'
  return (
    <div
      role={isDisconnected ? 'alert' : 'status'}
      aria-live={isDisconnected ? undefined : 'polite'}
      // iter-356.66 (iOS oddities sweep): fixed top-0 without
      // safe-area-top padding put the banner text behind the iOS
      // status bar's clock/icons in PWA standalone mode.
      // pt-[env(safe-area-inset-top)] pushes the message below the
      // notch; on Android (zero inset) collapses to the original
      // py-1.5 padding cleanly.
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      className={`fixed top-0 inset-x-0 lg:left-[var(--sidenav-width,4rem)] z-30 px-3 pb-1.5 text-center text-xs font-semibold border-b backdrop-blur ${tone}`}
    >
      {label}
    </div>
  )
}
