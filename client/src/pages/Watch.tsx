import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { CatEmptyState } from '../components/CatEmptyState'
import { EventRow } from '../components/EventRow'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { BrandMarkRow } from '../components/WhoMark'
import { captureSnapshot, searchEvents, HttpError } from '../lib/api'
import { clockTime, recognizedNames, relativeTime } from '../lib/eventLabel'
import { identityOf, type IdentityKind } from '../lib/identity'
import { useRipple } from '../lib/ripple'
import { sentryCatName, useSentryCat } from '../lib/sentryCat'
import { useToast } from '../lib/toast'
import { useTicker } from '../lib/useTicker'
import type { DetectionEvent } from '../lib/types'
import { useStatus } from '../lib/useStatus'

/**
 * Fuzz F4 (real device SM-S928U1, 2026-07-07): landscape fullscreen
 * left ~45% of the width as dead black bars because `object-contain`
 * letterboxes a 16:9 stream inside a landscape phone's much wider
 * (~19.5:9+) viewport. Portrait fullscreen deliberately keeps
 * `contain` (full-bleed mode note above) so the scene's edges are
 * never cropped — but on an already-wide landscape screen the crop a
 * `cover` fit introduces is minor (top/bottom sliver) and buys back
 * the wasted width, which reads far better for an immersive live
 * view. Tracks `matchMedia('(orientation: landscape)')` so the fit
 * mode follows physical rotation, not just the full/docked toggle.
 */
function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(orientation: landscape)')
    const onChange = () => setLandscape(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return landscape
}

/**
 * Watch — the app's home screen ("Home" in the Playroom Modern
 * redesign, structural overhaul 2026-07-02, restyled 2026-07-07).
 *
 * Modeled on the two patterns the market converged on (user-approved
 * mockups):
 *   - Google Home / Nest camera detail: live video pinned in the top
 *     ~40% of the screen, TODAY'S STORY as a scrollable timeline
 *     below (events + quiet gaps), plain-language glance cards.
 *   - Ring Live View: tapping the video expands to a FULL-BLEED
 *     immersive mode — floating status, thumb-rail actions, an
 *     hour scrubber with event markers, swipe/back to close.
 *
 * The expand is a CSS state on the SAME container (docked ↔ fixed
 * inset-0) so the WebRTC <video> never remounts — no reconnect
 * hiccup when entering/leaving full screen. Task 5 (Playroom Modern)
 * restyled the chrome AROUND that container (rounded card treatment,
 * floating pill overlays) — the container identity and toggle logic
 * are untouched.
 *
 * The WatchRibbon is hidden on this route below lg (App.tsx): the
 * on-video scrim carries the armed state there, and a second status
 * bar would say the same thing twice. At lg and wider the shell may
 * render the ribbon even in a short landscape viewport.
 */

const _DEFAULT_CAMERA_LABEL = 'Front Door'

function localMidnightTs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
}

/** Today's events, shared by the glance row (counts) and the story
 * list below it — lifted out of the timeline component so both can
 * read the same fetch. Visibility-aware refetch mirrors the Events
 * page pattern (CLAUDE.md load-bearing listener). */
