import { useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteTimelapse,
  getTimelapseManifest,
  getTimelapseStatus,
  listTimelapses,
  triggerTimelapse,
} from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { formatBytes, formatError } from '../../lib/format'
import { log, errFields } from '../../lib/log'
import { useReportError, useToast } from '../../lib/toast'
import type { TimelapseItem, TimelapseSegment } from '../../lib/api'
import {
  formatClock,
  isUsableManifest,
  reelTimeToCaptureTs,
} from '../../lib/timelapseClock'
import { CatEmptyState } from '../../components/CatEmptyState'
import { VideoPlayer } from '../../components/VideoPlayer'
import { Section } from './parts'

// iter-292: extracted from Settings.tsx (~85 lines of inline JSX +
// timelapses state + onGenerateTimelapse handler + listTimelapses
// effect). Owner-gated by parent — this component does not re-check
// `isOwner`; the server-side require_role("owner") on the trigger
// route is the source of truth.
//
// iter-304 (user "make the Timelapses much easier to interface
// with"): UX overhaul. Pre-iter-304:
//   - free-text "YYYY-MM-DD" input (every typo wasted a server
//     round-trip + a toast)
//   - bare "Generate" button with no explanation of what a timelapse IS
//   - download-only listing (no in-place play affordance)
//   - "No timelapses yet." empty state was a dead-end if the host-
//     helper isn't wired
//
// Post-iter-304:
//   - native `<input type="date">` (browser-native picker; no typos)
//   - Yesterday + Today preset buttons (the 90% case)
//   - inline `<video controls>` per timelapse so user can play in-place
//   - friendlier intro copy + empty state hint
//   - newest-first explicit sort (server returns mtime DESC, we sort
//     by date string anyway as belt-and-braces)

const _DATE_RE = /^[0-9]{4}-[01][0-9]-[0-3][0-9]$/

// Background-build polling: every 3 s, up to ~20 min. A busy day's concat
// is large+slow on the Nano (a measured 342-clip / 3.2 GB day took ~12.5
// min), so the budget must outlast it for the video to auto-reveal. Past
// the budget the build may still finish server-side (the file appears in
// the list on next load).
const _POLL_INTERVAL_MS = 3000
const _POLL_MAX_ATTEMPTS = 400

