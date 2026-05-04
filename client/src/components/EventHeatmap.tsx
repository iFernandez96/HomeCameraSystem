import { useEffect, useMemo, useState } from 'react'
import { getEventCountsByDay } from '../lib/api'

/**
 * iter-252: month-by-month calendar with prev/next navigation +
 * Today shortcut + 5-year history cap.
 *
 * iter-223 shipped a 30-day SVG strip; iter-250 turned it into a
 * 7-column grid for the same 30-day window; iter-252 generalises to
 * any month within the last 60 months. The user tapped the calendar
 * icon expecting to scroll back through history — this delivers
 * exactly that.
 *
 * Server fetch: bounded by `since_ts`/`until_ts` for the displayed
 * month (NOT the default trailing 30 days). Each navigation refetches
 * — counts are sub-ms server-side and the UI already handles the
 * brief loading state via the existing `counts === null` branch.
 */

const _MAX_MONTHS_BACK = 60 // 5 years
const _WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const _MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export type EventHeatmapProps = {
  onSelectDay?: (sinceTs: number, untilTs: number, day: string) => void
  personName?: string
  faceUnrecognized?: boolean
}

type ViewMonth = { year: number; month: number } // month is 0-indexed

function currentMonth(): ViewMonth {
  const d = new Date()
  return { year: d.getFullYear(), month: d.getMonth() }
}

