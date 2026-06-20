import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { log } from '../lib/log'
import { reconnectIfClosed, subscribeWsState, type WsState } from '../lib/ws'

/**
 * Top-of-page banner that appears while the realtime WebSocket is not
 * connected. Hidden when state is `open` and there's no recovery
 * announcement to show. Subscribes via subscribeWsState so it
 * reflects the *actual* socket state, not just an HTTP probe.
 *
 * iter-182 (Auth Plan Phase 4): hidden when the user is unauth'd.
 * The /login page doesn't open a WS, so the banner would otherwise
 * sit at "Realtime disconnected — retrying" indefinitely on the
 * login screen.
 *
 * Premium-launch slice — three-step cadence + recovery announcement:
 *
 *  1. `connecting` — calm amber, "Connecting to camera…" — unchanged.
 *  2. `closed` for ≤ ESCALATE_AFTER_MS — calm amber, "Trying to
 *      reconnect…" — covers the typical Tailscale-cellular blip
 *      without flashing red on a returning user.
 *  3. `closed` past ESCALATE_AFTER_MS — red `role="alert"`, "Live
 *      alerts paused — reconnecting" — sustained outage, copy
 *      explains what still works (browse past events) so a non-
 *      technical user isn't alarmed.
 *
 * After a real outage resolves, the banner doesn't just vanish — it
 * briefly renders a success status so a screen-reader user (Dana #4
 * critical: "the recovery is silent because the alerting node simply
 * unmounts") and a partial-sight user both get explicit confirmation.
 *
 * AA contrast (Dana #1): pre-fix copy was rendered as
 * `text-[var(--color-warning)]` ON `bg-[var(--color-warning-bg)]`
 * (#fbbf24 on #5b4828) — measured 4.1:1, fails AA at 12 px banner
 * size. Now uses `text-[var(--color-text-primary)]` (warm parchment
 * on the same tint) which clears AA-large with room.
 */

// 10 seconds of sustained closed before we escalate the banner to
// red alert. Picked to swallow the typical Tailscale resume blip
// (1-3 s) and the worst-case mobile-network handoff (5-8 s) without
// alarming the user, while still surfacing a real outage promptly.
const ESCALATE_AFTER_MS = 10_000

// Post-auth grace window — pre-fix every cold visit flashed the
// closed-state banner for ~200-1500 ms while the WS handshake landed.
// 2 s swallows normal handshakes; real outages still surface promptly
// because they keep `state === 'closed'` past the grace window AND
// past the escalation timer.
const POST_AUTH_GRACE_MS = 2_000

// How long the success "Reconnected" status sticks around after an
// outage resolves. Long enough for a screen reader to announce + a
// user to register the green; short enough that it doesn't outstay
// its welcome on a healthy session.
const RECOVERY_LINGER_MS = 1_800