function _todayStr(): string {
  // YYYY-MM-DD in LOCAL time (matches the iter-301 container TZ +
  // CLAUDE.md iter-222/223 sharp edge: server bucketing also uses
  // local time, so we want the same "what day is it for the user".)
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function _yesterdayStr(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Inline timelapse player with a forward-ticking wall-clock overlay.
//
// The reel is a de-overlapped concat of the day's event clips, so the
// playhead runs strictly forward in real time. The server writes a sibling
// `<date>.json` sidecar mapping reel-offset → original capture time; we fetch
// it LAZILY on first play (preserving the iter-311 `preload="none"` win — no
// network on Settings-tab mount) and, on each `timeupdate`, paint the local
// HH:MM:SS of the footage under the playhead top-right (the lib/drawBoxes.ts
// paint-over-video pattern). Reels built before this feature have no sidecar
// (manifest_url null / 404) → the overlay simply stays hidden; playback is
// unaffected.
function TimelapseVideo({ item }: { item: TimelapseItem }) {
  const [segments, setSegments] = useState<TimelapseSegment[] | null>(null)
  const [clock, setClock] = useState<string | null>(null)
  // Latch so the manifest is fetched at most once, even across replays.
  const fetchedRef = useRef(false)

  const ensureManifest = () => {
    if (fetchedRef.current || !item.manifest_url) return
    fetchedRef.current = true
    getTimelapseManifest(item.manifest_url)
      .then((m) => {
        if (isUsableManifest(m)) setSegments(m.segments)
      })
      .catch((e) => {
        // No sidecar (older reel → 404) or a transient blip — the overlay
        // just stays hidden, so DEBUG (not an operator-actionable failure).
        log.debug('timelapses:manifest-failed', {
          date: item.date,
          ...errFields(e),
        })
      })
  }

  // VideoPlayer hands us the <video> on each tick; map the playhead to the
  // original capture time for the corner clock.
  const onTimeUpdate = (v: HTMLVideoElement) => {
    if (!segments) return
    const ts = reelTimeToCaptureTs(segments, v.currentTime)
    setClock(ts === null ? null : formatClock(ts))
  }

  // iter (user "same as youtube"): the timelapse reel now uses the custom
  // VideoPlayer — play/scrub/time + in-player speed menu (.25×–4×) + repeat +
  // fullscreen. preload="none" preserves the iter-311 no-fetch-until-play win.
  return (
    <VideoPlayer
      src={item.url}
      ariaLabel={`Timelapse video for ${item.date}`}
      preload="none"
      onPlay={ensureManifest}
      onTimeUpdate={onTimeUpdate}
      onError={(v) =>
        log.warn('timelapses:video-error', {
          date: item.date,
          url: item.url,
          mediaErrorCode: v.error?.code ?? null,
          networkState: v.networkState,
        })
      }
      containerClassName="w-full lg:max-w-xl rounded border border-[var(--color-border)]"
      overlay={
        clock ? (
          // Top-right so it never collides with the bottom control bar.
          // aria-hidden: a ticking clock is SR noise; the row shows the date.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-2 right-2 z-10 rounded bg-black/60 px-2 py-1 font-mono text-xs tabular-nums text-white"
          >
            {clock}
          </div>
        ) : null
      }
    />
  )
}

export function TimelapsesSection() {
  const { showToast } = useToast()
  const reportError = useReportError()
  const confirm = useConfirm()
  const [timelapses, setTimelapses] = useState<TimelapseItem[] | null>(null)
  // iter-304: default to yesterday (the most common build target —
  // today's footage is mid-stream until midnight). Pre-iter-304 the
  // input started blank and the user had to type a full date.
  const [timelapseDate, setTimelapseDate] = useState<string>(() =>
    _yesterdayStr(),
  )
  const [timelapseGenerating, setTimelapseGenerating] = useState(false)
  // Background builds are polled (a busy day takes minutes). This ref is
  // flipped on unmount so the poll loop stops touching state after the
  // user navigates away mid-build.
  const pollAbortRef = useRef(false)
  useEffect(() => {
    return () => {
      pollAbortRef.current = true
    }
  }, [])

  // iter-214: load timelapses on mount. `cancelled` flag pattern
  // mirrors the iter-208 filters effect. 401/403 should never fire
  // (UI hides for non-owners), but on transient failure we fall
  // back to an empty array so the UI still renders.
  useEffect(() => {
    let cancelled = false
    listTimelapses()
      .then((r) => {
        if (cancelled) return
        setTimelapses(r.items)
      })
      .catch((e) => {
        // docs/logging_plan.md §2 (Daily timelapse): the empty-array
        // fallback HIDES any timelapses that were on screen before a
        // transient list failure — it looks identical to "none yet".
        // Log the reason (status / network) BEFORE the cancelled guard
        // so an in-flight failure during unmount is still recorded.
        log.warn('timelapses:list-failed', errFields(e))
        if (cancelled) return
        setTimelapses([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onGenerateTimelapse = async () => {
    const date = timelapseDate.trim()
    if (!_DATE_RE.test(date) || timelapseGenerating) return
    setTimelapseGenerating(true)
    pollAbortRef.current = false
    try {
      // Kick off the BACKGROUND build — returns immediately. A busy day is
      // 300+ clips / ~1 GB and takes minutes on the camera box, so we poll
      // the status endpoint rather than block on one long request.
      await triggerTimelapse(date)
      showToast(`Building your ${date} video — this can take a minute…`, 'info')
      for (let i = 0; i < _POLL_MAX_ATTEMPTS; i++) {
        await new Promise((res) => setTimeout(res, _POLL_INTERVAL_MS))
        if (pollAbortRef.current) return
        let st
        try {
          st = await getTimelapseStatus(date)
        } catch (e) {
          // Transient poll failure (network blip) — keep trying, but log.
          log.warn('timelapses:status-poll-failed', { date, ...errFields(e) })
          continue
        }
        if (st.ready) {
          showToast(`Your ${date} video is ready`, 'success')
          try {
            const next = await listTimelapses()
            if (!pollAbortRef.current) setTimelapses(next.items)
          } catch (e) {
            log.warn('timelapses:list-refresh-failed', { date, ...errFields(e) })
          }
          return
        }
        if (!st.building) {
          // Settled without a video → a real failure (no clips / ffmpeg).
          reportError(
            'timelapses:build-failed',
            st.error || `Couldn't build the ${date} video.`,
            { date },
          )
          return
        }
        // still building → keep polling
      }
      // Exhausted the poll budget — the build may still finish server-side.
      showToast(
        `Still building your ${date} video — check back here shortly.`,
        'info',
      )
    } catch (e) {
      // The trigger POST itself failed (auth / network). Pair the toast
      // with a structured log naming the day + status (docs/logging_plan §2).
      reportError('timelapses:build-failed', 'Timelapse failed: ' + formatError(e), {
        date,
        ...errFields(e),
      })
    } finally {
      if (!pollAbortRef.current) setTimelapseGenerating(false)
    }
  }

  // iter-304: sort newest-first by date string. Server returns mtime
  // DESC, but date and mtime can diverge if the operator generates a
  // backfill. Date sort is the user's mental model.
  const sortedTimelapses = useMemo(() => {
    if (timelapses === null) return null
    return [...timelapses].sort((a, b) => b.date.localeCompare(a.date))
  }, [timelapses])

  // iter-309 (user "add the ability to delete timelapsed videos"):
  // owner-only destructive op. Optimistic UI — remove from local
  // state on confirm, restore + toast on server failure.
  const onDeleteTimelapse = async (date: string) => {
    const ok = await confirm({
      title: `Delete timelapse for ${date}?`,
      body: 'The video file will be removed from the camera box. This cannot be undone (you can rebuild from the same day if event clips are still on disk).',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    const snapshot = timelapses
    setTimelapses((cur) =>
      cur ? cur.filter((t) => t.date !== date) : cur,
    )
    try {
      await deleteTimelapse(date)
      showToast(`Removed timelapse for ${date}`, 'success')
    } catch (e) {
      setTimelapses(snapshot)
      reportError('timelapses:delete-failed', 'Could not delete: ' + formatError(e), {
        date,
        ...errFields(e),
      })
    }
  }

  const _timelapseDateValid =
    !timelapseDate.trim() || _DATE_RE.test(timelapseDate.trim())
  const _timelapseDateReady =
    !!timelapseDate.trim() && _DATE_RE.test(timelapseDate.trim())

  return (
    <Section title="Timelapses">
      <div className="px-4 py-3 space-y-3">
        {/* iter-304: friendly intro replaces the developer-voice
            "Daily timelapse summaries of detection snapshots." */}
        <p className="text-sm text-[var(--color-text-primary)]">
          Speed up a whole day of camera footage into a short video
          you can scan in seconds.
        </p>

        {/* iter-304: quick presets. Yesterday is the dominant case —
            today's footage is still being captured. The full date
            picker stays for backfill.
            iter-321 (ux-grandpa Frank Gripe #3): bumped from
            text-xs/py-1.5 to text-sm/py-2.5 (~40px touch). */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTimelapseDate(_yesterdayStr())}
            disabled={timelapseGenerating}
            className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] disabled:opacity-50 rounded-full px-4 py-2.5 border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            aria-label="Pick yesterday's date"
          >
            Yesterday
          </button>
          <button
            type="button"
            onClick={() => setTimelapseDate(_todayStr())}
            disabled={timelapseGenerating}
            className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] disabled:opacity-50 rounded-full px-4 py-2.5 border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            aria-label="Pick today's date"
          >
            Today
          </button>
        </div>

        <div className="flex gap-2 items-end">
          <label className="flex-1">
            <span className="text-sm text-[var(--color-text-primary)]">Date</span>
            {/* iter-304: native date picker. Pre-iter-304 was a free-
                text input that required exact YYYY-MM-DD format —
                every typo cost the user a round-trip + an error toast.
                `<input type="date">` gives the browser's native
                calendar picker on mobile + desktop and constrains the
                value to YYYY-MM-DD by spec. */}
            <input
              type="date"
              value={timelapseDate}
              onChange={(e) => setTimelapseDate(e.target.value)}
              max={_todayStr()}
              aria-label="Timelapse date"
              className="w-full mt-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-2 text-base text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
              disabled={timelapseGenerating}
            />
          </label>
          <button
            type="button"
            onClick={onGenerateTimelapse}
            disabled={!_timelapseDateReady || timelapseGenerating}
            className="text-sm bg-[var(--color-accent-default)] hover:bg-[var(--color-accent-bright)] text-white disabled:bg-[var(--color-surface-raised)] disabled:text-[var(--color-text-tertiary)] rounded px-4 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            aria-label="Generate timelapse"
          >
            {timelapseGenerating ? 'Building…' : 'Build video'}
          </button>
        </div>
        {!_timelapseDateValid && (
          <p
            className="text-xs text-[var(--color-danger)]"
            role="alert"
            aria-label="Timelapse date validation error"
          >
            Pick a date in the calendar above.
          </p>
        )}
        {/* iter-356.x (feature audit P1-3): name the host-helper
            dependency before the click. Pre-fix users tapped Build
            video on a freshly-installed system and got a "isn't set
            up yet" toast — the friendliness of the toast hid the
            structural fact that this is operator-installer territory. */}
        <p className="text-xs text-[var(--color-text-secondary)] -mt-1">
          Building a timelapse needs a small helper script on the
          camera box. If your installer hasn&apos;t set it up,
          you&apos;ll see a notice instead of a video.
        </p>
      </div>

      {sortedTimelapses === null ? (
        <p className="px-4 py-3 text-sm text-[var(--color-text-secondary)] border-t border-[var(--color-border)]">
          Loading…
        </p>
      ) : sortedTimelapses.length === 0 ? (
        // iter-304 → iter-356.23 (Maya pattern propagation): now
        // consumes the <CatEmptyState> primitive so this surface
        // matches the Events + People empty-state shape. The
        // wrapper border-t is preserved via the surrounding
        // section divider; the primitive itself doesn't add a
        // border.
        <div className="border-t border-[var(--color-border)]">
          <CatEmptyState
            heading="No timelapses yet"
            body="Pick a date above and tap Build video — the camera turns a whole day of footage into a short summary you can scan in seconds."
          />
        </div>
      ) : (
        <ul
          aria-label="Timelapse list"
          className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]"
        >
          {sortedTimelapses.map((t) => (
            <li
              key={t.date}
              className="px-4 py-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-mono text-[var(--color-text-primary)]">{t.date}</span>
                <span className="text-xs text-[var(--color-text-secondary)]">
                  {formatBytes(t.size_bytes)}
                </span>
              </div>
              {/* Inline player with a forward-ticking wall-clock overlay.
                  The detailed rationale (preload="none", playsInline,
                  lg:max-w-xl cap, onError logging) + the timestamp-sidecar
                  fetch live in the TimelapseVideo component below. */}
              <TimelapseVideo item={t} />
              {/* iter-321 (ux-grandpa Frank Gripe #3): Download +
                  Delete were two text-xs links sitting next to each
                  other → fat-finger risk. Now: Download is a left-
                  aligned link with hit padding; Delete is a right-
                  aligned destructive button with explicit padding +
                  spacing. Easier to distinguish, harder to misclick. */}
              <div className="flex justify-between items-center gap-4 pt-1">
                <a
                  href={t.url}
                  download
                  className="text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] text-sm py-2 px-3 -mx-3 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
                  aria-label={`Download timelapse for ${t.date}`}
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => onDeleteTimelapse(t.date)}
                  className="text-[var(--color-danger)] hover:underline text-sm py-2 px-3 -mx-3 focus-visible:outline-2 focus-visible:outline-[var(--color-danger)] focus-visible:outline-offset-2 rounded"
                  aria-label={`Delete timelapse for ${t.date}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
