import { useState } from 'react'
import { CaptureSavingPill } from '../components/CaptureSavingPill'
import { LiveStats } from '../components/LiveStats'
import { RecordingIndicator } from '../components/RecordingIndicator'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { Button } from '../components/primitives/Button'
import { captureSnapshot, HttpError, toggleDetection } from '../lib/api'
import { formatAge } from '../lib/format'
import {
  type SentryCat,
  sentryOffDutyLabel,
  sentryOnWatchLabel,
  useSentryCat,
} from '../lib/sentryCat'
import { useStatus } from '../lib/useStatus'
import { useToast } from '../lib/toast'

// iter-305 (user "How do I know which cam is which? Right now, I
// only have 1 camera, but it is not labeled at all"): default
// fallback for the Live page header until /api/status returns its
// inlined `camera_label`. iter-313 dropped the dedicated
// /api/detection/config mount-fetch in favour of the status poll
// (which already runs every 5 s anyway).
const _DEFAULT_CAMERA_LABEL = 'Front Door'

function whepUrl() {
  // iter-244b: same-origin path-based WHEP. Pre-iter-244b this composed
  // `<proto>//<host>:8889/cam/whep` directly — fine on LAN where the
  // browser can hit the Jetson's :8889 port over HTTP, broken over the
  // iter-244 Tailscale Serve HTTPS proxy because (a) the proxy only
  // forwards :443 not :8889, and (b) browsers refuse mixed-content
  // (HTTPS page → HTTP MediaMTX).
  //
  // Fix: route WHEP through the Tailscale Serve path proxy at
  // `/whep/*` (configured `tailscale serve --bg --https=443
  // --set-path=/whep http://localhost:8889`). Same origin as the page,
  // so HTTPS preserved, no mixed content, no extra port. Vite dev
  // server proxies `/whep` → `http://localhost:8889` for parity (see
  // vite.config.ts).
  return `${window.location.origin}/whep/cam/whep`
}

