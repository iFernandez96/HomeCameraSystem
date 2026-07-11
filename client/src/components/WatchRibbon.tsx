import { useNavigate } from 'react-router-dom'
import { CatTrioMark } from './CatIcons'
import { useStatus } from '../lib/useStatus'
import { formatAge } from '../lib/format'
import {
  WATCH_STATE_LABEL,
  watchStateDotClass,
  watchStateOf,
  watchStateTextClass,
} from '../lib/watchState'

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

  // Overhaul W1 item 2 (one state vocabulary): the label + dot logic
  // that used to be duplicated (with drifting word sets) across this
  // ribbon, Watch's glance card, and Watch's fullscreen cluster now
  // lives in lib/watchState.ts. The ribbon has no video-truth channel
  // so it omits `videoPlaying`.
  const stateKind = watchStateOf({
    statusKnown: status != null,
    workerAlive: status?.worker_alive ?? null,
    detectionActive: status?.detection_active ?? null,
    detectionFramesStale:
      status?.worker_alive === true &&
      status.seconds_since_last_frame != null &&
      status.seconds_since_last_frame > 60,
  })
  const dotClass = watchStateDotClass(stateKind)
  const stateLabel = WATCH_STATE_LABEL[stateKind]

  const cameraLabel = status?.camera_label ?? 'Front Door'
  const lastFrameLabel =
    !status
      ? null
      : status.seconds_since_last_frame == null
        ? null
        : status.seconds_since_last_frame < 5
          ? 'Detection live'
          : status.seconds_since_last_frame > 60
            ? 'Detection delayed'
            : `Detection ${formatAge(status.seconds_since_last_frame)} ago`

  return (
    <header
      role="banner"
      // iter-356.58: tokenized surface + 56px height. Sticky so it
      // stays pinned during page-content scroll. The ribbon is NOT
      // inside <main> — it lives between the ConnectionBanner and
      // the rail+content row, so it's the authoritative "you are
      // here, the system is in state X" anchor.
      // iter-356.x (mobile audit A1): pre-fix the ribbon was a fixed
      // 56px box with safe-area padding INSIDE that height. On a
      // notched iPhone the inset (~44px) compressed the content row
      // to ~12px, stacking text on top of the iOS clock. Now: min-h
      // so the ribbon expands to host both the safe-area inset and
      // the 56px content row. Android (zero inset) collapses to the
      // original 56px exactly.
      // Premium-launch slice (mobile-view-auditor A1): lateral
      // safe-area insets in landscape. Pre-fix the ribbon set
      // `paddingTop` for the iPhone notch but had no
      // `safe-area-inset-left/right` — in landscape PWA standalone
      // on a notched iPhone, the Dynamic Island clips ~47 px from
      // the left and the home-indicator strip clips ~21 px from
      // the right. The ribbon's armed-state dot + label (the most
      // load-bearing security signal in the entire app) was
      // partially behind the notch on every cold landscape session.
      // `max(1rem, env(...))` preserves the prior 16 px gutter on
      // devices with no inset (Android, all desktops) and expands
      // it only when the OS reports an inset.
      // Nav-coherence fix (painfix): on landscape-phone, BottomNav docks
      // as a left rail (App.tsx's <main> reserves
      // `landscape-phone:ml-[calc(4rem+env(safe-area-inset-left))]` for
      // it). This full-bleed sticky ribbon had no matching inset, so
      // its `bg-[var(--color-surface-scrim)]` surface painted straight
      // OVER the rail on every non-Watch route (the rail sits at z-10,
      // the ribbon at z-[15]). A `padding-left` fix wouldn't have
      // solved it — the ribbon's background would still extend behind
      // the rail even with padded content. `margin-left` shrinks the
      // ribbon's box itself so it starts to the right of the rail,
      // mirroring exactly the calc `<main>` already uses. Portrait and
      // desktop (`lg:`) are untouched — the rail only docks left under
      // `landscape-phone:`.
      className="flex items-center justify-between min-h-14 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-scrim)] backdrop-blur sticky top-0 z-[15] shadow-[var(--shadow-subtle)] landscape-phone:ml-[calc(4rem+env(safe-area-inset-left))]"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      {/* LEFT: brand cluster (desktop only — on mobile the rail+nav
          covers brand identity). Tapping the wordmark navigates
          home (Live). */}
      <button
        type="button"
        onClick={() => navigate('/')}
        aria-label="HomeCam home"
        // Bug sweep (2026-07-02): the brand mark now shows on MOBILE
        // too — without it the ribbon on non-Watch pages was a bare
        // "● On watch" strip with a dead left half. The wordmark
        // stays desktop-only; the trio mark alone carries brand at
        // 390px.
        className="flex items-center gap-2 group focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
      >
        <CatTrioMark size={28} ariaLabel="" />
        <span className="hidden lg:inline font-display text-lg font-bold leading-none text-[var(--color-text-primary)] group-hover:text-[var(--color-accent-default)] transition-colors">
          HomeCam
        </span>
      </button>

      {/* CENTER: live-watch state cluster. This is the always-visible
          security signal. dot + state + camera + last-frame.
          iter-356.63 (Slice D a11y): role="status" + aria-live moved
          OFF the wrapper and DOWN to the smaller status-pill scope.
          Pre-fix the entire cluster was a live region, so every
          5-second status poll re-announced the camera-name AND the
          last-frame age ("On watch · Front Door · 4s ago" → "On
          watch · Front Door · 5s ago" repeatedly). Now only the
          armed-state pill is announced; camera + age are static
          surface details for sighted users. */}
      <div className="flex-1 flex items-center justify-start lg:justify-center gap-2.5 min-w-0 ml-2 lg:ml-0">
        <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotClass}`} />
        <span
          role="status"
          aria-live="polite"
          className={`text-sm font-semibold flex-shrink-0 ${watchStateTextClass(stateKind)}`}
        >
          {stateLabel}
        </span>
        <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">
          ·
        </span>
        <span className="text-sm text-[var(--color-text-primary)] font-medium truncate">
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
        onClick={() => navigate('/')}
        aria-label="Jump to Live view"
        className="hidden lg:inline-flex items-center justify-center h-9 px-3 rounded-xl text-xs font-semibold text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
      >
        Jump to Live
      </button>
    </header>
  )
}
