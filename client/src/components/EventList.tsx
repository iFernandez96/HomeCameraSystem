import { memo, useRef, useState } from 'react'
import { CatEmptyState } from './CatEmptyState'
import type { DetectionEvent } from '../lib/types'
import { useTicker } from '../lib/useTicker'

// iter-249 (UX overhaul, fix for iter-247): card-style layout that
// answers "what am I looking at" at a glance. The previous list-row
// design buried the thumbnail under a full-overlay play button and
// led with abbreviations ("person · cam1") that don't read as
// activity. Frank-test: a 72-year-old should know what happened
// without leaning in.

/** Tiny image-with-fallback component for event thumbnails. Same
 * URL-comparison-as-state pattern as `SnapshotPreview` (iter-82). */
function EventThumbnail({
  url,
  alt,
}: {
  url: string | null | undefined
  alt: string
}) {
  const [erroredUrl, setErroredUrl] = useState<string | null>(null)
  if (!url || erroredUrl === url) return <PlaceholderIcon />
  return (
    <img
      src={url}
      alt={alt}
      onError={() => setErroredUrl(url)}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  )
}

// iter-356.17: helpers moved to lib/eventLabel.ts so ClipModal +
// SnapshotPreview share the same eventTitle() / relativeTime() etc.
import {
  absoluteTime,
  clockTime,
  eventTitle,
  recognizedNames,
  relativeTime,
} from '../lib/eventLabel'

/** YYYY-MM-DD key in the user's local TZ. Mirrors the iter-223
 * `dayBounds` convention. */