function addMonths(view: ViewMonth, delta: number): ViewMonth {
  const d = new Date(view.year, view.month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}

function monthsDiff(a: ViewMonth, b: ViewMonth): number {
  return (a.year - b.year) * 12 + (a.month - b.month)
}

export function EventHeatmap({
  onSelectDay,
  personName,
  faceUnrecognized,
}: EventHeatmapProps) {
  const [view, setView] = useState<ViewMonth>(() => currentMonth())
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState<unknown>(null)
  // iter-252: bump on visibility-resume to force a refetch even
  // when sinceTs/untilTs are unchanged. The fetch effect's dep
  // array compares numeric refs; same month = same numbers =
  // skipped effect, missing the resume signal. This counter is
  // the cleanest way to inject "fetch again."
  const [refetchKey, setRefetchKey] = useState(0)
  // Derived loading state — counts is null between mount and the
  // first fetch resolution. Using `counts === null` keeps the lint
  // rule `react-hooks/set-state-in-effect` happy (no synchronous
  // setLoading in the effect body — see CLAUDE.md sharp edge).
  const loading = counts === null

  const today = useMemo(() => currentMonth(), [])
  const isCurrentMonth =
    view.year === today.year && view.month === today.month
  const monthsBack = monthsDiff(today, view)
  const canGoPrev = monthsBack < _MAX_MONTHS_BACK
  const canGoNext = !isCurrentMonth

  // Server-side bounds for the displayed month. Local-time midnight
  // on day 1 → local-time midnight on day 1 of next month.
  const [sinceTs, untilTs] = useMemo(() => {
    const start = new Date(view.year, view.month, 1, 0, 0, 0, 0)
    const end = new Date(view.year, view.month + 1, 1, 0, 0, 0, 0)
    return [start.getTime() / 1000, end.getTime() / 1000]
  }, [view])

  useEffect(() => {
    let cancelled = false
    const filters: Parameters<typeof getEventCountsByDay>[0] = {
      since_ts: sinceTs,
      until_ts: untilTs,
    }
    if (personName) filters.person_name = personName
    if (faceUnrecognized) filters.face_unrecognized = true
    getEventCountsByDay(filters)
      .then((r) => {
        if (cancelled) return
        setCounts(r.counts)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [sinceTs, untilTs, personName, faceUnrecognized, refetchKey])

  // Refetch the visible month on tab resume so a long-open page
  // doesn't show stale counts after overnight events. Same pattern
  // as the iter-37 / iter-157 / iter-158 visibility-aware channels
  // documented in CLAUDE.md.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setRefetchKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const days = useMemo(() => buildMonthDays(view.year, view.month), [view])
  const leadPad = useMemo(() => {
    if (days.length === 0) return 0
    const [y, m, d] = days[0].split('-').map(Number)
    return new Date(y, m - 1, d).getDay()
  }, [days])
  const max = useMemo(() => {
    if (!counts) return 0
    let m = 0
    for (const v of Object.values(counts)) {
      if (v > m) m = v
    }
    return m
  }, [counts])
  const todayKey = useMemo(() => formatYMD(new Date()), [])

  if (error) {
    return (
      <p
        className="px-4 py-2 text-xs text-red-400"
        role="alert"
        aria-label="Heatmap load error"
      >
        Couldn&apos;t load activity heatmap.
      </p>
    )
  }

  return (
    <div className="px-4 py-3">
      {/* Month navigation header. Prev disabled past 5-year cap;
          Next disabled when viewing the current month (no future
          events to show). */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => canGoPrev && setView((v) => addMonths(v, -1))}
          disabled={!canGoPrev}
          aria-label="Previous month"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--color-surface)] text-[var(--color-text-primary)] ring-1 ring-[var(--color-border)] hover:ring-[var(--color-border-strong)] disabled:opacity-40 disabled:hover:ring-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          <ChevronLeftIcon />
        </button>
        <div className="flex items-baseline gap-2">
          <h3 className="text-base font-semibold text-[var(--color-text-primary)]">
            {_MONTH_NAMES[view.month]} {view.year}
          </h3>
          {!isCurrentMonth ? (
            <button
              type="button"
              onClick={() => setView(currentMonth())}
              className="text-xs text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
              aria-label="Jump to current month"
            >
              Today
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => canGoNext && setView((v) => addMonths(v, 1))}
          disabled={!canGoNext}
          aria-label="Next month"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--color-surface)] text-[var(--color-text-primary)] ring-1 ring-[var(--color-border)] hover:ring-[var(--color-border-strong)] disabled:opacity-40 disabled:hover:ring-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          <ChevronRightIcon />
        </button>
      </div>
      <div
        className="grid grid-cols-7 gap-1 text-xs"
        role="grid"
        aria-label={`Detection events per day, ${_MONTH_NAMES[view.month]} ${view.year}`}
        aria-busy={loading}
      >
        {_WEEKDAYS.map((label) => (
          <div
            key={`hdr-${label}`}
            // iter-356.13 (Frank Round-2 #5): bumped from text-[10px] +
            // text-[var(--color-text-tertiary)] (mid-gray on dark, borderline AA + tiny)
            // to text-xs + text-[var(--color-text-secondary)]. Frank's bifocals can read
            // it without wiping his phone.
            className="text-center text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] pb-1"
            role="columnheader"
          >
            {label}
          </div>
        ))}
        {Array.from({ length: leadPad }).map((_, i) => (
          <div key={`pad-${i}`} className="aspect-square" aria-hidden="true" />
        ))}
        {days.map((day) => {
          const count = counts?.[day] ?? 0
          const isToday = day === todayKey
          const dayNum = parseInt(day.slice(-2), 10)
          const tier = cellTier(count, max)
          const interactive = !!onSelectDay
          const Cell = (interactive ? 'button' : 'div') as 'button' | 'div'
          return (
            <Cell
              key={day}
              type={interactive ? 'button' : undefined}
              onClick={
                interactive
                  ? () => {
                      const [s, u] = dayBounds(day)
                      onSelectDay(s, u, day)
                    }
                  : undefined
              }
              className={[
                // iter-356.8 (mobile-desktop M2): min-h-[44px] hits the
                // WCAG 2.5.5 touch-target minimum even on a 320px iPhone
                // SE viewport where 7 cols × 4px gap ÷ 288px ≈ 37.7px per
                // cell would otherwise fail. aspect-square makes the
                // cell wider on larger viewports as needed.
                'aspect-square min-h-[44px] rounded-md flex flex-col items-center justify-center font-medium transition-colors',
                tier.bg,
                tier.text,
                isToday ? 'ring-2 ring-blue-400' : '',
                interactive
                  ? 'hover:brightness-110 active:brightness-125 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={`${formatHumanDate(day)}: ${count} ${
                count === 1 ? 'detection' : 'detections'
              }${isToday ? ' (today)' : ''}`}
            >
              <span className="text-sm leading-none">{dayNum}</span>
              {count > 0 ? (
                <span className="text-[9px] leading-none mt-0.5 tabular-nums opacity-90">
                  {count}
                </span>
              ) : null}
            </Cell>
          )
        })}
      </div>
      {max > 0 ? (
        // iter-356.13 (Frank Round-2 #6): "Less"/"More" in isolation
        // doesn't say WHAT is being measured. Frank: "Less what?
        // More cats? More burglars?". Spell it out.
        <div className="flex items-center gap-2 mt-3 text-xs text-[var(--color-text-secondary)]">
          <span>Fewer detections</span>
          <span className="w-3 h-3 rounded bg-[var(--color-surface-raised)] border border-[var(--color-border)]" />
          <span className="w-3 h-3 rounded bg-[var(--color-accent-subtle)]" />
          <span className="w-3 h-3 rounded bg-amber-300" />
          <span className="w-3 h-3 rounded bg-[var(--color-accent-default)]" />
          <span className="w-3 h-3 rounded bg-[var(--color-accent-bright)]" />
          <span>More detections</span>
        </div>
      ) : null}
    </div>
  )
}

// Visible for tests + reuse. Returns YYYY-MM-DD strings for every
// day in the given month, oldest first.
export function buildMonthDays(year: number, month: number): string[] {
  const out: string[] = []
  // month+1 with day 0 = last day of `month`. Use that to know how
  // many days the month has — works for leap years too.
  const lastDay = new Date(year, month + 1, 0).getDate()
  for (let d = 1; d <= lastDay; d++) {
    out.push(formatYMD(new Date(year, month, d)))
  }
  return out
}

// iter-223 buildDayList kept for backward compat with tests that
// import it directly. Returns trailing-N-days oldest-first.
export function buildDayList(n: number, today: Date = new Date()): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    out.push(formatYMD(d))
  }
  return out
}

function formatYMD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatHumanDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return [start.getTime() / 1000, end.getTime() / 1000]
}

type CellTier = { bg: string; text: string }

function cellTier(count: number, max: number): CellTier {
  if (count === 0 || max <= 0) {
    return { bg: 'bg-[var(--color-surface-raised)]', text: 'text-[var(--color-text-tertiary)]' }
  }
  const ratio = count / max
  // iter-355ae (Maya Major): heat ramp stays in ONE hue family.
  // Pre-iter-355ae the top tier flipped from blue-500 to emerald-500
  // — that hue jump reads as "different state" not "more activity"
  // (GitHub's contribution graph stays in one family for the same
  // reason). All four populated tiers now ramp through blue.
  if (ratio < 0.25) return { bg: 'bg-[var(--color-accent-subtle)]', text: 'text-[var(--color-text-primary)]' }
  if (ratio < 0.5) return { bg: 'bg-amber-300', text: 'text-[var(--color-text-primary)]' }
  if (ratio < 0.75) return { bg: 'bg-[var(--color-accent-default)]', text: 'text-white' }
  return { bg: 'bg-[var(--color-accent-bright)]', text: 'text-white' }
}

function ChevronLeftIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}
