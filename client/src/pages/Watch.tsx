import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { CatEmptyState } from '../components/CatEmptyState'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { VideoTile } from '../components/VideoTile'
import { captureSnapshot, searchEvents, HttpError } from '../lib/api'
import { clockTime, eventTitle } from '../lib/eventLabel'
import { formatAge } from '../lib/format'
import { useRipple } from '../lib/ripple'
import { sentryCatName, useSentryCat } from '../lib/sentryCat'
import { useToast } from '../lib/toast'
import type { DetectionEvent } from '../lib/types'
import { useStatus } from '../lib/useStatus'

/**
 * Watch — the app's home screen (structural overhaul, 2026-07-02).
 *
 * Replaces the old Live page. Modeled on the two patterns the market
 * converged on (user-approved mockups):
 *   - Google Home / Nest camera detail: live video pinned in the top
 *     ~40% of the screen, TODAY'S STORY as a scrollable timeline
 *     below (events + quiet gaps), one-line plain-language verdict.
 *   - Ring Live View: tapping the video expands to a FULL-BLEED
 *     immersive mode — floating status, thumb-rail actions, an
 *     hour scrubber with event markers, swipe/back to close.
 *
 * The expand is a CSS state on the SAME container (docked ↔ fixed
 * inset-0) so the WebRTC <video> never remounts — no reconnect
 * hiccup when entering/leaving full screen.
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

export function Watch() {
  const status = useStatus()
  const sentryCat = useSentryCat()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const ripple = useRipple()

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
      <h1 className="sr-only">Watch — live camera and today&rsquo;s activity</h1>

      {/* ============ LIVE VIEWPORT (docked ↔ full-bleed) ============ */}
      <div
        data-testid="live-viewport"
        className={
          full
            ? 'fixed inset-0 z-[45] bg-black flex flex-col'
            : // Docked: a TRUE 16:9 box (the stream's aspect) so the
              // video fills it exactly — no letterbox band, no crop.
              // max-h guards short-viewport landscape.
              'relative w-full aspect-video max-h-[48dvh] bg-black overflow-hidden'
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

          {/* Floating status scrim — the armed state lives ON the
              video here (the ribbon is hidden on this route on
              mobile). Safe-area padded for the notch. */}
          <div
            className="absolute top-0 left-0 right-0 flex items-center gap-2 px-4 pb-8 pointer-events-none bg-gradient-to-b from-black/70 to-transparent"
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
            <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
            <span
              role="status"
              aria-live="polite"
              className="text-sm font-semibold text-white"
            >
              {stateLabel}
            </span>
            <span className="text-sm text-white/60 truncate">· {cameraLabel}</span>
            {ageLabel && (
              <span className="ml-auto text-xs text-white/55 tabular-nums">
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

      {/* ============ VERDICT STRIP ============ */}
      <button
        type="button"
        onClick={() => navigate('/settings')}
        onPointerDown={ripple}
        className="relative overflow-hidden w-full flex items-center gap-2.5 px-4 py-3 bg-[var(--color-surface)] border-b border-[var(--color-border-subtle)] text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-[-2px]"
        aria-label="System status — open settings"
      >
        <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
        <span className="text-[13px] text-[var(--color-text-secondary)] truncate">
          {offline ? (
            <>
              <b className="font-semibold text-[var(--color-text-primary)]">
                Camera offline.
              </b>{' '}
              Check its power, then see Settings.
            </>
          ) : armed ? (
            <>
              <b className="font-semibold text-[var(--color-text-primary)]">
                All clear.
              </b>{' '}
              {sentryCatName(sentryCat)} is on watch · alerts on
            </>
          ) : detectionActive === false ? (
            <>
              <b className="font-semibold text-[var(--color-text-primary)]">
                Alerts paused.
              </b>{' '}
              Detection is off — turn it on in Settings.
            </>
          ) : (
            <>Checking the camera…</>
          )}
        </span>
        <span aria-hidden="true" className="ml-auto text-[var(--color-text-tertiary)]">
          ›
        </span>
      </button>

      {/* ============ TODAY'S STORY ============ */}
      <TodayTimeline onOpen={setOpenEvent} />

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

function TodayTimeline({ onOpen }: { onOpen: (e: DetectionEvent) => void }) {
  const [events, setEvents] = useState<DetectionEvent[] | null>(null)
  const [quietSince, setQuietSince] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [refetchKey, setRefetchKey] = useState(0)
  const navigate = useNavigate()
  const ripple = useRipple()

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

  // Refetch on tab resume — same visibility-aware pattern as the
  // Events page and heatmap (CLAUDE.md load-bearing listeners).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setRefetchKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const people = useMemo(
    () => (events ?? []).filter((e) => e.label === 'person').length,
    [events],
  )

  return (
    <section className="px-4 pt-4 pb-6" aria-label="Today's activity">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold text-[var(--color-text-primary)]">
          Today at the door
        </h2>
        <button
          type="button"
          onClick={() => navigate('/events')}
          className="text-xs font-semibold text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
        >
          Full history →
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-4">
        {events == null
          ? 'Loading today…'
          : events.length === 0
            ? 'No events yet today'
            : `${events.length} ${events.length === 1 ? 'event' : 'events'}${
                people > 0 ? ` · ${people} ${people === 1 ? 'person' : 'people'}` : ''
              }`}
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

      <ol className="space-y-3">
        {quietSince && (
          <li className="flex gap-3">
            <span className="w-14 flex-none" aria-hidden="true" />
            <div className="w-0.5 flex-none bg-transparent relative">
              <span className="absolute top-2 -left-[3px] w-2 h-2 rounded-full bg-[var(--color-border)]" />
            </div>
            <p className="flex-1 text-xs text-[var(--color-text-secondary)] border border-dashed border-[var(--color-border)] rounded-xl px-3 py-2.5">
              Quiet since {quietSince}
            </p>
          </li>
        )}
        {(events ?? []).map((e) => {
          const known = !!e.person_name
          const isPerson = e.label === 'person'
          // Compact title: the section heading already says "at the
          // door", so rows lead with WHO. Full phrasing lives in the
          // clip modal.
          const title = isPerson
            ? (e.person_name ?? 'Someone new')
            : eventTitle(e)
          return (
            <li key={e.id} className="flex gap-3">
              <span className="w-14 flex-none text-right text-[10.5px] whitespace-nowrap text-[var(--color-text-tertiary)] tabular-nums pt-2.5">
                {clockTime(e.ts)}
              </span>
              <span className="w-0.5 flex-none bg-[var(--color-border-subtle)] relative rounded-full">
                <span
                  aria-hidden="true"
                  className={`absolute top-2.5 -left-[3.5px] w-2.5 h-2.5 rounded-full border-2 border-[var(--color-bg)] ${
                    known
                      ? 'bg-[var(--color-success)]'
                      : isPerson
                        ? 'bg-[var(--color-warning)]'
                        : 'bg-[var(--color-accent-default)]'
                  }`}
                />
              </span>
              <button
                type="button"
                onClick={() => onOpen(e)}
                onPointerDown={ripple}
                className="relative overflow-hidden flex-1 flex items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border-subtle)] rounded-2xl px-3 py-2.5 text-left shadow-[var(--shadow-subtle)] hover:border-[var(--color-border-strong)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                aria-label={`${title} at ${clockTime(e.ts)} — open clip`}
              >
                {e.thumb_url ? (
                  <img
                    src={e.thumb_url}
                    alt=""
                    className="w-[68px] h-[46px] flex-none rounded-lg object-cover border border-[var(--color-border-subtle)] bg-black"
                    loading="lazy"
                  />
                ) : (
                  <span className="w-[68px] h-[46px] flex-none rounded-lg bg-[var(--color-surface-raised)]" />
                )}
                <span className="min-w-0">
                  <b className="block text-[13.5px] font-semibold text-[var(--color-text-primary)] truncate">
                    {title}
                  </b>
                  <span className="block text-[11.5px] text-[var(--color-text-secondary)]">
                    {isPerson && !known ? 'Tap to review' : 'Tap for the clip'}
                  </span>
                </span>
                {isPerson && (
                  <span
                    className={`ml-auto flex-none text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      known
                        ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                        : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
                    }`}
                  >
                    {known ? 'KNOWN' : 'NEW'}
                  </span>
                )}
              </button>
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
        <span className="flex-none text-[11px] font-extrabold tracking-wider text-[#ff8d84] bg-[rgba(255,90,78,0.18)] ring-1 ring-[rgba(255,90,78,0.5)] px-2.5 py-1 rounded-full">
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