export function Live() {
  const [busy, setBusy] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const status = useStatus()
  const { showToast } = useToast()
  // iter-356.64 / mobile-redesign Slice B: sentry-cat rotation. The
  // "on watch" / "off duty" headline used to be hardcoded to Panther;
  // now it cycles through Panther / Mushu / Coco on a 30-min slot
  // (see lib/sentryCat.ts). One call at the page root so every
  // surface that reads it (DetectionStatusToggle pill +
  // CameraSubtitle gradient) renders the SAME cat for the slot.
  const sentryCat = useSentryCat()
  // iter-313 (perf #3): camera_label + audio_enabled are inlined on
  // /api/status now. Read directly from the status poll instead of
  // a dedicated /api/detection/config mount-fetch. Saves 1 RTT per
  // Live nav. Fallbacks: "Front Door" until the first status
  // arrives, audio_enabled defaults to false.
  const cameraLabel = status?.camera_label ?? _DEFAULT_CAMERA_LABEL
  // iter-356.56: dropped — Talk's "Soon" caption was also dropped, so
  // the audio_enabled flag has no remaining consumer on this page.
  // When two-way audio ships, the toast/handler in onTalk + a real
  // recording-state read are the surfaces that grow back.

  // iter-308: Talk handler placeholder. Real WebRTC mic upstream
  // lands when the user wires hardware — see
  // memory/two_way_audio_plan_iter308.md for the WHIP + ALSA design.
  // For now, a friendly toast so the user knows the button DID
  // register their click (vs a silent no-op).
  const onTalk = () => {
    showToast(
      'Talking through the camera will work once the mic + speaker are wired up.',
      'info',
    )
  }
  const detectionActive = status?.detection_active ?? null
  const workerAlive = status?.worker_alive ?? null
  // iter-302: stream-stale signal. Worker can be alive while the
  // RTSP stream is silent (the iter-300 outage signature). Forward
  // to VideoTile so it can render the "No video — stream stalled"
  // pill at top of the precedence ladder.
  const streamStaleSeconds = status?.seconds_since_last_frame ?? null
  // Worker self-reports `gear: 'low-memory'` when the MemoryGuard
  // (iter-33) trips. Treat null/missing as "not low memory" — we don't
  // want to flash LOW MEMORY before the first heartbeat lands.
  const lowMemory = status?.worker_metrics?.gear === 'low-memory'
  // Same shape for the iter-89 ThermalGuard.
  const thermal = status?.worker_metrics?.gear === 'thermal-throttled'

  const onSnapshot = async () => {
    setBusy('snapshot')
    try {
      const r = await captureSnapshot()
      setPreviewUrl(r.url)
    } catch (e) {
      // 503 from /api/capture means the worker hasn't produced a recent
      // `latest.jpg` yet (server boot, RTSP reconnect, idle gear pause).
      // The user can just retry. Other errors get a generic message.
      // iter-356.56 (Frank L2): every error toast carries a recovery
      // hint. "Snapshot failed" left users with no path forward.
      if (e instanceof HttpError && e.status === 503) {
        showToast('No recent frame yet — try again in a moment.', 'error')
      } else if (e instanceof HttpError && e.status === 401) {
        showToast('Sign in expired — refresh the page to continue.', 'error')
      } else {
        showToast(
          "Couldn't take the snapshot — check the camera is on, then try again.",
          'error',
        )
      }
      console.error(e)
    } finally {
      setBusy(null)
    }
  }

  const onToggleDetect = async () => {
    setBusy('detect')
    try {
      const r = await toggleDetection()
      // iter-356.56 (Frank L2): success copy spells out what the
      // user just changed instead of a terse "Detection on".
      showToast(
        r.active
          ? 'Detection on — the camera is watching for visitors.'
          : 'Detection off — alerts are paused.',
        'success',
      )
    } catch (e) {
      showToast(
        "Couldn't change detection — check your connection and try again.",
        'error',
      )
      console.error(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    // iter-356.58 (LAYOUT REBUILD): Live is no longer a "page with
    // header + grid + cards." It is a command-center surface where
    // the video field DOMINATES the viewport. Per architect brief:
    //   - kill the page-title <h1> + paw-mark + subtitle row
    //     (WatchRibbon already carries armed state on every page)
    //   - kill the SystemStateBanner (duplicated in WatchRibbon)
    //   - kill the right-rail card cluster on desktop
    //   - replace with: full-bleed video field that fills available
    //     height, status overlays ON the video (camera name +
    //     armed badge bottom-left, action cluster bottom-right),
    //     compact watch-panel column on lg+ that floats over the
    //     right edge of the video, and a horizontal recent-events
    //     strip below the video.
    // iter-356.65 (Mira critic blocker #1): 100vh on Android Chrome
    // includes the URL bar's would-be space; bar collapse on scroll
    // resizes the video tile by ~56 px every session. 100dvh tracks
    // the visible viewport portion regardless of bar state. Both
    // Chrome 108+ and Safari 15.4+ support it, which covers every
    // tailnet-installed device in this household.
    <div className="flex flex-col h-[calc(100dvh-3.5rem-5rem)] lg:h-[calc(100dvh-3.5rem)]">
      {/* iter-356.63 (Slice D a11y): sr-only <h1> per route. The
          visible page identity is owned by the WatchRibbon and the
          on-video badge; AT users still need a level-1 heading. */}
      <h1 className="sr-only">Live camera</h1>
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden lg:rounded-tl-2xl">
        {/* The cinematic video field. fills 100% of this region. */}
        <VideoTile
          src={whepUrl()}
          detectionActive={detectionActive}
          workerAlive={workerAlive}
          lowMemory={lowMemory}
          thermal={thermal}
          streamStaleSeconds={streamStaleSeconds}
        />

        {/* Bottom gradient + identity strip — camera name + armed
            dot + last-frame age. This replaces the per-page H1.
            pointer-events-none so the video clicks (fullscreen
            button etc.) still pass through to the video tile;
            individual interactive children in this overlay opt
            back in via pointer-events-auto. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 sm:px-6 pb-4 pt-16 bg-gradient-to-t from-black/85 via-black/40 to-transparent">
          <div className="flex items-end justify-between gap-4">
            <div className="flex items-end gap-3 min-w-0">
              {/* iter-356.63 (Slice D a11y): demoted from <h1> to
                  <h2>. The route-level <h1 className="sr-only"> at
                  the top of the page is the single level-1 anchor;
                  the visible camera-label is a section heading
                  (which camera you're looking at), which is an h2
                  job. Two-h1-per-route was confusing the AT
                  document outline. */}
              <h2 className="font-display text-2xl sm:text-3xl font-bold text-white leading-none truncate">
                {cameraLabel}
              </h2>
              <CameraSubtitle status={status} sentryCat={sentryCat} onDark />
            </div>
            {/* iter-356.C (mobile-redesign Slice C — security clarity):
                ArmedBadge + RecordingIndicator + CaptureSavingPill
                co-locate as a single trust-cluster on the bottom-right
                of the video. ArmedBadge = "is detection looking?",
                RecordingIndicator = "is video being saved right now?",
                CaptureSavingPill = "are face crops being saved for
                training?". Three independent signals; each pill
                self-gates so the cluster only crowds when there's
                something to say. */}
            <div className="flex pointer-events-auto items-center gap-2 flex-wrap justify-end">
              {/* iter-356.65 (Mira critic blocker #3): trust-cluster
                  pills must render at every viewport, not gated to
                  sm+. A guest on a 360-px Pixel needs to see "is
                  this thing recording me" the same as a desktop
                  user. flex-wrap absorbs the line breaks. */}
              <ArmedBadge status={status} />
              <RecordingIndicator status={status} />
              <CaptureSavingPill />
            </div>
          </div>
        </div>

        {/* Floating action cluster — bottom-right edge of the video.
            Compact pill column on lg+, horizontal row on mobile.
            pointer-events-auto so taps register. */}
        {/* iter-356.66 (real-device fix): the iter-356.65 fix dropped
            `hidden sm:` from this cluster, which doubled the mobile
            UI — phones already render a card-style action strip
            below the video (`<div className="sm:hidden ...">` with
            DetectionStatusToggle + Snapshot + Talk). With the
            overlay also visible, mobile users saw THREE copies of
            "On watch / Pause / Snapshot / Talk" stacked vertically
            AND the overlay overlapped the camera-label text on the
            video gradient strip ("Front Door" → "Fr..." truncated).
            Restoring `hidden sm:flex` here keeps the overlay as a
            DESKTOP affordance only; the mobile strip below remains
            the thumb surface. Mira's blocker #3 was about the
            TRUST cluster (ArmedBadge / RecordingIndicator /
            CaptureSavingPill) — that one stays always-visible
            (the row above this comment). */}
        <div className="pointer-events-auto absolute bottom-4 right-3 sm:right-4 hidden sm:flex flex-col gap-2 items-end">
          <DetectionStatusToggle
            detectionActive={detectionActive}
            onToggle={onToggleDetect}
            loading={busy === 'detect'}
            sentryCat={sentryCat}
            compact
          />
          <div className="flex flex-row gap-2">
            <ActionButton
              label="Snapshot"
              icon={<CameraIcon />}
              onClick={onSnapshot}
              loading={busy === 'snapshot'}
              dark
            />
            <ActionButton
              label="Talk"
              icon={<MicIcon />}
              onClick={onTalk}
              dark
            />
          </div>
        </div>

        {/* Watch panel — compressed health card floating on the
            top-right corner of the video. Desktop-only. Replaces
            the iter-356.56 separate-card right-rail. */}
        <div className="hidden lg:block absolute top-4 right-4 w-[260px]">
          <LiveStats status={status} compact />
        </div>
      </div>

      {/* Mobile-only action strip below the video. The desktop
          version lives as overlays on the video itself. */}
      <div className="sm:hidden flex flex-col gap-2 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <DetectionStatusToggle
          detectionActive={detectionActive}
          onToggle={onToggleDetect}
          loading={busy === 'detect'}
          sentryCat={sentryCat}
        />
        <div className="grid grid-cols-2 gap-2">
          <ActionButton
            label="Snapshot"
            icon={<CameraIcon />}
            onClick={onSnapshot}
            loading={busy === 'snapshot'}
          />
          <ActionButton
            label="Talk"
            icon={<MicIcon />}
            onClick={onTalk}
          />
        </div>
      </div>

      {/* Mobile-only health strip below the action strip. */}
      <div className="sm:hidden px-4 py-3">
        <LiveStats status={status} />
      </div>

      {previewUrl && (
        <SnapshotPreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
  )
}

/**
 * iter-356.58: armed-state badge on the dark video gradient.
 * Bigger than the WatchRibbon dot, designed to read against the
 * black video bg. Mirrors the ribbon's truth-source so it never
 * disagrees, but visually it's a meaningful 32px pill that the
 * eye lands on as you look at the camera feed.
 */
function ArmedBadge({ status }: { status: import('../lib/types').ServerStatus | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-black/55 backdrop-blur px-3 py-1.5 text-xs text-white/80 ring-1 ring-white/20">
        <span aria-hidden="true" className="w-2 h-2 rounded-full bg-white/40 animate-pulse" />
        Connecting…
      </span>
    )
  }
  const armed = status.detection_active === true && status.worker_alive === true
  const offline = status.worker_alive === false
  const label = offline ? 'Offline' : armed ? 'Armed' : 'Off duty'
  const dotClass = offline
    ? 'bg-[var(--color-danger)]'
    : armed
      ? 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
      : 'bg-[var(--color-warning)]'
  const ringClass = offline
    ? 'ring-[var(--color-danger)]/40'
    : armed
      ? 'ring-[var(--color-success)]/40'
      : 'ring-[var(--color-warning)]/40'
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full bg-black/55 backdrop-blur px-3 py-1.5 text-xs font-semibold text-white ring-1 ${ringClass}`}
      aria-label={`Camera state: ${label}`}
    >
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${dotClass}`} />
      {label}
    </span>
  )
}

/**
 * iter-356.18 (Maya 12th CRITICAL #2): replaces the Detect button's
 * Stroop-violating treatment. When detection is ON, the old Detect
 * button rendered as a primary-blue CTA — the same treatment used
 * everywhere else for "tap me, default action." A returning user
 * read it as "I should tap this to start" and toggled detection OFF
 * by accident.
 *
 * Now: a status-pill that CONTAINS a stop/resume action. The pill
 * shape says "this is the system's current state"; the action label
 * says what tapping does. Visual vocabulary mirrors the System
 * Health card dot below it (green/amber + same token tier).
 *
 * Three states: active (green, "Watching" + "Pause" action), paused
 * (amber, "Paused" + "Watch" action), unknown (loading, label is
 * "Detect" until status arrives — same iter-356.17 fallback).
 */
function DetectionStatusToggle({
  detectionActive,
  onToggle,
  loading,
  sentryCat,
  compact,
}: {
  detectionActive: boolean | null
  onToggle: () => void
  loading: boolean
  sentryCat: SentryCat
  compact?: boolean
}) {
  const isActive = detectionActive === true
  const isPaused = detectionActive === false
  // iter-356.58 (layout rebuild): `compact` mode — overlaid on
  // the dark video field, so the surface flips to black/glass and
  // the text goes white. Default mode (non-compact) stays as
  // before for the mobile action strip.
  const dotClass = isActive
    ? 'bg-[var(--color-success)]'
    : isPaused
      ? 'bg-[var(--color-warning)]'
      : 'bg-white/40'
  // iter-356.64 / Slice B: paused-state copy now follows the rotating
  // sentry instead of the hardcoded Panther. Active-state stays the
  // generic "On watch" pill — the cat-named "X on watch" line lives
  // in the CameraSubtitle below the camera name (one cat-named
  // headline per surface, not two).
  const stateLabel = isActive
    ? 'On watch'
    : isPaused
      ? sentryOffDutyLabel(sentryCat)
      : 'Checking…'
  const actionLabel = loading
    ? isActive
      ? 'Pausing…'
      : 'Resuming…'
    : isActive
      ? 'Pause'
      : isPaused
        ? 'Resume'
        : 'Toggle'
  if (compact) {
    return (
      <button
        type="button"
        onClick={onToggle}
        disabled={loading}
        aria-pressed={isActive}
        aria-label={`${stateLabel}. Tap to ${isActive ? 'pause detection' : 'resume detection'}.`}
        className="inline-flex items-center gap-2.5 min-h-[44px] px-3 py-1.5 rounded-full bg-black/55 backdrop-blur ring-1 ring-white/15 hover:ring-white/30 text-white text-xs font-semibold focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-60 transition-colors"
      >
        <span aria-hidden="true" className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span>{stateLabel}</span>
        <span className="text-white/60">·</span>
        <span className="text-[var(--color-accent-bright)] font-semibold">{actionLabel}</span>
      </button>
    )
  }
  // Default (mobile non-overlay) mode — token-driven surface.
  const ringClass = isActive
    ? 'ring-[var(--color-success-border)]'
    : isPaused
      ? 'ring-[var(--color-warning-border)]'
      : 'ring-[var(--color-border)]'
  const labelClass = isActive
    ? 'text-[var(--color-text-primary)]'
    : isPaused
      ? 'text-[var(--color-warning)]'
      : 'text-[var(--color-text-secondary)]'
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      aria-pressed={isActive}
      aria-label={`${stateLabel}. Tap to ${isActive ? 'pause detection' : 'resume detection'}.`}
      className="w-full flex items-center justify-between gap-3 min-h-[56px] px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          aria-hidden="true"
          className={`w-2.5 h-2.5 rounded-full ${dotClass} ring-2 ${ringClass}`}
        />
        <span className={`text-sm font-medium truncate ${labelClass}`}>
          {stateLabel}
        </span>
      </div>
      <span className={`text-sm font-medium ${isPaused ? 'text-[var(--color-accent-default)]' : 'text-[var(--color-text-secondary)]'}`}>
        {actionLabel}
      </span>
    </button>
  )
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  loading,
  highlight,
  caption,
  dark,
}: {
  label: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  highlight?: boolean
  caption?: string
  dark?: boolean
}) {
  // iter-356.58 (layout rebuild): `dark` mode — overlaid on the
  // dark video field. Renders as a glass-pill button instead of
  // the surface-bg primitive. Loading + disabled states preserved.
  if (dark) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className="inline-flex items-center gap-2 min-h-[44px] px-4 py-1.5 rounded-full bg-black/55 backdrop-blur ring-1 ring-white/15 hover:ring-white/30 text-white text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-60 transition-colors"
        aria-pressed={highlight ? true : undefined}
      >
        {!loading && (
          <span aria-hidden="true" className="flex-shrink-0 inline-flex">
            {icon}
          </span>
        )}
        <span>{label}</span>
      </button>
    )
  }
  // iter-356.3a (Maya iter-355ac defer + Major iter-355c1):
  // vertical-stack icon-above-label → horizontal pill icon-left-
  // label-right. Built on the iter-356.2 Button primitive so:
  //   - active state uses primary (filled brand-blue) instead of
  //     a tinted-border treatment that read like a hover state
  //   - inactive state uses secondary (neutral outline)
  //   - loading state renders the primitive's spinner inline
  //   - 44 px touch target via size=md min-h
  // Caption sits OUTSIDE the button (was inside the column),
  // because iter-356.2 Button primitive renders a single horizontal
  // row.
  const captionId = caption ? `actionbtn-caption-${label}` : undefined
  return (
    <div className="flex flex-col">
      <Button
        variant={highlight ? 'primary' : 'secondary'}
        size="md"
        fullWidth
        onClick={onClick}
        disabled={disabled}
        loading={loading}
        aria-pressed={highlight ? true : undefined}
        aria-describedby={captionId}
      >
        {!loading && (
          <span className="flex-shrink-0 inline-flex" aria-hidden="true">
            {icon}
          </span>
        )}
        <span>{label}</span>
      </Button>
      {/* iter-356.47: always reserve the caption row's vertical space
          so a 2-up grid where one button has a caption ("Talk / Soon")
          and the other doesn't ("Snapshot") doesn't render with one
          column visibly taller than the other. The non-captioned span
          renders an invisible placeholder ("&nbsp;") with the same
          font + leading so both columns flush. aria-describedby
          wiring (iter-280) only fires when caption is present, so SR
          users still get the "Soon" hint scoped to Talk only. */}
      <span
        id={captionId}
        aria-hidden={caption ? undefined : true}
        className="text-[10px] text-[var(--color-text-tertiary)] mt-1 text-center leading-tight"
      >
        {caption || ' '}
      </span>
    </div>
  )
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}
function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}
// iter-356.18: BrainIcon removed — replaced by the new
// DetectionStatusToggle pill which uses a colored dot + state label
// instead of an icon. The eye/shield icon Frank suggested would also
// be a candidate; the dot+label is more explicit about state.