function useTodayEvents() {
  const [events, setEvents] = useState<DetectionEvent[] | null>(null)
  const [quietSince, setQuietSince] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [refetchKey, setRefetchKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    searchEvents({ since_ts: localMidnightTs(), limit: 50 })
      .then((r) => {
        if (cancelled) return
        setEvents(r.items)
        // "Quiet since" is stamped at fetch time (not render time —
        // react-hooks/purity bans Date.now() in memos): if the latest
        // event is over an hour old, the timeline leads with a calm
        // dashed row instead of implying something just happened.
        const latest = r.items[0]?.ts
        setQuietSince(
          latest != null && Date.now() / 1000 - latest > 3600
            ? clockTime(latest)
            : null,
        )
        setError(false)
      })
      .catch((e) => {
        if (cancelled) return
        console.error(e)
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [refetchKey])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setRefetchKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Final whole-branch review fix batch #1: ClipModal's Delete pill
  // (see Watch()'s ClipModal usage below) needs a way to make this
  // list forget the just-deleted event. Reuses the EXISTING
  // refetch-key mechanism (the same one visibilitychange bumps above)
  // rather than adding a second, parallel invalidation path.
  const refetch = () => setRefetchKey((k) => k + 1)

  return { events, quietSince, error, refetch }
}

export function Watch() {
  const status = useStatus()
  const sentryCat = useSentryCat()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const ripple = useRipple()
  const isLandscape = useIsLandscape()
  const nowMs = useTicker()
  const { events, quietSince, error, refetch: refetchTodayEvents } = useTodayEvents()

  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [openEvent, setOpenEvent] = useState<DetectionEvent | null>(null)
  // Status-truth fix (server-restart contradiction, 2026-07-07): a
  // user saw "camera is down" while the live WebRTC feed was visibly
  // streaming — /api/status was briefly unreachable during a server
  // restart, and this page treated status-null the same as
  // status-confirmed-dead. `videoPlaying` is a THIRD, independent
  // truth channel (MediaMTX/WebRTC is a separate process from the
  // status API) so we can tell "the API doesn't know" apart from "the
  // camera is actually down". Tri-state on purpose: `null` = the
  // video tile hasn't confirmed either way yet (still connecting) —
  // NOT treated as a negative, so cold mount doesn't flash danger
  // before the first WHEP handshake resolves.
  const [videoPlaying, setVideoPlaying] = useState<boolean | null>(null)

  const detectionActive = status?.detection_active ?? null
  const workerAlive = status?.worker_alive ?? null
  const streamStaleSeconds = status?.seconds_since_last_frame ?? null
  const lowMemory = status?.worker_metrics?.gear === 'low-memory'
  const thermal = status?.worker_metrics?.gear === 'thermal-throttled'
  const cameraLabel = status?.camera_label ?? _DEFAULT_CAMERA_LABEL

  // Three-state truth model:
  //  1. STATUS-CONFIRMED DOWN — /api/status is reachable and says the
  //     worker is dead. Full danger treatment, regardless of video —
  //     unchanged from before this fix.
  //  2. STATUS UNKNOWN — /api/status is unreachable/erroring/hasn't
  //     loaded yet (useStatus collapses all of these to `status ===
  //     null` after its own failure-streak debounce). We DON'T claim
  //     the camera is down here on the API's say-so alone:
  //       - video confirmed playing -> low-alarm "reconnecting" state
  //       - video confirmed NOT playing (WHEP itself errored) -> both
  //         channels are dark, so treat it as really down
  //       - video not yet resolved either -> fall through to the
  //         existing neutral "Paused"/"Checking…" copy, same as
  //         pre-fix behavior.
  //  3. HEALTHY — as today.
  const statusConfirmedDown = status != null && status.worker_alive === false
  const statusUnknown = status == null
  const reconnecting = statusUnknown && videoPlaying === true
  const dangerDown = statusConfirmedDown || (statusUnknown && videoPlaying === false)
  const armed = detectionActive === true && workerAlive === true
  const unhealthy = dangerDown || lowMemory || thermal
  const stateLabel = dangerDown
    ? 'Camera offline'
    : armed
      ? 'On watch'
      : reconnecting
        ? 'Reconnecting…'
        : detectionActive === false
          ? 'Off duty'
          : 'Checking…'
  const dotClass = dangerDown
    ? 'bg-[var(--color-danger)]'
    : armed
      ? 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
      : reconnecting
        ? 'bg-[var(--color-warning)] animate-pulse'
        : detectionActive === false
          ? 'bg-[var(--color-warning)]'
          : 'bg-[var(--color-text-tertiary)]'
  // Fuzz F3/F13: the old `ageLabel` ("Live now" / "Ns ago") text chip
  // was dropped from the on-video chrome — it duplicated both this
  // tile's own connection-status pill and, in fullscreen, the
  // scrubber's LIVE pill.

  // Glance row copy — Step 3 of the Home redesign. "Watching" card
  // swaps to the full-contrast danger treatment when the camera is
  // offline or the worker has degraded to a low-memory/thermal gear
  // (whimsy never masks danger — CLAUDE.md).
  const watching = armed
  const watchingDetail = dangerDown
    ? statusConfirmedDown
      ? 'Check its power, then see Settings.'
      : "Can't reach the camera. Check its connection."
    : reconnecting
      ? 'Status reconnecting…'
      : lowMemory
        ? 'Paused: the system is low on memory.'
        : thermal
          ? 'Slowed down: the camera is running warm.'
          : watching
            ? `${sentryCatName(sentryCat)} is on watch · alerts on`
            : detectionActive === false
              ? 'Turn alerts on in Settings.'
              : 'Checking the camera…'
  const todayCount = events?.length ?? 0
  // Painfix wave B #1: this used to read "N person · M cat sightings",
  // which reads as N DISTINCT PEOPLE — but `persons` counts EVENTS, so
  // one person walking by 50 times over a day showed "50 people". Every
  // event.label === 'person' row is a SIGHTING, not a unique visitor
  // (no dedup by identity happens here), so both halves now say
  // "sighting(s)" consistently.
  const todayBreakdown = useMemo(() => {
    if (events == null) return 'Loading…'
    const persons = events.filter((e) => e.label === 'person').length
    const cats = events.filter((e) => e.label === 'cat').length
    const personWord = persons === 1 ? 'person sighting' : 'person sightings'
    const catWord = cats === 1 ? 'cat sighting' : 'cat sightings'
    return `${persons} ${personWord} · ${cats} ${catWord}`
  }, [events])

  // ESC exits full screen; body scroll locks while full so the page
  // behind can't scroll on overscroll.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [full])

  const onSnapshot = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await captureSnapshot()
      setPreviewUrl(r.url)
    } catch (e) {
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
      setBusy(false)
    }
  }

  return (
    // Landscape pass (Task 1): a phone rotated sideways is short-wide
    // — real-device screenshots showed this whole page still stacking
    // portrait-style (video on top, glance cards + timeline below),
    // which left the video letterboxed to a thin strip and pushed the
    // timeline mostly off-screen. `landscape-phone:` reflows into a
    // TWO-PANE layout: video docks in the left ~58% column at full
    // available height, the header/glance/timeline share a right
    // column that scrolls independently. The `full` (fullscreen)
    // branch below is untouched — it's already a `fixed inset-0`
    // overlay that ignores this grid entirely, and the docked-vs-full
    // CSS-only toggle on the SAME container (so VideoTile never
    // remounts) is preserved.
    <div className="flex flex-col landscape-phone:grid landscape-phone:grid-cols-[58%_1fr] landscape-phone:grid-rows-[auto_1fr] landscape-phone:h-[calc(100dvh-var(--ribbon-h,0px))] landscape-phone:overflow-hidden">
      {/* Audit seam fix: `landscape-phone` is height-only, so a
          short-but-wide lg window can render App.tsx's WatchRibbon
          while this grid is active. Subtract the shell-provided
          `--ribbon-h` instead of claiming the full 100dvh. If a
          ConnectionBanner is showing, `<main>`'s own
          `overflow-y-auto` is the fallback scroll (this grid's
          internal right-pane scroll degrades to page-level scroll in
          that edge case, which is acceptable). */}
      {/* ============ PAGE HEADER ============ */}
      <header className="px-4 pt-4 pb-1 flex items-center justify-between gap-3 landscape-phone:col-span-2 landscape-phone:row-start-1 landscape-phone:px-3 landscape-phone:pt-2 landscape-phone:pb-1">
        <h1 className="page-title text-2xl text-[var(--color-text-primary)] landscape-phone:text-base">
          Home
        </h1>
        <BrandMarkRow size={28} />
      </header>

      {/* ============ LIVE VIEWPORT (docked ↔ full-bleed) ============ */}
      <div
        data-testid="live-viewport"
        className={
          full
            ? 'fixed inset-0 z-[45] bg-black flex flex-col'
            : // Docked: a TRUE 16:9 box (the stream's aspect) so the
              // video fills it exactly — no letterbox band, no crop.
              // max-h guards short-viewport landscape. Playroom tile
              // grammar: rounded card + shadow, matching Task 3's
              // other card surfaces.
              // landscape-phone: the docked tile becomes the LEFT
              // PANE at full pane height instead of a capped 16:9
              // strip — `aspect-auto`/`max-h-none`/`h-full` win over
              // the base `aspect-video`/`max-h-[48dvh]` (same
              // technique as the `lg:` overrides elsewhere in this
              // codebase — later media-scoped rule wins at equal
              // specificity).
              // NO w-full here: width:100% + mx-4 made the box 2rem
              // WIDER than the viewport (left gap visible, right edge
              // clipped past the screen — user-caught on device, and
              // the same overflow that let Firefox pan the page
              // sideways). A block div with side margins fills the
              // remaining width by itself.
              'relative aspect-video max-h-[48dvh] mx-4 mt-3 rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] bg-black overflow-hidden landscape-phone:col-start-1 landscape-phone:row-start-2 landscape-phone:aspect-auto landscape-phone:max-h-none landscape-phone:h-full landscape-phone:mx-3 landscape-phone:mt-0 landscape-phone:mb-3'
        }
      >
        <div className="relative flex-1 min-h-0">
          <VideoTile
            detectionActive={detectionActive}
            workerAlive={workerAlive}
            lowMemory={lowMemory}
            thermal={thermal}
            streamStaleSeconds={streamStaleSeconds}
            // Fuzz F4: landscape fullscreen switches to `cover` so the
            // stream fills the wide viewport instead of leaving ~45%
            // dead black bars (see useIsLandscape comment above).
            // Portrait fullscreen and the docked tile are unaffected —
            // docked stays `cover` inside its true 16:9 box, and
            // portrait full-bleed keeps `contain` so the scene's
            // edges are never cropped (original full-bleed rationale).
            fit={full ? (isLandscape ? 'cover' : 'contain') : 'cover'}
            // Fuzz F3/F7/F13: docked wants exactly ONE status pill —
            // this tile's own connection pill ("Live"/"Connecting"/
            // "Offline"). Fullscreen already has a combined armed +
            // camera cluster below plus the scrubber's LIVE pill, so
            // this tile's pill would be a third, redundant "Live"
            // label crowding the back chevron.
            showStatusPill={!full}
            // Status-truth fix: independent read on whether frames are
            // actually flowing, so the glance card can tell "the API
            // doesn't know" apart from "the camera is really down".
            onPlayingChange={setVideoPlaying}
            // Control-overlap fix (2026-07-07): Watch used to render its
            // own absolutely-positioned Snapshot + expand pair ON TOP of
            // VideoTile's own bbox-toggle + fullscreen buttons in the
            // same bottom-right corner — the two owners' circles/pills
            // half-buried each other. VideoTile is now the single owner
            // of that corner; Watch slots its docked-mode buttons in via
            // `actions` (only in docked mode — fullscreen mode has its
            // own separate thumb rail + scrubber chrome) and disables
            // VideoTile's own native-fullscreen button since Watch's
            // CSS docked↔full toggle is the one canonical "make it
            // bigger" affordance on this page (it preserves the WebRTC
            // element and carries the hour scrubber; the native
            // Fullscreen API button would be a second, competing one).
            showFullscreenButton={false}
            actions={
              full ? undefined : (
                <>
                  <button
                    type="button"
                    onClick={onSnapshot}
                    disabled={busy}
                    onPointerDown={busy ? undefined : ripple}
                    className="relative overflow-hidden inline-flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-2xl bg-black/55 backdrop-blur ring-1 ring-white/20 text-white text-xs font-semibold disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors hover:bg-black/70"
                  >
                    {busy ? 'Saving…' : 'Snapshot'}
                  </button>
                  <button
                    type="button"
                    aria-label="Full screen live view"
                    onClick={() => setFull(true)}
                    onPointerDown={ripple}
                    className="relative overflow-hidden inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-2xl bg-black/55 backdrop-blur ring-1 ring-white/20 text-white focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors hover:bg-black/70"
                  >
                    <ExpandIcon />
                  </button>
                </>
              )
            }
          />

          {/* Floating pill overlays — the armed state lives ON the
              video here (the ribbon is hidden on this route on
              mobile). Safe-area padded for the notch.
              Fuzz F3/F9/F13 consolidation: docked shows ONLY the
              camera-name pill (the armed/offline state now belongs
              solely to the glance card below, and the connection
              state is VideoTile's own pill) — down from 4 chips
              stacked on one video. Fullscreen collapses the old
              3-piece cluster (state pill + camera pill + "Live now"
              age text) into ONE combined "{state} · {camera}" pill,
              since the scrubber's red LIVE pill already carries the
              live signal and a standalone "Live now" text was pure
              duplication (fuzz F3). */}
          <div
            className="absolute top-0 left-0 right-0 flex items-center gap-2 px-4 pointer-events-none"
            style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
          >
            {full && (
              <button
                type="button"
                aria-label="Exit full screen"
                onClick={() => setFull(false)}
                onPointerDown={ripple}
                className="pointer-events-auto relative overflow-hidden mr-1 flex items-center justify-center w-9 h-9 rounded-xl bg-black/45 ring-1 ring-white/15 text-white text-lg focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
              >
                ‹
              </button>
            )}
            {full ? (
              <span
                role="status"
                aria-live="polite"
                className="pointer-events-auto inline-flex items-center gap-2 bg-[var(--color-surface-scrim)] backdrop-blur rounded-full px-3 py-1.5 ring-1 ring-[var(--color-border)]"
              >
                <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {stateLabel} · {cameraLabel}
                </span>
              </span>
            ) : (
              <span className="pointer-events-auto bg-black/70 text-white text-xs font-semibold rounded-full px-3 py-1 truncate">
                {cameraLabel}
              </span>
            )}
          </div>

          {/* Full-mode thumb rail. Fuzz F11: the "Talk · soon"
              placeholder button was dropped — two-way audio is
              out-of-scope hardware work (see CLAUDE.md "Out of
              scope"); it occupied prime fullscreen real estate for a
              feature with no ETA. Re-add here once audio_enabled
              ships. Fuzz F5: safe-area padding so Snapshot's label
              never sits under the status-bar/camera-cutout area in
              landscape (real-device SM-S928U1 clipped it). */}
          {full && (
            <div
              className="absolute right-3 bottom-40 flex flex-col gap-3"
              style={{
                paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
                paddingRight: 'max(0.5rem, env(safe-area-inset-right))',
              }}
            >
              <RailButton
                label={busy ? 'Saving…' : 'Snapshot'}
                onClick={onSnapshot}
                disabled={busy}
              >
                <SnapshotIcon />
              </RailButton>
            </div>
          )}
        </div>

        {/* Full-mode bottom: hour scrubber with event markers */}
        {full && (
          <HourScrubber
            onJumpHistory={() => {
              setFull(false)
              navigate('/events')
            }}
          />
        )}
      </div>

      {/* landscape-phone: glance cards + today's story share the
          RIGHT pane and scroll independently of the (now full-height)
          video pane on the left — this wrapper only takes effect at
          that breakpoint (`contents` elsewhere, so it doesn't add an
          extra scroll container / DOM landmark on portrait or
          desktop, where these two sections already flow normally in
          the page's own scroll). */}
      <div className="contents landscape-phone:flex landscape-phone:flex-col landscape-phone:col-start-2 landscape-phone:row-start-2 landscape-phone:min-h-0 landscape-phone:overflow-y-auto">
        {/* ============ GLANCE ROW ============ */}
        <div className="mx-4 mt-3.5 flex gap-2.5 landscape-phone:mx-3 landscape-phone:mt-0 landscape-phone:flex-col landscape-phone:gap-2">
          <div
            className={`flex-1 rounded-[var(--radius-xl)] px-3 py-2.5 ${
              unhealthy
                ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
                : 'bg-[var(--color-ink)] text-[var(--color-on-ink)]'
            }`}
          >
            <p className="text-[17px] font-extrabold tracking-tight">
              {dangerDown ? 'Offline' : watching || reconnecting ? 'Watching' : 'Paused'}
            </p>
            {/* Final whole-branch review fix batch #6: text-xs resolves to
                11px in this theme — a hair too small for the accepted
                12.5px detail size. Arbitrary value pins the exact px. */}
            <p className="text-[12.5px] font-semibold">{watchingDetail}</p>
          </div>
          <div className="flex-1 rounded-[var(--radius-xl)] border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
            <p className="text-[17px] font-extrabold tracking-tight text-[var(--color-text-primary)]">
              {todayCount} today
            </p>
            <p className="text-[12.5px] font-semibold text-[var(--color-text-secondary)]">
              {todayBreakdown}
            </p>
          </div>
        </div>

        {/* ============ TODAY'S STORY ============ */}
        <TodayTimeline
          events={events}
          quietSince={quietSince}
          error={error}
          onOpen={setOpenEvent}
          nowMs={nowMs}
        />
      </div>

      {previewUrl && (
        <SnapshotPreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
      {openEvent && (
        <ClipModal
          event={openEvent}
          onClose={() => setOpenEvent(null)}
          // Final whole-branch review fix batch #1: bump the SAME
          // refetch key visibilitychange already uses, so the
          // just-deleted event drops out of Today's Story without a
          // second, parallel invalidation mechanism.
          onDeleted={() => refetchTodayEvents()}
        />
      )}
    </div>
  )
}

/* ================= Today timeline ================= */

/**
 * Fuzz F8: the row subline used to be the constant "Tap to review" —
 * a wasted line, since the row is already a button (the tap
 * affordance is implicit). `DetectionEvent` has no clip-duration
 * field on the wire (checked `lib/types.ts` — only
 * `clip_url`/`thumb_url`/box data), so this surfaces the next most
 * useful thing instead: recognition state for person events (the
 * title already names a KNOWN person, so the subline only needs to
 * flag the unrecognized case) plus relative time for everyone. If a
 * duration field ever lands on the wire, thread it in here ahead of
 * the relative-time fallback.
 */
function eventSubline(e: DetectionEvent, nowMs: number): string {
  const rel = relativeTime(e.ts, nowMs)
  if (e.label === 'person' && recognizedNames(e).length === 0) {
    return `Not recognized · ${rel}`
  }
  return rel
}

function TodayTimeline({
  events,
  quietSince,
  error,
  onOpen,
  nowMs,
}: {
  events: DetectionEvent[] | null
  quietSince: string | null
  error: boolean
  onOpen: (e: DetectionEvent) => void
  nowMs: number
}) {
  const navigate = useNavigate()

  return (
    <section className="px-4 pt-4 pb-6" aria-label="Today's activity">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold text-[var(--color-text-primary)]">
          Today at home
        </h2>
        <button
          type="button"
          onClick={() => navigate('/events')}
          className="text-xs font-semibold text-[var(--color-accent-deep)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
        >
          Full history →
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-4">
        {events == null
          ? 'Loading today…'
          : events.length === 0
            ? 'No events yet today'
            : 'Newest first'}
      </p>

      {error && (
        <p className="text-sm text-[var(--color-danger)]" role="alert">
          Couldn&rsquo;t load today&rsquo;s events — pull to refresh or try again shortly.
        </p>
      )}

      {events != null && events.length === 0 && !error && (
        <CatEmptyState
          heading="All quiet so far"
          body="Nothing has crossed the porch today. Events will appear here the moment something moves."
        />
      )}

      <ol className="space-y-2">
        {quietSince && (
          <li className="rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-secondary)]">
            Quiet since {quietSince}
          </li>
        )}
        {(events ?? []).map((e) => (
          <li key={e.id}>
            <EventRow
              event={e}
              subline={eventSubline(e, nowMs)}
              onOpen={() => onOpen(e)}
            />
          </li>
        ))}
      </ol>
    </section>
  )
}

/* ================= Full-mode hour scrubber ================= */

/**
 * Fuzz F1: the fullscreen scrubber used a completely different color
 * language than Events' `HourBand` — activity cells were flat orange
 * ("accent-bright") regardless of who appeared, and the current-time
 * cell was filled solid `--color-success` green, which nowhere else
 * in the identity system means "now" (it's the alert-adjacent
 * "healthy" hue). Same underlying data (today's events bucketed by
 * time), two unrelated color stories.
 *
 * Fix: bucket ownership uses the SAME rank (`_KIND_RANK`, mirrored
 * from `HourBand.tsx` — a person always outranks a cat, ties go to
 * the earliest event in the bucket) and the SAME `identityOf()`
 * mapping, so a recognized person's personal hue, the shared person
 * cobalt, or the cat marmalade reads identically here and on Events.
 *
 * This scrubber sits on a permanently-black gradient (the fullscreen
 * scrim), not a themed surface, so — matching the precedent already
 * set by the LIVE pill and the danger-token comment below — it
 * resolves each identity token to its FIXED dark-range hex instead
 * of `var(--color-id-*)`. The light-theme tokens (e.g. cobalt
 * `#2f5fe0`) read fine on paper but under-contrast against always-
 * black; the dark-theme values were tuned for exactly this kind of
 * dark-glass chrome.
 */
const _HOUR_KIND_RANK: Record<IdentityKind, number> = {
  'named-person': 3,
  person: 3,
  cat: 2,
  other: 1,
}

/** `var(--color-id-<token>)` -> its fixed dark-theme hex (see block
 * comment above for why fixed, not `var()`, on this always-black
 * chrome). Falls back to the neutral panther hex for any token this
 * table doesn't know about yet (defensive — every current identity
 * token is covered). */
const _DARK_ID_HEX: Record<string, string> = {
  panther: '#8f8ba0',
  mushu: '#f08536',
  coco: '#e8859e',
  person: '#6c8ff0',
  'wheel-1': '#6c8ff0',
  'wheel-2': '#2dd4bf',
  'wheel-3': '#a78bfa',
  'wheel-4': '#f472b6',
  'wheel-5': '#4ade80',
  'wheel-6': '#eab308',
}

function _darkHexForColorVar(colorVar: string): string {
  const token = /--color-id-([a-z0-9-]+)\)/.exec(colorVar)?.[1]
  return (token && _DARK_ID_HEX[token]) || _DARK_ID_HEX.panther
}

type HourBucket = { count: number; rank: number; color: string | null; ts: number | null }

function _emptyBuckets(): HourBucket[] {
  return Array.from({ length: 16 }, () => ({ count: 0, rank: 0, color: null, ts: null }))
}

function HourScrubber({ onJumpHistory }: { onJumpHistory: () => void }) {
  const [buckets, setBuckets] = useState<HourBucket[] | null>(null)

  useEffect(() => {
    let cancelled = false
    searchEvents({ since_ts: localMidnightTs(), limit: 200 })
      .then((r) => {
        if (cancelled) return
        const bins = _emptyBuckets()
        const start = localMidnightTs()
        const span = Math.max(Date.now() / 1000 - start, 1)
        for (const e of r.items) {
          const i = Math.min(15, Math.floor(((e.ts - start) / span) * 16))
          if (i < 0) continue
          const b = bins[i]
          b.count += 1
          const identity = identityOf(e)
          const rank = _HOUR_KIND_RANK[identity.kind]
          // Same tie-break as HourBand: a higher rank always wins;
          // on a rank tie, the EARLIEST event in the bucket wins
          // ("first event of the hour" reads more naturally than
          // whichever the newest-first API response happened to
          // list first).
          const isNewWinner =
            rank > b.rank || (rank === b.rank && b.rank > 0 && b.ts != null && e.ts < b.ts)
          if (isNewWinner) {
            b.rank = rank
            b.color = _darkHexForColorVar(identity.colorVar)
            b.ts = e.ts
          }
        }
        setBuckets(bins)
      })
      .catch(() => {
        if (!cancelled) setBuckets(_emptyBuckets())
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      className="flex-none px-4 pb-6 pt-3 bg-gradient-to-t from-black/80 to-transparent"
      style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={onJumpHistory}
          aria-label="Open full history"
          className="flex-1 flex items-end gap-[3px] h-8 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 rounded"
        >
          {(buckets ?? _emptyBuckets()).map((b, i) => {
            const isNow = i === 15
            return (
              <span
                key={i}
                aria-hidden="true"
                data-testid={isNow ? 'hour-cell-now' : `hour-cell-${i}`}
                // Fuzz F1: the NOW marker is a neutral bright ring, NOT
                // a `--color-success` fill — green nowhere else means
                // "current time" in this app. The cell's fill still
                // follows the same identity coloring as every other
                // cell (quiet = dim white, active = the winning
                // identity's dark-range hex).
                className={`flex-1 rounded-sm ${isNow ? 'h-6 ring-2 ring-white/80' : ''} ${
                  b.color ? '' : 'bg-white/15'
                }`}
                style={{
                  background: b.color ?? undefined,
                  height: isNow ? undefined : b.color ? 16 : 5,
                }}
              />
            )
          })}
        </button>
        {/* Final whole-branch review fix batch #3: fixed over-video
            colors — the fullscreen scrim is black in both themes;
            theme danger tokens are tuned for paper (same exception as
            text-white on video). The tokenized danger colors measured
            ~4.1:1 against this always-black overlay in light theme. */}
        <span className="flex-none text-[11px] font-extrabold tracking-wider text-[#f87171] bg-[rgba(248,113,113,0.16)] ring-1 ring-[rgba(248,113,113,0.45)] px-2.5 py-1 rounded-full">
          ● LIVE
        </span>
      </div>
      <div className="flex justify-between text-[9px] text-white/40 mt-1.5 tabular-nums pr-16">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>NOW</span>
      </div>
    </div>
  )
}

/* ================= Small pieces ================= */

function RailButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const ripple = useRipple()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onPointerDown={disabled ? undefined : ripple}
      aria-label={label}
      className="relative overflow-hidden w-[54px] h-[54px] rounded-[19px] bg-black/55 backdrop-blur ring-1 ring-white/15 text-white flex flex-col items-center justify-center gap-0.5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
    >
      {children}
      <span className="text-[8.5px] text-white/65 leading-none">{label}</span>
    </button>
  )
}

function ExpandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function SnapshotIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

// MicIcon (Talk button glyph) removed with the "Talk · soon"
// placeholder — fuzz F11, two-way audio returns post-hardware.
