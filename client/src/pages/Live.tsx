import { useState } from 'react'
import { PawMark } from '../components/CatIcons'
import { LiveStats } from '../components/LiveStats'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { Button } from '../components/primitives/Button'
import { captureSnapshot, HttpError, toggleDetection } from '../lib/api'
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
  // iter-313 (perf #3): camera_label + audio_enabled are inlined on
  // /api/status now. Read directly from the status poll instead of
  // a dedicated /api/detection/config mount-fetch. Saves 1 RTT per
  // Live nav. Fallbacks: "Front Door" until the first status
  // arrives, audio_enabled defaults to false.
  const cameraLabel = status?.camera_label ?? _DEFAULT_CAMERA_LABEL
  const audioEnabled = status?.audio_enabled === true

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
      if (e instanceof HttpError && e.status === 503) {
        showToast('No recent frame yet — try again in a moment', 'error')
      } else {
        showToast('Snapshot failed', 'error')
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
      showToast(`Detection ${r.active ? 'on' : 'off'}`, 'success')
    } catch (e) {
      showToast('Toggle failed', 'error')
      console.error(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    // iter-267 (mobile-desktop-coherence-auditor C1 follow-on): the
    // wrapper-level max-w-5xl was lifted off App.tsx; Live takes
    // its own cap because a 2000px-wide camera tile is wrong on a
    // 1920px monitor (loses LiveStats off-screen, video gets
    // genuinely too big). Centered with mx-auto to preserve the
    // pre-iter-267 visual.
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      {/* iter-355ac (Maya Major): the right-aligned "homecam" wordmark
          was a non-interactive debug label. SideNav already brands the
          app — drop the floating label, keep the camera name as a
          clean H1. */}
      <header>
        <h1 className="text-2xl font-semibold inline-flex items-center gap-2">
          <PawMark className="text-[var(--color-accent-default)]" />
          {cameraLabel}
        </h1>
      </header>

      {/* iter-261: side-by-side at lg+. Mobile: single column.
          Desktop: video left (2/3), action buttons + LiveStats
          right (1/3) so the user gets the live feed AND the
          context without scrolling. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <VideoTile
            src={whepUrl()}
            detectionActive={detectionActive}
            workerAlive={workerAlive}
            lowMemory={lowMemory}
            thermal={thermal}
            streamStaleSeconds={streamStaleSeconds}
          />
        </div>
        <div className="lg:col-span-1 space-y-4">
          {/* iter-356.18 (Maya 12th CRITICAL #1+#2): action panel
              hierarchy reshuffle.

              Pre-iter-356.18: 3 buttons of equal weight in a
              `grid-cols-3` row, Detect (the most important — controls
              whether the camera is watching) was the THIRD slot in
              reading order, AND when detection was active the Detect
              button rendered as a primary blue CTA (Stroop-effect
              violation: visual says "tap me!", actual meaning is
              "this is happening").

              Now: a card with TWO sections.
                1. Detection STATUS-PILL row (full-width, top): not a
                   CTA-styled button. Reads as a status surface with
                   a stop/resume affordance. Green dot when watching,
                   amber when paused. Same visual vocabulary as the
                   System Health card below.
                2. Snapshot + Talk row (2-up, secondary): smaller
                   pill buttons for the side actions. Snapshot is the
                   one-shot file capture; Talk is the iter-308 mic
                   placeholder.

              Wrapped in `bg-[var(--color-surface)] border rounded-2xl`
              to match LiveStats card. Pre-iter-356.18 the buttons
              floated unanchored while LiveStats below sat in a
              card — Maya MAJOR #2: "asymmetry feels unfinished." */}
          <section
            aria-label="Camera controls"
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-3 py-3 space-y-2.5"
          >
            <DetectionStatusToggle
              detectionActive={detectionActive}
              onToggle={onToggleDetect}
              loading={busy === 'detect'}
            />
            <div className="grid grid-cols-2 gap-2">
              <ActionButton
                label="Snapshot"
                icon={<CameraIcon />}
                onClick={onSnapshot}
                loading={busy === 'snapshot'}
              />
              {/* iter-280 + iter-308: Talk activates when
                  `audio_enabled` flips true (operator wires mic +
                  speaker + owner toggle in Settings).
                  iter-356.18 (Maya MAJOR #1): always wire the
                  onTalk toast — `disabled` makes the dead-button
                  problem worse (Frank's wife sees grey button +
                  "Soon" caption + no response on tap = "broken").
                  When audio is unwired, tap fires the explanatory
                  toast instead. */}
              <ActionButton
                label="Talk"
                icon={<MicIcon />}
                onClick={onTalk}
                caption={audioEnabled ? undefined : 'Soon'}
              />
            </div>
          </section>
          <LiveStats status={status} />
        </div>
      </div>

      {previewUrl && (
        <SnapshotPreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
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
}: {
  detectionActive: boolean | null
  onToggle: () => void
  loading: boolean
}) {
  const isActive = detectionActive === true
  const isPaused = detectionActive === false
  const dotClass = isActive
    ? 'bg-[var(--color-success)]'
    : isPaused
      ? 'bg-[var(--color-warning)]'
      : 'bg-[var(--color-text-tertiary)]'
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
  const stateLabel = isActive
    ? 'Watching for visitors'
    : isPaused
      ? 'Detection paused'
      : 'Detection status'
  const actionLabel = loading
    ? isActive
      ? 'Pausing…'
      : 'Resuming…'
    : isActive
      ? 'Pause'
      : isPaused
        ? 'Resume'
        : 'Toggle'
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
      {/* iter-356.19 (Frank Round-8 #2): dropped uppercase + tracking.
          Frank: "PAUSE reads like a button on a 1998 VCR. The state
          label on the left is sentence-case 'Watching for visitors';
          those two voices were fighting on the same row." */}
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
}: {
  label: string
  icon: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
  highlight?: boolean
  // iter-280: optional sub-label rendered beneath the main label,
  // used for status hints on disabled actions ("Soon" for Talk).
  caption?: string
}) {
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
      {caption && (
        <span
          id={captionId}
          className="text-[10px] text-[var(--color-text-tertiary)] mt-1 text-center"
        >
          {caption}
        </span>
      )}
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