export function ConnectionBanner() {
  const { state: authState } = useAuth()
  const [state, setState] = useState<WsState>('closed')
  const [graceElapsed, setGraceElapsed] = useState(false)
  // Tracks whether we've shown the user any outage banner yet during
  // this session. Used to gate the "Reconnected" success — we don't
  // pop a green banner on a normal cold-handshake resolve.
  const [outageShown, setOutageShown] = useState(false)
  // Tracks whether we've crossed the escalation threshold. Set by a
  // setTimeout when we enter `closed`; reset whenever we leave it.
  const [escalated, setEscalated] = useState(false)
  // Tracks the brief post-recovery announcement window. When non-null
  // and state === 'open', we render the green "Reconnected" status
  // even though the WS is technically healthy; clears on a timer.
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null)

  // We need a stable handle on `outageShown` inside the WsState
  // subscriber to decide whether to fire the recovery announcement
  // without forcing the subscription effect to re-bind on every
  // flip. React 19's `react-hooks/refs` rule rejects writing to a
  // ref during render — sync the ref via an effect instead.
  const outageShownRef = useRef(outageShown)
  useEffect(() => {
    outageShownRef.current = outageShown
  }, [outageShown])

  // Post-auth grace window — sync setState in an effect body trips
  // React 19's react-hooks/set-state-in-effect rule, so route the
  // reset through Promise.resolve() per CLAUDE.md sharp edge.
  useEffect(() => {
    let cancelled = false
    if (authState !== 'authed') {
      Promise.resolve().then(() => {
        if (!cancelled) {
          setGraceElapsed(false)
          setOutageShown(false)
          setEscalated(false)
          setRecoveredAt(null)
        }
      })
      return () => {
        cancelled = true
      }
    }
    const t = setTimeout(() => {
      if (!cancelled) setGraceElapsed(true)
    }, POST_AUTH_GRACE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [authState])

  // Subscribe to WS state. On entering `closed`, start the
  // escalation timer. On exiting `closed` after the user has SEEN
  // an outage banner, fire the recovery announcement.
  useEffect(() => {
    return subscribeWsState((next) => {
      setState((prev) => {
        if (next === prev) return prev
        if (next === 'closed') {
          setEscalated(false)
        } else if (prev === 'closed' && next === 'open') {
          // Resolve only fires recovery if we actually surfaced an
          // outage banner — gates the success on `outageShown`.
          if (outageShownRef.current) {
            // docs/logging_plan.md §2 (ConnectionBanner): surface WS
            // backoff state — the realtime socket recovered after a
            // visible outage. INFO so the operator can see the outage
            // had a bounded duration (paired with the escalation WARN
            // below) rather than the recovery being a silent unmount.
            log.info('ws:reconnected', { online: navigator.onLine })
            setRecoveredAt(Date.now())
          }
          setEscalated(false)
        } else if (next === 'open') {
          setEscalated(false)
        }
        return next
      })
    })
  }, [])

  // Escalation timer — fires once after ESCALATE_AFTER_MS of sustained
  // `closed` state. Cleared on state change.
  useEffect(() => {
    if (state !== 'closed') return
    const t = setTimeout(() => {
      // docs/logging_plan.md §2 (ConnectionBanner): WS backoff crossed
      // the escalation threshold — sustained outage, not a blip. WARN
      // so a real disconnect (live alerts paused) is greppable. Paired
      // with the ws:reconnected INFO above for outage-duration framing.
      log.warn('ws:outage-escalated', {
        afterMs: ESCALATE_AFTER_MS,
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
      })
      setEscalated(true)
    }, ESCALATE_AFTER_MS)
    return () => clearTimeout(t)
  }, [state])

  // Recovery linger timer — clears recoveredAt after RECOVERY_LINGER_MS
  // so the success banner unmounts on its own.
  useEffect(() => {
    if (recoveredAt === null) return
    const t = setTimeout(() => setRecoveredAt(null), RECOVERY_LINGER_MS)
    return () => clearTimeout(t)
  }, [recoveredAt])

  // Tab-resume reconnect (iter-158 sharp edge). Without this the user
  // can sit on a stale closed banner for up to 30 s of backed-off
  // reconnect delay after a mobile resume.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconnectIfClosed()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // ─── Render decision ────────────────────────────────────────────
  // Compute the banner kind, then bail early on the cases that
  // render nothing. This split keeps `outageShown` book-keeping
  // honest — we set it to true exactly when a real outage banner
  // is rendered.
  if (authState !== 'authed') {
    // Render nothing on /login + during the loading window.
    return null
  }

  type Kind =
    | { variant: 'connecting' }
    | { variant: 'closed-soft' } // amber, recoverable
    | { variant: 'closed-hard' } // red alert, sustained outage
    | { variant: 'recovered' } // green, brief post-resolve celebration

  let kind: Kind | null = null
  if (state === 'connecting') {
    kind = { variant: 'connecting' }
  } else if (state === 'closed') {
    if (graceElapsed) {
      kind = { variant: escalated ? 'closed-hard' : 'closed-soft' }
    }
  } else if (state === 'open' && recoveredAt !== null) {
    kind = { variant: 'recovered' }
  }

  // Track outage exposure for the recovery gate. Sync setState in
  // render is unsafe — schedule via an effect (below) keyed off the
  // computed kind. We can't use the closure var directly, so encode
  // the trigger in a stable string and let the effect react.
  const isOutageVisible =
    kind?.variant === 'closed-soft' || kind?.variant === 'closed-hard'

  return (
    <>
      <OutageExposureTracker
        isOutageVisible={isOutageVisible}
        setOutageShown={setOutageShown}
      />
      {kind && <Banner kind={kind} />}
    </>
  )
}

/** Side-effect helper: flips `outageShown` to true the first time
 *  the user sees a real outage banner this session. Lives in its own
 *  component so the parent can early-return on the null-render path
 *  without missing the bookkeeping. */
function OutageExposureTracker({
  isOutageVisible,
  setOutageShown,
}: {
  isOutageVisible: boolean
  setOutageShown: (v: boolean) => void
}) {
  useEffect(() => {
    if (isOutageVisible) setOutageShown(true)
  }, [isOutageVisible, setOutageShown])
  return null
}

function Banner({
  kind,
}: {
  kind:
    | { variant: 'connecting' }
    | { variant: 'closed-soft' }
    | { variant: 'closed-hard' }
    | { variant: 'recovered' }
}) {
  // Visible label. All four variants use plain-English copy — Frank
  // E1 explicitly flagged the prior "Realtime disconnected" string.
  let label: string
  let role: 'status' | 'alert'
  let aria: 'polite' | undefined
  let toneClass: string
  let dotClass: string
  let dotPulse: string

  switch (kind.variant) {
    case 'connecting':
      label = 'Connecting to camera…'
      role = 'status'
      aria = 'polite'
      toneClass =
        'bg-[var(--color-warning-bg)] text-[var(--color-text-primary)] border-[var(--color-warning-border)]'
      dotClass = 'bg-[var(--color-warning)]'
      dotPulse = 'animate-pulse'
      break
    case 'closed-soft':
      label = 'Trying to reconnect…'
      role = 'status'
      aria = 'polite'
      toneClass =
        'bg-[var(--color-warning-bg)] text-[var(--color-text-primary)] border-[var(--color-warning-border)] animate-banner-soft'
      dotClass = 'bg-[var(--color-warning)]'
      dotPulse = 'animate-pulse'
      break
    case 'closed-hard':
      // Frank E1: "Realtime disconnected — retrying" → plain English
      // that explains what still works. Live alerts (the WS) are
      // paused; past events are still browsable via the REST API
      // because that traffic is independent of the WS.
      label = 'Live alerts paused — reconnecting. Past events still work.'
      role = 'alert'
      aria = undefined // role="alert" implies aria-live="assertive"
      toneClass =
        'bg-[var(--color-danger-bg)] text-[var(--color-text-primary)] border-[var(--color-danger-border)]'
      dotClass = 'bg-[var(--color-danger)]'
      dotPulse = 'animate-pulse'
      break
    case 'recovered':
      label = 'Reconnected'
      role = 'status'
      aria = 'polite'
      toneClass =
        'bg-[var(--color-success-bg)] text-[var(--color-text-primary)] border-[var(--color-success-border)]'
      dotClass = 'bg-[var(--color-success)]'
      // No pulse on the success state — the banner appears, sits
      // calmly for ~1.8 s, fades. Pulse would feel anxious.
      dotPulse = ''
      break
  }

  return (
    <div
      role={role}
      aria-live={aria}
      // Safe-area inset on iOS PWA standalone — pre-fix the banner
      // text rendered behind the status-bar clock. Pads from the
      // notch on iOS, collapses cleanly on Android.
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      className={`fixed top-0 inset-x-0 lg:left-[var(--sidenav-width,4rem)] z-30 px-3 pb-1.5 text-center text-xs font-semibold border-b backdrop-blur ${toneClass}`}
    >
      <span className="inline-flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`w-2 h-2 rounded-full ${dotClass} ${dotPulse}`}
        />
        <span>{label}</span>
      </span>
    </div>
  )
}
