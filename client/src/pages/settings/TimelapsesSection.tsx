import { useEffect, useMemo, useState } from 'react'
import {
  deleteTimelapse,
  listTimelapses,
  triggerTimelapse,
} from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { formatBytes, formatError } from '../../lib/format'
import { useToast } from '../../lib/toast'
import type { TimelapseItem } from '../../lib/api'
import { CatEmptyState } from '../../components/CatEmptyState'
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

export function TimelapsesSection() {
  const { showToast } = useToast()
  const confirm = useConfirm()
  const [timelapses, setTimelapses] = useState<TimelapseItem[] | null>(null)
  // iter-304: default to yesterday (the most common build target —
  // today's footage is mid-stream until midnight). Pre-iter-304 the
  // input started blank and the user had to type a full date.
  const [timelapseDate, setTimelapseDate] = useState<string>(() =>
    _yesterdayStr(),
  )
  const [timelapseGenerating, setTimelapseGenerating] = useState(false)

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
      .catch(() => {
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
    try {
      const r = await triggerTimelapse(date)
      if (r.note) {
        showToast(
          "Timelapse isn't set up yet on the camera box. No video was made.",
          'info',
        )
      } else {
        showToast(`Timelapse requested for ${date}`, 'success')
      }
      // Refresh the listing — even on stubbed responses the call is
      // cheap, and once slice 2 ships the file may already be there.
      try {
        const next = await listTimelapses()
        setTimelapses(next.items)
      } catch {
        // Listing failure is non-fatal; the trigger toast already
        // told the user the request landed.
      }
    } catch (e) {
      showToast('Timelapse failed: ' + formatError(e), 'error')
    } finally {
      setTimelapseGenerating(false)
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
      showToast('Could not delete: ' + formatError(e), 'error')
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
              {/* iter-304: inline `<video controls>` so the user can
                  PLAY in place instead of mandatory download.
                  iter-311 (performance-auditor #2): `preload="none"`
                  was `preload="metadata"`. With N rows, every Settings
                  System-tab open fired N parallel HTTP range requests
                  for the moov atom of each MP4 — N SD-card reads
                  competing with detection's `latest.jpg` writes, and
                  N RTTs on cellular Tailscale. `preload="none"` means
                  the browser doesn't touch the file until the user
                  clicks play. Cost: a ~250 ms first-frame delay on
                  press-play; benefit: zero work on mount.
                  jsx-a11y wants a <track>; timelapses are silent
                  speed-ramped video with no spoken content, so
                  there's nothing to caption. */}
              {/* iter-319 (mobile-view-auditor C1): `playsInline`
                  prevents iOS Safari from launching the system
                  fullscreen player on tap (which strips PWA chrome
                  and may flip orientation). Same as VideoTile's
                  WHEP <video> at iter-? */}
              {/* iter-321 (desktop-view-auditor #3): cap inline
                  video at lg:max-w-xl so a 720p MP4 doesn't upscale
                  to 900px+ on a 1920p monitor. Mobile keeps w-full. */}
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                src={t.url}
                controls
                playsInline
                preload="none"
                className="w-full lg:max-w-xl bg-black rounded border border-[var(--color-border)]"
                aria-label={`Timelapse video for ${t.date}`}
              />
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
