import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { CatEmptyState } from '../components/CatEmptyState'
import { EventRow } from '../components/EventRow'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { BrandMarkRow } from '../components/WhoMark'
import { captureSnapshot, searchEvents, HttpError } from '../lib/api'
import { clockTime } from '../lib/eventLabel'
import { formatAge } from '../lib/format'
import { useRipple } from '../lib/ripple'
import { sentryCatName, useSentryCat } from '../lib/sentryCat'
import { useToast } from '../lib/toast'
import type { DetectionEvent } from '../lib/types'
import { useStatus } from '../lib/useStatus'

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
 * The WatchRibbon is hidden on this route on mobile (App.tsx): the
 * on-video scrim carries the armed state here, and a second status
 * bar would say the same thing twice.
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

  return { events, quietSince, error }
}

export function Watch() {
  const status = useStatus()
  const sentryCat = useSentryCat()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const ripple = useRipple()
  const { events, quietSince, error } = useTodayEvents()

  const [full, setFull] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [openEvent, setOpenEvent] = useState<DetectionEvent | null>(null)

  const detectionActive = status?.detection_active ?? null
  const workerAlive = status?.worker_alive ?? null
  const streamStaleSeconds = status?.seconds_since_last_frame ?? null
  const lowMemory = status?.worker_metrics?.gear === 'low-memory'
  const thermal = status?.worker_metrics?.gear === 'thermal-throttled'
  const cameraLabel = status?.camera_label ?? _DEFAULT_CAMERA_LABEL

  const offline = status != null && status.worker_alive === false
  const armed = detectionActive === true && workerAlive === true
  const unhealthy = offline || lowMemory || thermal
  const stateLabel = offline
    ? 'Camera offline'
    : armed
      ? 'On watch'
      : detectionActive === false
        ? 'Off duty'
        : 'Checking…'
  const dotClass = offline
    ? 'bg-[var(--color-danger)]'
    : armed
      ? 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
      : detectionActive === false
        ? 'bg-[var(--color-warning)]'
        : 'bg-[var(--color-text-tertiary)]'
  const ageLabel =
    status?.seconds_since_last_frame == null
      ? null
      : status.seconds_since_last_frame < 5
        ? 'Live now'
        : `${formatAge(status.seconds_since_last_frame)} ago`

  // Glance row copy — Step 3 of the Home redesign. "Watching" card
  // swaps to the full-contrast danger treatment when the camera is
  // offline or the worker has degraded to a low-memory/thermal gear
  // (whimsy never masks danger — CLAUDE.md).
  const watching = armed
  const watchingDetail = offline
    ? 'Check its power, then see Settings.'
    : lowMemory
      ? 'Paused — the system is low on memory.'
      : thermal
        ? 'Slowed down — the camera is running warm.'
        : watching
          ? `${sentryCatName(sentryCat)} is on watch · alerts on`
          : detectionActive === false
            ? 'Turn alerts on in Settings.'
            : 'Checking the camera…'
  const todayCount = events?.length ?? 0
  const todayBreakdown = useMemo(() => {
    if (events == null) return 'Loading…'
    const persons = events.filter((e) => e.label === 'person').length
    const cats = events.filter((e) => e.label === 'cat').length
    const personWord = persons === 1 ? 'person' : 'people'
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
    <div className="flex flex-col">
      {/* ============ PAGE HEADER ============ */}
      <header className="px-4 pt-4 pb-1 flex items-center justify-between gap-3">
        <h1 className="page-title text-2xl text-[var(--color-text-primary)]">
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
              'relative w-full aspect-video max-h-[48dvh] mx-4 mt-3 rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] bg-black overflow-hidden'
        }
      >
        <div className="relative flex-1 min-h-0">
          <VideoTile
            detectionActive={detectionActive}
            workerAlive={workerAlive}
            lowMemory={lowMemory}
            thermal={thermal}
            streamStaleSeconds={streamStaleSeconds}
            fit={full ? 'contain' : 'cover'}
          />

          {/* Floating pill overlays — the armed state lives ON the
              video here (the ribbon is hidden on this route on
              mobile). Safe-area padded for the notch. Two distinct
              pills (state + camera name) replace the old continuous
              scrim bar per the Playroom pill grammar. */}
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
            <span
              role="status"
              aria-live="polite"
              className="pointer-events-auto inline-flex items-center gap-2 bg-[var(--color-surface-scrim)] backdrop-blur rounded-full px-3 py-1.5 ring-1 ring-[var(--color-border)]"
            >
              <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                {stateLabel}
              </span>
            </span>
            <span className="pointer-events-auto bg-black/70 text-white text-xs font-semibold rounded-full px-3 py-1 truncate">
              {cameraLabel}
            </span>
            {ageLabel && (
              <span className="ml-auto pointer-events-auto text-xs text-white/80 tabular-nums bg-black/50 rounded-full px-2.5 py-1">
                {ageLabel}
              </span>
            )}
          </div>

          {/* Docked-mode corner actions */}
          {!full && (
            <div className="absolute bottom-3 right-3 flex gap-2">
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
            </div>
          )}

          {/* Full-mode thumb rail */}
          {full && (
            <div className="absolute right-3 bottom-40 flex flex-col gap-3">
              <RailButton
                label={busy ? 'Saving…' : 'Snapshot'}
                onClick={onSnapshot}
                disabled={busy}
              >
                <SnapshotIcon />
              </RailButton>
              <RailButton label="Talk · soon" disabled>
                <MicIcon />
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

      {/* ============ GLANCE ROW ============ */}
      <div className="mx-4 mt-3.5 flex gap-2.5">
        <div
          className={`flex-1 rounded-[var(--radius-xl)] px-3 py-2.5 ${
            unhealthy
              ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
              : 'bg-[var(--color-ink)] text-[var(--color-on-ink)]'
          }`}
        >
          <p className="text-[17px] font-extrabold tracking-tight">
            {watching ? 'Watching' : 'Paused'}
          </p>
          <p className="text-xs font-semibold">{watchingDetail}</p>
        </div>
        <div className="flex-1 rounded-[var(--radius-xl)] border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
          <p className="text-[17px] font-extrabold tracking-tight text-[var(--color-text-primary)]">
            {todayCount} today
          </p>
          <p className="text-xs font-semibold text-[var(--color-text-secondary)]">
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
      />

      {previewUrl && (
        <SnapshotPreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
      {openEvent && (
        <ClipModal event={openEvent} onClose={() => setOpenEvent(null)} />
      )}
    </div>
  )
}

/* ================= Today timeline ================= */

function TodayTimeline({
  events,
  quietSince,
  error,
  onOpen,
}: {
  events: DetectionEvent[] | null
  quietSince: string | null
  error: boolean
  onOpen: (e: DetectionEvent) => void
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
        {(events ?? []).map((e) => {
          const subline =
            e.label === 'person' && !e.person_name ? 'Tap to review' : 'Tap for the clip'
          return (
            <li key={e.id}>
              <EventRow event={e} subline={subline} onOpen={() => onOpen(e)} />
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/* ================= Full-mode hour scrubber ================= */

function HourScrubber({ onJumpHistory }: { onJumpHistory: () => void }) {
  const [buckets, setBuckets] = useState<number[] | null>(null)

  useEffect(() => {
    let cancelled = false
    searchEvents({ since_ts: localMidnightTs(), limit: 200 })
      .then((r) => {
        if (cancelled) return
        const bins = new Array<number>(16).fill(0)
        const start = localMidnightTs()
        const span = Math.max(Date.now() / 1000 - start, 1)
        for (const e of r.items) {
          const i = Math.min(15, Math.floor(((e.ts - start) / span) * 16))
          if (i >= 0) bins[i] += 1
        }
        setBuckets(bins)
      })
      .catch(() => {
        if (!cancelled) setBuckets(new Array(16).fill(0))
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
          {(buckets ?? new Array<number>(16).fill(0)).map((n, i) => (
            <span
              key={i}
              aria-hidden="true"
              className={`flex-1 rounded-sm ${
                i === 15
                  ? 'bg-[var(--color-success)] h-6'
                  : n > 0
                    ? 'bg-[var(--color-accent-bright)]'
                    : 'bg-white/15'
              }`}
              style={i === 15 ? undefined : { height: n > 0 ? 16 : 5 }}
            />
          ))}
        </button>
        <span className="flex-none text-[11px] font-extrabold tracking-wider text-[var(--color-danger)] bg-[var(--color-danger-bg)] ring-1 ring-[var(--color-danger-border)] px-2.5 py-1 rounded-full">
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

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  )
}