function localDayKey(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatDayLabel(dayKey: string, nowMs: number): string {
  const [y, m, d] = dayKey.split('-').map((s) => parseInt(s, 10))
  const dayDate = new Date(y, m - 1, d)
  const now = new Date(nowMs)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (dayDate.getTime() === today.getTime()) return 'Today'
  if (dayDate.getTime() === yesterday.getTime()) return 'Yesterday'
  return dayDate.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

// iter-347: useTicker hoisted to `client/src/lib/useTicker.ts`;
// imported below. Same default (30s) — relative-time displays
// in 1-minute buckets, two ticks per minute is enough.

type DayGroup = { dayKey: string; events: DetectionEvent[] }
function groupEventsByDay(events: DetectionEvent[]): DayGroup[] {
  const groups: DayGroup[] = []
  let current: DayGroup | null = null
  for (const e of events) {
    const k = localDayKey(e.ts)
    if (current === null || current.dayKey !== k) {
      current = { dayKey: k, events: [] }
      groups.push(current)
    }
    current.events.push(e)
  }
  return groups
}

export function EventList({
  events,
  onSelect,
  onDelete,
  cameraOffline = false,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
}: {
  events: DetectionEvent[]
  onSelect?: (event: DetectionEvent) => void
  /** iter-307: when present, renders a per-card delete affordance
   * (small ✕ in the top-right corner). Owner-only — parent gates. */
  onDelete?: (event: DetectionEvent) => void
  /** iter-356.x: multi-select desktop bulk-delete. When true,
   * cards render a checkbox and clicks toggle selection instead
   * of opening ClipModal. Owner-only — parent gates. */
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (event: DetectionEvent) => void
  /**
   * iter-356.24 (Frank ux-grandpa #1 carryover from iter-356.22):
   * when true AND no events exist, the empty state pivots from the
   * sleeping-cat "all is calm" message to a "camera is offline"
   * message. Pre-iter-356.24 the same sleeping-cat surface rendered
   * for both cases — Frank's wife "would stare at the sleeping cat
   * for two hours wondering why the front door wasn't showing up."
   * Source: ServerStatus.worker_alive=false OR
   * ServerStatus.detection_active=false (parent decides which
   * states count as "offline").
   */
  cameraOffline?: boolean
}) {
  const now = useTicker()

  if (events.length === 0) {
    return <EmptyState cameraOffline={cameraOffline} />
  }

  const groups = groupEventsByDay(events)

  return (
    // iter-356.58 (LAYOUT REBUILD): the responsive Pinterest grid
    // (grid-cols-1 / lg:cols-2 / xl:cols-3 / 2xl:cols-4) was the
    // single most "generic SaaS dashboard" layout in the app. Maya
    // brutal verdict: "Three-column equal-card Events grid + right-
    // rail calendar is a Stripe-dashboard cliché. A camera review
    // surface should be a TIMELINE."
    //
    // Timeline structure:
    //   - one column flowing top-down, capped at lg:max-w-3xl.
    //   - each event is a horizontal row: TIME column (left, brass-
    //     accent timestamps in monospace tabular nums), AXIS line
    //     (1px continuous vertical line down the left), and a
    //     HORIZONTAL event card to the right (thumbnail-left, meta-
    //     right). NOT a square grid card.
    //   - per-day section headers carry the day name in Fraunces
    //     serif and a brass entry-count tag (already implemented).
    //
    // Effect: Events page reads as a vertical incident log. The
    // axis line gives spatial coherence; the time column makes
    // when-something-happened scannable without scanning into
    // each card.
    <div className="pb-4 lg:max-w-3xl lg:mx-auto">
      {groups.map((group) => (
        <section
          key={group.dayKey}
          aria-label={`Events on ${formatDayLabel(group.dayKey, now)}`}
        >
          <DayHeader
            label={formatDayLabel(group.dayKey, now)}
            count={group.events.length}
          />
          {/* iter-356.58: vertical timeline body. The axis line is
              an absolutely-positioned 1px brass-tinted line at
              left: 4.25rem (matches the right edge of the time
              column). Each entry gets a 0.5rem-wide axis tick. */}
          <ol className="relative list-none px-4 pt-2 pb-3">
            <span
              aria-hidden="true"
              className="absolute left-[4.25rem] top-2 bottom-2 w-px bg-[var(--color-border-subtle)]"
            />
            {group.events.map((e) => (
              <li key={e.id} className="relative pl-20 pb-3 last:pb-0">
                {/* TIME column — brass uppercase tabular nums */}
                <span
                  className="absolute left-0 top-2 w-14 text-right text-xs font-medium uppercase tracking-wider text-[var(--color-brass-default)] tabular-nums"
                  title={absoluteTime(e.ts)}
                >
                  {clockTime(e.ts)}
                </span>
                {/* AXIS tick — small filled circle on the axis line */}
                <span
                  aria-hidden="true"
                  className="absolute left-[3.875rem] top-3.5 w-2.5 h-2.5 rounded-full bg-[var(--color-accent-default)] ring-2 ring-[var(--color-bg)]"
                />
                <EventCard
                  event={e}
                  now={now}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  selectionMode={selectionMode}
                  isSelected={selectedIds?.has(e.id) ?? false}
                  onToggleSelect={onToggleSelect}
                />
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function DayHeader({ label, count }: { label: string; count: number }) {
  // iter-356.57 (radical redesign — Maya Critical "incident journal"):
  // day headers reframed as a watch-log. Fraunces serif h2 + brass-
  // accent count tag reads as ledger entry, not Pinterest section.
  // Sticky behavior + safe-area math preserved.
  const logSuffix =
    label === 'Today'
      ? "Today's log"
      : label === 'Yesterday'
        ? "Yesterday's log"
        : label
  // iter-356.66 (real-device user feedback): dropped sticky.
  // Pre-fix this label pinned to the viewport top (with the page
  // header scrolled away), so the calendar icon got unreachable
  // while the user was deep in events. User explicitly asked:
  // "calendar icon needs to follow scroll, not the today's log."
  // The Events page-header now owns sticky; the DayHeader scrolls
  // naturally with the events it labels — appearing once at the
  // start of each day group and sliding off-screen as the user
  // reads past it.
  return (
    <div className="px-4 pt-3 pb-2 flex items-baseline gap-3 border-b border-[var(--color-border-subtle)]">
      <h2 className="font-display text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">
        {logSuffix}
      </h2>
      <span className="text-xs uppercase tracking-[0.16em] text-[var(--color-brass-default)] font-semibold">
        {count} {count === 1 ? 'entry' : 'entries'}
      </span>
    </div>
  )
}

// iter-312 (performance-auditor #5): wrap EventCard in React.memo
// with a per-prop equality check that skips the ticker-only update
// when the event's relative-time bucket hasn't changed. Pre-iter-312:
// every WS event arrival caused all 200 cards to re-render
// (onDelete + onSelect references change with the parent render);
// every 30 s the useTicker bumped `now`, re-rendering all 200
// regardless. With memo + a stable handler ref from parent's
// useCallback, only NEW cards mount and only cards whose
// relative-time bucket flipped (e.g. "5m ago" → "10m ago") re-render.
const EventCard = memo(EventCardImpl, (prev, next) => {
  // Re-render only when:
  // - the event identity changes (different event)
  // - person_name changed (face-recog backfill arrived)
  // - clip_url flipped (clip recording finished)
  // - thumb_url flipped (thumb upload finished)
  // - the ticker bucket flipped (relative time crossed a 60 s
  //   boundary, so "5m ago" → "5m ago" doesn't re-render but
  //   "59m ago" → "60m ago" does). Round to whole minutes — the
  //   30 s ticker fires twice per minute; we don't want a re-render
  //   on each tick when the displayed string is unchanged.
  // - either handler reference changed (parent should useCallback
  //   to keep these stable across renders)
  if (prev.event.id !== next.event.id) return false
  if (prev.event.person_name !== next.event.person_name) return false
  // iter-357 (multi-person face-recog): the new `person_names`
  // list can change in the same backfill scenarios as the legacy
  // `person_name` field (worker re-runs face-recog on a clip
  // that was indecisive at detection time). Cheap structural
  // compare via JSON.stringify is bounded: list is capped at 16
  // names × 64 chars per server validation, so worst case ~1 KiB
  // per call. 99% of events are single-person where both sides
  // are null and the cheap === short-circuit fires before the
  // serialize.
  const prevNames = prev.event.person_names
  const nextNames = next.event.person_names
  if (prevNames !== nextNames) {
    if (
      JSON.stringify(prevNames ?? null) !== JSON.stringify(nextNames ?? null)
    ) {
      return false
    }
  }
  if (prev.event.clip_url !== next.event.clip_url) return false
  if (prev.event.thumb_url !== next.event.thumb_url) return false
  // iter-343 (perf A1 from iter-333 broad audit): label may
  // change if a future iter wires server-side label backfill
  // (analogous to person_name backfill above). Latent today —
  // worker emits label exactly once at detection time and it
  // never changes — but the check is symmetric with person_name.
  if (prev.event.label !== next.event.label) return false
  if (prev.onSelect !== next.onSelect) return false
  if (prev.onDelete !== next.onDelete) return false
  // iter-356.x multi-select: re-render on mode flip or selection
  // toggle for THIS card. Other cards' selection changes don't
  // trip the memo because isSelected is computed per-card upstream.
  if (prev.selectionMode !== next.selectionMode) return false
  if (prev.isSelected !== next.isSelected) return false
  if (prev.onToggleSelect !== next.onToggleSelect) return false
  if (Math.floor(prev.now / 60_000) !== Math.floor(next.now / 60_000)) return false
  return true
})

function EventCardImpl({
  event: e,
  now,
  onSelect,
  onDelete,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: {
  event: DetectionEvent
  now: number
  onSelect?: (event: DetectionEvent) => void
  /** iter-307: optional per-card delete handler. Renders a small ✕
   * button in the top-right; clicking stopPropagates so the card's
   * own onClick (open ClipModal) doesn't fire too. */
  onDelete?: (event: DetectionEvent) => void
  /** iter-356.x desktop bulk-select. When true, the card click
   * toggles selection instead of opening the clip modal, and a
   * checkbox renders at the leading edge. Mobile swipe is suppressed
   * in selection mode so taps land predictably. */
  selectionMode?: boolean
  isSelected?: boolean
  onToggleSelect?: (event: DetectionEvent) => void
}) {
  const clickable = !!e.thumb_url && !!onSelect
  // iter-356.x: in selection mode the wrapper is always a button so
  // taps register as toggles even on rows without thumb_url (which
  // would otherwise be a non-clickable <div>). Otherwise: keep the
  // pre-existing button-when-clickable / div-when-not behavior.
  const Wrapper = (clickable || selectionMode ? 'button' : 'div') as
    | 'button'
    | 'div'
  const hasClip = !!e.clip_url
  const title = eventTitle(e)
  // iter-357 (multi-person face-recog): defense in depth — the
  // server-side Pydantic invariant guarantees `person_name` is set
  // when `person_names` is, but the client predicate covers both
  // shapes so a future server / pathological wire payload that
  // skips the derive step still surfaces the chip + recognized-
  // event aria treatment.
  const isRecognized = !!e.person_name || !!(e.person_names && e.person_names.length > 0)

  // iter-356.62 (bug #2 — user "no way to delete any of the logs"):
  // swipe-left-to-reveal-delete. Touch only — pointer/mouse users
  // already have the always-visible ✕ in the corner. On touchstart we
  // record the starting clientX. On touchmove we translate the card
  // negatively (capped at -SWIPE_REVEAL so the rubber-banding doesn't
  // run away). On touchend, if the user swiped past SWIPE_THRESHOLD
  // we latch the card open (revealing the red Delete pad behind it);
  // tapping the pad calls onDelete (which the parent has wired to
  // the existing useConfirm flow). Below threshold we snap back.
  // The pad sits BEHIND the card (absolute, full-height, right-aligned)
  // so the card slides over it like an iOS list row.
  const SWIPE_THRESHOLD = 80 // px past which the row latches open
  const SWIPE_REVEAL = 96 // pad width
  const [translateX, setTranslateX] = useState(0)
  const [revealed, setRevealed] = useState(false)
  // iter-356.62: `dragging` is state (not ref) so the transition
  // attribute below can switch between "no transition while finger
  // tracks" and "snap with ease-out on release" reactively, without
  // reading a ref during render (eslint react-hooks/refs).
  const [dragging, setDragging] = useState(false)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const touchAxis = useRef<'h' | 'v' | null>(null)

  const onTouchStart = (ev: React.TouchEvent) => {
    if (!onDelete) return
    const t = ev.touches[0]
    touchStartX.current = t.clientX
    touchStartY.current = t.clientY
    touchAxis.current = null
    setDragging(true)
  }
  const onTouchMove = (ev: React.TouchEvent) => {
    if (!onDelete || touchStartX.current === null) return
    const t = ev.touches[0]
    const dx = t.clientX - touchStartX.current
    const dy = t.clientY - (touchStartY.current ?? t.clientY)
    if (touchAxis.current === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        touchAxis.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
      }
    }
    if (touchAxis.current !== 'h') return
    // Constrain to leftward drags (rightward dismisses any reveal).
    if (dx < 0) {
      setTranslateX(Math.max(dx, -SWIPE_REVEAL))
    } else if (revealed) {
      // Allow drag-right to close the reveal.
      setTranslateX(Math.min(-SWIPE_REVEAL + dx, 0))
    } else {
      setTranslateX(0)
    }
  }
  const onTouchEnd = () => {
    if (!onDelete) return
    const start = touchStartX.current
    touchStartX.current = null
    touchStartY.current = null
    setDragging(false)
    if (touchAxis.current !== 'h' || start === null) {
      touchAxis.current = null
      return
    }
    touchAxis.current = null
    if (translateX <= -SWIPE_THRESHOLD) {
      setTranslateX(-SWIPE_REVEAL)
      setRevealed(true)
    } else {
      setTranslateX(0)
      setRevealed(false)
    }
  }

  // iter-307: container relative-positions the absolute delete
  // button. Card click target stays the same (button or div); the
  // delete button is a SIBLING of the wrapper, NOT nested inside
  // (button-in-button is invalid HTML).
  // iter-356.58 (LAYOUT REBUILD): horizontal log-entry card.
  // Thumbnail (left, w-28 h-20) + metadata column (right). Replaces
  // the iter-262 square aspect-video Pinterest tile.
  // iter-356.62 (bug #2): the outer wrapper now also carries the
  // touch handlers for swipe-to-delete; the inner translating div
  // slides over the (BEHIND) Delete pad.
  // In selection mode, suppress swipe-to-delete so taps consistently
  // toggle selection. Hover delete-x is also hidden via the wrapper
  // class below.
  const swipeActive = !!onDelete && !selectionMode
  return (
    <div
      className="relative group"
      onTouchStart={swipeActive ? onTouchStart : undefined}
      onTouchMove={swipeActive ? onTouchMove : undefined}
      onTouchEnd={swipeActive ? onTouchEnd : undefined}
      onTouchCancel={swipeActive ? onTouchEnd : undefined}
    >
      {/* iter-356.62 (bug #2): the swipe-reveal Delete pad. Sits
          BEHIND the card; the card slides over it as the user swipes
          left. Only rendered when onDelete is wired (parent gates by
          owner role). Hidden from screen readers — the X button
          below is the a11y-canonical surface; this is touch-
          affordance only. */}
      {onDelete && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 flex items-center justify-center bg-[var(--color-danger)] rounded-xl overflow-hidden"
          style={{ width: SWIPE_REVEAL }}
        >
          <button
            type="button"
            tabIndex={revealed ? 0 : -1}
            aria-hidden={revealed ? undefined : true}
            onClick={(ev) => {
              ev.stopPropagation()
              onDelete(e)
              setTranslateX(0)
              setRevealed(false)
            }}
            aria-label={`Delete event from ${absoluteTime(e.ts)} (swipe)`}
            data-testid="swipe-delete-button"
            className="w-full h-full text-white font-semibold text-sm focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-[-4px]"
            style={{ pointerEvents: revealed ? 'auto' : 'none' }}
          >
            Delete
          </button>
        </div>
      )}
      <div
        style={{
          transform: `translate3d(${translateX}px, 0, 0)`,
          transition: dragging ? 'none' : 'transform 0.2s ease-out',
        }}
      >
      <Wrapper
        type={clickable || selectionMode ? 'button' : undefined}
        onClick={
          selectionMode
            ? () => onToggleSelect?.(e)
            : clickable
              ? () => onSelect?.(e)
              : undefined
        }
        aria-pressed={selectionMode ? isSelected : undefined}
        // redesign/warm-boutique: paper card — warm shadow-card token
        // so entries read as paper resting on the linen page.
        className={`w-full text-left flex gap-3 rounded-xl border p-2 transition-colors shadow-[var(--shadow-card)] ${
          selectionMode && isSelected
            ? 'bg-[var(--color-accent-subtle)] border-[var(--color-accent-default)]'
            : 'bg-[var(--color-surface)] border-[var(--color-border)]'
        } ${
          clickable || selectionMode
            ? 'hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-raised)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2'
            : ''
        }`}
        aria-label={
          selectionMode
            ? `${isSelected ? 'Deselect' : 'Select'} ${title} at ${absoluteTime(e.ts)}`
            : clickable
              ? `${hasClip ? 'Play clip:' : 'Open:'} ${title} at ${absoluteTime(e.ts)}`
              : undefined
        }
      >
        {selectionMode && (
          <span
            aria-hidden="true"
            className={`flex-none w-5 h-5 self-center rounded border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? 'bg-[var(--color-accent-default)] border-[var(--color-accent-default)] text-white'
                : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'
            }`}
          >
            {isSelected ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : null}
          </span>
        )}
        {/* THUMBNAIL — left, fixed 112x72 with 16:9 framing. */}
        <div className="relative w-28 h-[72px] flex-none rounded-lg overflow-hidden bg-[var(--color-surface-raised)]">
          <EventThumbnail url={e.thumb_url} alt={title} />
          {hasClip ? (
            <span
              className="absolute bottom-1 right-1 inline-flex items-center justify-center w-6 h-6 rounded-full bg-black/70 text-white shadow"
              aria-label="Clip available"
            >
              <PlayIcon />
            </span>
          ) : null}
          <ConfidencePill score={e.score} />
        </div>
        {/* META — right, vertical stack: title / timestamp + face match */}
        <div className="flex-1 min-w-0 flex flex-col py-0.5 gap-0.5">
          <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
            {title}
          </div>
          <div className="text-xs text-[var(--color-text-secondary)]">
            {relativeTime(e.ts, now)}
          </div>
          {isRecognized ? (
            <div className="mt-auto pt-1.5 flex items-center gap-1 flex-wrap">
              {/* iter-357 (multi-person face-recog): when several
                  known faces matched the event, render one chip
                  per name (capped at 3 visible + a "+N" overflow
                  pill so the card height stays bounded on dense
                  rows). The matched-face icon stays only on the
                  first chip — repeating it next to every name is
                  visual noise. The chip stack is queryable by
                  role/name for VO + NVDA so a SR user hears
                  "Israel, button. Sheenal, button." instead of
                  the pre-iter-357 single name. */}
              {(() => {
                const names = recognizedNames(e)
                const VISIBLE = 3
                const visible = names.slice(0, VISIBLE)
                const overflow = names.length - visible.length
                return (
                  <>
                    {visible.map((name, i) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-[var(--color-success-bg)] text-[var(--color-success)] border border-[var(--color-success-border)]"
                      >
                        {i === 0 ? <FaceMatchIcon /> : null}
                        {name}
                      </span>
                    ))}
                    {overflow > 0 ? (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] border border-[var(--color-border)] tabular-nums"
                        aria-label={`${overflow} more ${overflow === 1 ? 'person' : 'people'} matched`}
                      >
                        +{overflow}
                      </span>
                    ) : null}
                  </>
                )
              })()}
            </div>
          ) : null}
        </div>
      </Wrapper>
      {onDelete && !selectionMode && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation()
            onDelete(e)
          }}
          aria-label={`Delete event from ${absoluteTime(e.ts)}`}
          // Premium-launch slice (Frank top #1): pre-fix the delete
          // ✕ was `opacity-0 group-hover:opacity-100`. On touch
          // devices `:hover` doesn't fire, so the only delete path
          // on mobile was the hidden swipe-left gesture — Frank's
          // wife will never find that. Now: visible by default on
          // mobile (touch-first), still hover-revealed on desktop
          // (lg+) so the row card stays uncluttered for the
          // pointer-precise reviewer flow.
          className="absolute top-1/2 -translate-y-1/2 -right-2 min-w-[44px] min-h-[44px] rounded-full bg-[var(--color-danger-strong)] hover:bg-[var(--color-danger)] text-white flex items-center justify-center text-sm font-bold shadow-md ring-2 ring-[var(--color-bg)] opacity-90 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 lg:focus-visible:opacity-100 transition-opacity active:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--color-danger)] focus-visible:outline-offset-2 z-10"
        >
          ✕
        </button>
      )}
      </div>
    </div>
  )
}

function ConfidencePill({ score }: { score: number }) {
  // Color tier: <50% red, 50-75% amber, 75%+ green. Kept low-
  // contrast vs the page background so the photo dominates.
  // iter-356.56 (Frank E4 + Dana F2): aria-label spells out "How
  // sure the camera was: 87%, high" — engineer-vocab "Confidence"
  // is not a word non-technical users map to camera certainty, and
  // the tier text gives screen-reader users the tier word.
  //
  // iter-356.66 (real-device fix): SOLID base tokens (not the *-bg
  // tinted variants) + ring-1 + shadow-sm so the corner-of-image
  // pill reads as a label pasted on top of the photo, not a tint
  // baked into the photo.
  //
  // Premium-launch slice (Maya Major) — drop the L/M/H letter.
  // Pre-fix the pill triple-encoded confidence with hue + L/M/H
  // glyph + percentage. Maya: "engineer paranoia" — the percentage
  // alone is a universal numeric signal (no English needed); hue
  // is the second redundant channel; the aria-label still spells
  // out "low/medium/high" for screen readers; and the lightness
  // contrast between red-strong / amber / green is distinguishable
  // even when hue perception is impaired (deuter/protan/tritan).
  // The L/M/H glyph at 11 px italic-bold inside a 32 px pill on a
  // photographic backdrop was visual clutter, not signal.
  const pct = (score * 100).toFixed(0)
  const tier =
    score < 0.5
      ? 'bg-[var(--color-danger-strong)] text-white'
      : score < 0.75
        ? 'bg-[var(--color-warning)] text-[var(--color-bg)]'
        : 'bg-[var(--color-success)] text-[var(--color-bg)]'
  const tierLabel =
    score < 0.5 ? 'low' : score < 0.75 ? 'medium' : 'high'
  return (
    <span
      className={`absolute top-1 right-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold tabular-nums ring-1 ring-black/30 shadow-sm ${tier}`}
      aria-label={`How sure the camera was: ${pct}%, ${tierLabel}`}
    >
      {pct}%
    </span>
  )
}

function EmptyState({ cameraOffline }: { cameraOffline: boolean }) {
  // iter-356.22 → iter-356.23 → iter-356.24: branches on cameraOffline.
  //
  // Sleeping-cat path (default, camera healthy + waiting):
  //   Maya Major #3: "front porch" presumes camera location;
  //   universal "out there" survives any install location.
  //   Maya Major #4 + Frank #2: "Coco" name without context reads
  //   as a typo. "as quiet as a sleeping cat" keeps warmth without
  //   requiring the user to know cat names.
  //   Frank #3: hint at text-sm not text-xs; "confidence threshold"
  //   jargon → "Sensitivity slider" (matches Settings label).
  //
  // Camera-offline path (iter-356.24, Frank carryover from iter-356.22):
  //   The pre-iter-356.24 sleeping-cat surface rendered identically
  //   whether the camera was actually quiet OR was offline / not
  //   detecting. Frank: "She'd stare at the sleeping cat for two
  //   hours wondering why the front door wasn't showing up." Now
  //   the empty state pivots — different copy, different aria-label,
  //   directs the user to Live to diagnose. Sleeping cat reserved
  //   for "camera is on and nothing happened," which is the only
  //   case where the cat is emotionally accurate.
  if (cameraOffline) {
    return (
      <CatEmptyState
        heading="Camera looks offline"
        body="Detection isn&rsquo;t running right now, so new events can&rsquo;t land here. Check the Live tab to see what the camera&rsquo;s doing."
        hint="If this stays this way, restart the camera box or check that detection is turned on in Settings."
        ariaLabel="Camera offline — no events being recorded"
      />
    )
  }
  return (
    // iter-356.57 (cat-brand brief): Coco's the Peacekeeper — empty
    // event list IS Coco's calm watch. Copy attributes the quiet
    // stretch to her without making the cat speak.
    <CatEmptyState
      heading="Nothing came knocking."
      body="Panther, Mushu and Coco have the door covered. New events will land here the moment something moves."
      hint="Try walking in front of the camera, or open Settings and lower the Sensitivity slider."
      ariaLabel="All quiet — no events yet"
    />
  )
}

function FaceMatchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PlaceholderIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--color-text-tertiary)]"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}
