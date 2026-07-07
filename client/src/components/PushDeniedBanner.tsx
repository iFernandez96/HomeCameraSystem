import { useState } from 'react'
import { useAuth } from '../lib/auth'

/**
 * Nav-coherence fix (painfix, item 4): push notifications go silently
 * dead app-wide when the OS/browser permission is `denied` — the
 * Settings toggle and any server-side subscription can look fully
 * "on" while nothing ever arrives, because `Notification.permission`
 * is a one-way gate the user flips outside the app. `lib/push.ts`
 * persists no client-side "push was ever enabled" marker (subscribe
 * state lives entirely behind `PushManager.getSubscription()`, which
 * is async and per-registration, not a synchronous localStorage
 * read), so this banner keys off the permission itself: denied +
 * authed is unconditionally worth surfacing, since a denied
 * permission means push cannot work regardless of what the app's own
 * toggle claims.
 *
 * Visual grammar borrowed from ConnectionBanner: full-width fixed
 * strip, `role="status"`, safe-area-aware. Warning tint (not danger)
 * — this isn't an outage, it's a standing configuration gap the user
 * can fix in their browser settings whenever they want.
 */

const DISMISS_KEY = 'homecam:push-denied-banner-dismissed-until'
const DISMISS_DAYS = 7
const DISMISS_MS = DISMISS_DAYS * 24 * 60 * 60 * 1000

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const until = Number(raw)
    if (!Number.isFinite(until)) return false
    return Date.now() < until
  } catch {
    // Storage unavailable (private-mode Safari, quota) — fail open so
    // the banner still shows rather than silently vanishing forever.
    return false
  }
}

function permissionDenied(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'denied'
}

export function PushDeniedBanner() {
  const { state: authState } = useAuth()
  const [dismissed, setDismissed] = useState(isDismissed)

  // Permission is a static OS-level gate for the lifetime of this
  // mount — no Permissions-API `onchange` is wired for Notification
  // in most browsers, and the app already gets a fresh mount on next
  // navigation/reload if the user flips it. No poll needed here.
  const shouldShow = authState === 'authed' && permissionDenied() && !dismissed

  if (!shouldShow) return null

  function handleDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS))
    } catch {
      // Best effort — if storage write fails the banner just
      // reappears next mount, a harmless degrade.
    }
    setDismissed(true)
  }

  return (
    <div
      role="status"
      // Safe-area inset matches ConnectionBanner's grammar exactly —
      // same iOS PWA standalone status-bar clearance.
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 6px)' }}
      className="fixed top-0 inset-x-0 lg:left-[var(--sidenav-width,4rem)] z-30 px-3 pb-1.5 text-center text-xs font-semibold border-b backdrop-blur bg-[var(--color-warning-bg)] text-[var(--color-text-primary)] border-[var(--color-warning-border)]"
    >
      <span className="inline-flex flex-wrap items-center justify-center gap-2">
        <span aria-hidden="true" className="w-2 h-2 rounded-full bg-[var(--color-warning)] flex-shrink-0" />
        <span>
          Notifications are blocked by your phone. HomeCam can&apos;t alert you until you allow them in your browser settings.
        </span>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss notifications-blocked warning"
          className="ml-1 underline underline-offset-2 text-[var(--color-text-primary)] hover:text-[var(--color-accent-default)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
        >
          Dismiss
        </button>
      </span>
    </div>
  )
}
