import { memo, useState } from 'react'
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
}: {
  events: DetectionEvent[]
  onSelect?: (event: DetectionEvent) => void
  /** iter-307: when present, renders a per-card delete affordance
   * (small ✕ in the top-right corner). Owner-only — parent gates. */
  onDelete?: (event: DetectionEvent) => void
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
    <div className="pb-4">
      {groups.map((group) => (
        <section
          key={group.dayKey}
          aria-label={`Events on ${formatDayLabel(group.dayKey, now)}`}
        >
          <DayHeader
            label={formatDayLabel(group.dayKey, now)}
            count={group.events.length}
          />
          {/* iter-262 (desktop-view-auditor D4): event cards in a
              responsive grid. Mobile: 1 column. lg (1024+): 2
              columns. xl (1280+): 3 columns. Cuts the per-card
              thumbnail from ~1024 px wide to ~320-480 px — the
              user can scan more events per screen on desktop
              without losing the photo's information. */}
          {/* iter-286 (desktop-view-auditor D1): add 2xl:grid-cols-4
              so a 1920+ monitor lands on 4 cards/row (~390 px each)
              instead of the iter-262 3 cards/row (~530 px each
              wasted as the card title is text-base only). xl:3 still
              hits at 1280-1535. */}
          <ul className="px-4 py-3 grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 list-none">
            {group.events.map((e) => (
              <li key={e.id}>
                <EventCard
                  event={e}
                  now={now}
                  onSelect={onSelect}
                  onDelete={onDelete}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function DayHeader({ label, count }: { label: string; count: number }) {
  // iter-249: switched from `text-sm uppercase tracking-wide` (hard
  // to read at older-eyes scale) to `text-base font-semibold` in
  // sentence case. Bigger leading + clearer hierarchy. Sticky so
  // scrolling long days keeps the header visible.
  return (
    // iter-355ae (Maya Major + Minor): "Today — 3 detections" was
    // technical/log-like (em-dash + "detection" jargon Frank flagged
    // pre-iter-249). "Today · 3 events" reads consumer-app. Bumped
    // h2 from text-base → text-lg so the section break reads as a
    // full step-down from the page-title (text-2xl).
    <div className="px-4 py-3 flex items-baseline gap-2 bg-[var(--color-bg)]/95 backdrop-blur border-b border-[var(--color-border)] sticky top-[var(--day-header-top,0px)] z-[1]">
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{label}</h2>
      <span className="text-sm text-[var(--color-text-secondary)]">
        · {count} {count === 1 ? 'event' : 'events'}
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
  if (Math.floor(prev.now / 60_000) !== Math.floor(next.now / 60_000)) return false
  return true
})

function EventCardImpl({
  event: e,
  now,
  onSelect,
  onDelete,
}: {
  event: DetectionEvent
  now: number
  onSelect?: (event: DetectionEvent) => void
  /** iter-307: optional per-card delete handler. Renders a small ✕
   * button in the top-right; clicking stopPropagates so the card's
   * own onClick (open ClipModal) doesn't fire too. */
  onDelete?: (event: DetectionEvent) => void
}) {
  const clickable = !!e.thumb_url && !!onSelect
  const Wrapper = (clickable ? 'button' : 'div') as 'button' | 'div'
  const hasClip = !!e.clip_url
  const title = eventTitle(e)
  const isRecognized = !!e.person_name
  // iter-307: container relative-positions the absolute delete
  // button. Card click target stays the same (button or div); the
  // delete button is a SIBLING of the wrapper, NOT nested inside
  // (button-in-button is invalid HTML).
  return (
    <div className="relative">
    <Wrapper
      type={clickable ? 'button' : undefined}
      onClick={clickable ? () => onSelect?.(e) : undefined}
      className={`w-full text-left rounded-2xl overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] transition-colors ${
        clickable
          ? 'hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2'
          : ''
      }`}
      aria-label={
        clickable
          ? `${hasClip ? 'Play clip:' : 'Open:'} ${title} at ${absoluteTime(e.ts)}`
          : undefined
      }
    >
      {/* Thumbnail spans the card's full width — the photo is the
          point. iter-247 hid this under a full-overlay play button;
          iter-249 keeps the image visible and tucks indicators in
          the corners instead. */}
      <div className="relative w-full aspect-video bg-[var(--color-surface-raised)]">
        <EventThumbnail url={e.thumb_url} alt={title} />
        {/* Top-left: relative time pill so it's the first thing the
            eye sees alongside the photo. */}
        <span
          className="absolute top-2 left-2 px-2 py-1 rounded-md text-xs font-semibold bg-black/65 backdrop-blur text-[var(--color-text-primary)]"
          title={absoluteTime(e.ts)}
        >
          {relativeTime(e.ts, now)}
        </span>
        {/* Top-right: confidence pill. De-emphasized vs iter-247. */}
        <ConfidencePill score={e.score} />
        {/* Bottom-left: face-match badge (only when recognized).
            iter-355ae (Maya Nit): full-opacity emerald-500 was the
            loudest element on the card and competed with the
            ConfidencePill. Dropped to /85 to match the rest of the
            badge ecosystem. */}
        {isRecognized ? (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-semibold bg-emerald-500/85 text-neutral-950 shadow">
            <FaceMatchIcon />
            {e.person_name}
          </span>
        ) : null}
        {/* Bottom-right: small play badge (NOT a full-overlay).
            Visible cue that a clip exists; doesn't bury the photo. */}
        {hasClip ? (
          <span
            className="absolute bottom-2 right-2 inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/95 text-neutral-950 shadow-lg"
            aria-label="Clip available"
          >
            <PlayIcon />
          </span>
        ) : null}
      </div>
      {/* Below-the-photo title block — Frank's "what is this?" answer
          in plain English. */}
      <div className="px-4 py-3 space-y-1">
        <div className="text-base font-semibold text-[var(--color-text-primary)] truncate">
          {title}
        </div>
        {/* iter-355ae (Maya Nit): "Tap to play clip" was mobile-
            centric and patronizing on desktop. The play badge in
            the photo corner is the affordance; the whole card has
            hover state. Drop the redundant copy. */}
        <div className="text-sm text-[var(--color-text-secondary)]">
          {clockTime(e.ts)}
        </div>
      </div>
    </Wrapper>
    {/* iter-307: per-card delete button. Sits at top-right OUTSIDE
        the card edges (negative top/right offsets) so it doesn't
        collide with the in-image ConfidencePill at top-2/right-2.
        White ring around the badge keeps it readable against any
        thumbnail background. Click stops propagation so the card's
        onClick (open ClipModal) doesn't also fire.
        iter-319 (mobile-view-auditor B2): bumped from w-9 h-9 (36px)
        → w-11 h-11 (44px) to meet WCAG 2.1 AA touch-size minimum.
        ring-2 doesn't extend the touch target — only the button
        bounds do. Offset moved -top-3/-right-3 so the visual
        placement (over the card's top-right corner) is preserved. */}
    {onDelete && (
      <button
        type="button"
        onClick={(ev) => {
          ev.stopPropagation()
          onDelete(e)
        }}
        aria-label={`Delete event from ${absoluteTime(e.ts)}`}
        className="absolute -top-3 -right-3 w-11 h-11 rounded-full bg-red-600 text-[var(--color-text-primary)] flex items-center justify-center text-base font-bold shadow-lg ring-2 ring-neutral-950 hover:bg-red-500 active:bg-red-700 focus-visible:outline-2 focus-visible:outline-red-500 focus-visible:outline-offset-2 z-10"
      >
        ✕
      </button>
    )}
    </div>
  )
}

function ConfidencePill({ score }: { score: number }) {
  // Color tier: <50% red, 50-75% amber, 75%+ green. Kept low-
  // contrast vs the page background so the photo dominates.
  const pct = (score * 100).toFixed(0)
  const tier =
    score < 0.5
      ? 'bg-red-500/85 text-red-50'
      : score < 0.75
        ? 'bg-amber-500/85 text-amber-50'
        : 'bg-emerald-500/85 text-emerald-50'
  return (
    <span
      className={`absolute top-2 right-2 px-2 py-1 rounded-md text-xs font-semibold tabular-nums ${tier}`}
      aria-label={`Confidence ${pct} percent`}
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
    <CatEmptyState
      heading="All quiet out there"
      body="The camera&rsquo;s as quiet as a sleeping cat. New events will land here the moment something moves."
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
      className="text-neutral-700"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}
