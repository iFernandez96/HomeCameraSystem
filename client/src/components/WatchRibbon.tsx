import { useNavigate } from 'react-router-dom'
import { CatTrioMark } from './CatIcons'
import { useStatus } from '../lib/useStatus'
import { formatAge } from '../lib/format'

/**
 * iter-356.58 (layout rebuild): the WatchRibbon is a persistent top
 * bar that sits across every authed route. It replaces:
 *   - the generic per-page `<h1 className="page-title"><PawMark />{label}</h1>`
 *     pattern that was repeated identically on Live / Events / People /
 *     Training / Settings (a SaaS-template tell)
 *   - the SideNav's brand row (which now lives here)
 *   - the per-page system-state banner (status moves here, persists)
 *
 * Structural goal: turn the app shell from "sidebar + content + h1"
 * into "ribbon + rail + content." The ribbon is the security
 * console's top bar — armed state + camera name + last-frame age +
 * a quick Capture button — and it's the SAME across every route.
 *
 * Contract: this component is rendered inside <AppShell> ONCE; it
 * owns one instance of `useStatus()` polling and broadcasts via the
 * existing iter-37 cache. Adding it does NOT add a second poll.
 *
 * Layout shape (desktop ≥ lg):
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ☷ HomeCam      ●Armed · Front Door · 4s ago    [⊕]  │  56px
 *   ├─[64px icon rail]─────────────────────────────────── │
 *   │ │                                                  │
 *   │ │              <Routed page content>               │
 *   │ │                                                  │
 *   └─┴──────────────────────────────────────────────────┘
 *
 * On mobile (< lg): only the center cluster remains visible
 * (HomeCam wordmark hidden, Capture button hidden) so the ribbon
 * fits in 56px.
 */
export function WatchRibbon() {
  const status = useStatus()
  const navigate = useNavigate()

  const armed = status?.detection_active === true && status?.worker_alive === true
  const offline = status != null && status.worker_alive === false
  const dotClass = offline
    ? 'bg-[var(--color-danger)]'
    : armed
      ? 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
      : 'bg-[var(--color-warning)]'
  const stateLabel = offline
    ? 'Camera offline'
    : armed
      ? 'On watch'
      : status?.detection_active === false
        ? 'Off duty'
        : '…'

  const cameraLabel = status?.camera_label ?? 'Front Door'
  const lastFrameLabel =
    !status
      ? null
      : status.seconds_since_last_frame == null
        ? null
        : status.seconds_since_last_frame < 5
          ? 'Live now'
          : `${formatAge(status.seconds_since_last_frame)} ago`

  return (
    <header
      role="banner"
      // iter-356.58: tokenized surface + 56px height. Sticky so it
      // stays pinned during page-content scroll. The ribbon is NOT
      // inside <main> — it lives between the ConnectionBanner and
      // the rail+content row, so it's the authoritative "you are
      // here, the system is in state X" anchor.
      className="flex items-center justify-between px-4 lg:px-6 h-14 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)]/95 backdrop-blur sticky top-0 z-[15] shadow-[var(--shadow-subtle)]"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* LEFT: brand cluster (desktop only — on mobile the rail+nav
          covers brand identity). Tapping the wordmark navigates
          home (Live). */}
      <button
        type="button"
        onClick={() => navigate('/live')}
        aria-label="HomeCam home"
        className="hidden lg:flex items-center gap-2 group focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
      >
        <CatTrioMark size={28} ariaLabel="" />
        <span className="font-display text-lg font-bold leading-none text-[var(--color-text-primary)] group-hover:text-[var(--color-accent-default)] transition-colors">
          HomeCam
        </span>
      </button>

      {/* CENTER: live-watch state cluster. This is the always-visible
          security signal. dot + state + camera + last-frame. */}
      <div
        className="flex-1 flex items-center justify-start lg:justify-center gap-2.5 min-w-0 ml-2 lg:ml-0"
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotClass}`} />
        <span
          className={`text-sm font-semibold flex-shrink-0 ${
            offline
              ? 'text-[var(--color-danger)]'
              : armed
                ? 'text-[var(--color-success)]'
                : 'text-[var(--color-warning)]'
          }`}
        >
          {stateLabel}
        </span>
        <span aria-hidden="true" className="text-[var(--color-text-tertiary)] hidden sm:inline">
          ·
        </span>
        <span className="text-sm text-[var(--color-text-primary)] font-medium truncate hidden sm:inline">
          {cameraLabel}
        </span>
        {lastFrameLabel && (
          <>
            <span aria-hidden="true" className="text-[var(--color-text-tertiary)] hidden md:inline">
              ·
            </span>
            <span className="text-xs text-[var(--color-text-tertiary)] hidden md:inline tabular-nums">
              {lastFrameLabel}
            </span>
          </>
        )}
      </div>

      {/* RIGHT: jump-to-Live action. Hidden on mobile because the
          BottomNav already exposes it. */}
      <button
        type="button"
        onClick={() => navigate('/live')}
        aria-label="Jump to Live view"
        className="hidden lg:inline-flex items-center justify-center h-9 px-3 rounded-lg text-xs font-semibold text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
      >
        Jump to Live
      </button>
    </header>
  )
}
