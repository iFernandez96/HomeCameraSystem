import { useState } from 'react'
import { PawMark } from '../components/CatIcons'
import { LiveStats } from '../components/LiveStats'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { Button } from '../components/primitives/Button'
import { captureSnapshot, HttpError, toggleDetection } from '../lib/api'
import { formatAge } from '../lib/format'
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
    // iter-356.56 (UI redesign architect Live brief, Step 1): max-w
    // bumped 5xl → 7xl so the desktop video tile fills its column
    // instead of leaving 60% of the viewport as cream void. Grid
    // shifts from 3-col equal-weight to `[1fr_320px]` so the right
    // sidebar is a fixed 320 px context rail and the video grows.
    // Sidebar is sticky on lg so context stays reachable when the
    // video tile is taller than the viewport.
    <div className="p-4 space-y-4 max-w-7xl mx-auto">
      {/* iter-355ac (Maya Major): the right-aligned "homecam" wordmark
          was a non-interactive debug label. SideNav already brands the
          app — drop the floating label, keep the camera name as a
          clean H1.
          iter-356.56 (Maya CRITICAL Live #4): added a subtitle row
          with armed-state + last-event age so the page title earns
          its real estate as a security command center, not a bare
          camera name floating above a black box. */}
      <header className="space-y-1">
        <h1 className="page-title text-2xl inline-flex items-center gap-2">
          <PawMark className="text-[var(--color-accent-default)]" />
          {cameraLabel}
        </h1>
        <CameraSubtitle status={status} />
      </header>

      {/* iter-356.56 (Maya CRITICAL Live #2 + UI redesign brief
          Section 2): page-level system-state banner sits between
          header and grid. One scannable line that mirrors the
          worker/detection/thermal/memory state hierarchy from
          computeHealth. Color tells the user at a glance whether
          the camera is doing its job. */}
      <SystemStateBanner status={status} />

      {/* iter-356.56: grid layout with 320px sidebar. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        <div>
          <VideoTile
            src={whepUrl()}
            detectionActive={detectionActive}
            workerAlive={workerAlive}
            lowMemory={lowMemory}
            thermal={thermal}
            streamStaleSeconds={streamStaleSeconds}
          />
        </div>
        <div className="space-y-4 lg:sticky lg:top-4">
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
                  toast instead.
                  iter-356.56 (Maya Major + Frank L3): dropped the
                  "Soon" caption. Roadmap-leak engineer-voice. The
                  toast on tap explains the state without a
                  permanent visible caption that reads as "shipped
                  half a feature." */}
              <ActionButton
                label="Talk"
                icon={<MicIcon />}
                onClick={onTalk}
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
  // iter-356.57 (cat-brand brief): toggle pill labels reduced to
  // role-bare-bones ("On watch" / "Off duty"). The banner above
  // already names Panther; the pill is the actionable status, not
  // the narrative. Sans-only here per security UX guardrail —
  // never serif on status copy.
  const stateLabel = isActive
    ? 'On watch'
    : isPaused
      ? "Panther's off duty"
      : 'Checking status…'
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
function CameraSubtitle({ status }: { status: import('../lib/types').ServerStatus | null }) {
  if (!status) {
    return (
      <p className="text-sm text-[var(--color-text-tertiary)]">
        Connecting to the camera…
      </p>
    )
  }
  const armed = status.detection_active === true && status.worker_alive === true
  // iter-356.57: subtitle leads with the cat on duty when armed; on
  // hardware failure / paused, attribution drops back to the role
  // (security UX guardrail — no cat names on hard errors).
  const armedLabel = !status.worker_alive
    ? 'Camera offline'
    : status.detection_active
      ? "Panther on watch"
      : "Off duty"
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
  return (
    <p
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-text-secondary)]"
      aria-label={`Camera status: ${armedLabel}${lastFrameLabel ? ', ' + lastFrameLabel : ''}`}
    >
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className={`w-2 h-2 rounded-full ${armedDot}`} />
        <span className={armed ? 'text-[var(--color-success)] font-medium' : 'font-medium'}>
          {armedLabel}
        </span>
      </span>
      {lastFrameLabel && (
        <>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span>{lastFrameLabel}</span>
        </>
      )}
    </p>
  )
}

/**
 * iter-356.56 (Maya CRITICAL Live #2 + redesign brief Section 2):
 * full-width status banner between header and grid. Replaces the
 * pattern of users mentally parsing the DetectionStatusToggle +
 * LiveStats cards to figure out "is the camera doing its job."
 *
 * Reuses the same signal hierarchy as LiveStats.computeHealth via
 * a thin local mapping. Color-coded by severity (success / warning /
 * danger / info). aria-live="polite" so screen readers announce
 * state transitions without spam (no aria-atomic).
 */
function SystemStateBanner({ status }: { status: import('../lib/types').ServerStatus | null }) {
  if (!status) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-4 py-2.5 text-sm text-[var(--color-text-secondary)]"
      >
        <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-[var(--color-text-tertiary)] animate-pulse" />
        <span>Connecting to the camera…</span>
      </div>
    )
  }
  const gear = status.worker_metrics?.gear
  // iter-356.57 (cat-brand brief): role-based status phrasing.
  // Panther = the Sentry (active detection); Coco = the Peacekeeper
  // (calm/quiet hours). System failures stay attribution-free —
  // hardware errors aren't a cat's fault and the security UX
  // guardrail forbids cat-themed glyphs on danger surfaces.
  // Mirror LiveStats.computeHealth precedence so the banner and the
  // sidebar health summary never disagree.
  let level: 'ok' | 'warn' | 'error' = 'ok'
  let label = "Panther's watching — all clear at the door."
  if (!status.worker_alive) {
    level = 'error'
    label = 'Camera offline — reconnecting…'
  } else if (gear === 'low-memory') {
    level = 'error'
    label = 'System under pressure — detection paused.'
  } else if (gear === 'thermal-throttled') {
    level = 'warn'
    label = 'Running warm — detection may miss fast movement.'
  } else if (status.detection_active === false || gear === 'off') {
    level = 'warn'
    label = "Panther's off duty — tap Resume to arm."
  } else if (gear === 'scheduled-off') {
    level = 'warn'
    label = "Coco's hours — detection resumes on schedule."
  } else if (
    status.memory_used_mb != null &&
    status.memory_total_mb &&
    status.memory_used_mb / status.memory_total_mb >= 0.9
  ) {
    level = 'warn'
    label = 'Memory tight — heavy detection may slow.'
  }
  const surface =
    level === 'ok'
      ? 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success)]'
      : level === 'warn'
        ? 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
        : 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
  const dot =
    level === 'ok'
      ? 'bg-[var(--color-success)]'
      : level === 'warn'
        ? 'bg-[var(--color-warning)]'
        : 'bg-[var(--color-danger)]'
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm font-medium ${surface}`}
    >
      <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full ${dot}`} />
      <span>{label}</span>
    </div>
  )
}