// iter-356.3a: local Spinner removed — Button primitive renders its
// own when loading=true. The ActionButton wrapper now defers to it.

/**
 * iter-356.56 (Maya CRITICAL Live #4): page-title subtitle row.
 *
 * Pre-fix: the H1 was a bare camera name floating above the video.
 * Premium home-cam apps (Nest, Ring, Eufy, Arlo) anchor the live
 * screen with the camera name PLUS a sub-line: armed state, last
 * activity timestamp, and stream resolution. We surface the
 * already-existing signals (detection_active + worker_alive +
 * seconds_since_last_frame) as a single scannable subtitle.
 */
function CameraSubtitle({
  status,
  sentryCat,
  onDark,
}: {
  status: import('../lib/types').ServerStatus | null
  sentryCat: SentryCat
  onDark?: boolean
}) {
  // iter-356.58 (layout rebuild): onDark variant for the video-
  // overlay placement (white-on-gradient). Default light variant
  // retained for the mobile action strip.
  const baseClass = onDark
    ? 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/85 leading-tight'
    : 'flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-text-secondary)]'
  if (!status) {
    return (
      <p className={baseClass}>
        <span>Connecting…</span>
      </p>
    )
  }
  const armed = status.detection_active === true && status.worker_alive === true
  // iter-356.64 / Slice B: the armed-state headline cycles cats via
  // sentry rotation. `key={sentryCat}` on the rendered span re-mounts
  // on slot flip → the .sentry-sparkle class plays its 600ms intro
  // (gated by prefers-reduced-motion in index.css).
  const armedLabel = !status.worker_alive
    ? 'Camera offline'
    : status.detection_active
      ? sentryOnWatchLabel(sentryCat)
      : 'Off duty'
  const armedDot = !status.worker_alive
    ? 'bg-[var(--color-danger)]'
    : status.detection_active
      ? 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
      : 'bg-[var(--color-warning)]'
  const lastFrame = status.seconds_since_last_frame
  const lastFrameLabel =
    typeof lastFrame === 'number'
      ? lastFrame < 5
        ? 'Live now'
        : `Last frame ${formatAge(lastFrame)} ago`
      : null
  const armedTextClass = onDark
    ? armed
      ? 'text-[var(--color-success)] font-semibold'
      : 'text-white font-semibold'
    : armed
      ? 'text-[var(--color-success)] font-medium'
      : 'font-medium'
  return (
    <p
      className={baseClass}
      aria-label={`Camera status: ${armedLabel}${lastFrameLabel ? ', ' + lastFrameLabel : ''}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={`w-2 h-2 rounded-full ${armedDot}`} />
        {/* iter-356.64 / Slice B: `key={sentryCat}` triggers a remount
            on every slot flip so the sentry-sparkle class plays its
            600ms intro on each cat handover. The keyframe is gated on
            prefers-reduced-motion in index.css. */}
        <span
          key={armed ? sentryCat : 'static'}
          className={`${armedTextClass} ${armed ? 'sentry-sparkle' : ''}`}
        >
          {armedLabel}
        </span>
      </span>
      {lastFrameLabel && (
        <>
          <span aria-hidden="true" className={onDark ? 'text-white/40' : 'opacity-40'}>·</span>
          <span className={onDark ? 'text-white/70' : ''}>{lastFrameLabel}</span>
        </>
      )}
    </p>
  )
}

/**
 * iter-356.58 (LAYOUT REBUILD): SystemStateBanner removed.
 * The persistent WatchRibbon at the top of the app shell now
 * carries armed-state attribution for every route. Repeating it
 * in the page body was duplication. The video-overlay <ArmedBadge>
 * gives the same signal at the moment of attention (looking at the
 * camera). The banner is dead.
 */
