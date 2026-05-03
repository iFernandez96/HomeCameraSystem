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

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-0 inset-x-0 lg:left-56 z-30 px-3 py-1.5 text-center text-xs font-semibold border-b backdrop-blur ${tone}`}
    >
      {label}
    </div>
  )
}
