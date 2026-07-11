import { useMemo, useState } from 'react'
import type { DetectionEvent } from '../lib/types'
import { clockTime, eventTitle } from '../lib/eventLabel'
import { identityOf, type IdentityKind } from '../lib/identity'
import { useTicker } from '../lib/useTicker'

const DAY_S = 24 * 60 * 60
const CLUSTER_GAP_S = 10 * 60
const CLUSTER_MAX_SPAN_S = 30 * 60
const _AXIS_LABELS = [
  ['12 AM', 0],
  ['6 AM', 25],
  ['Noon', 50],
  ['6 PM', 75],
  ['12 AM', 100],
] as const

const _KIND_RANK: Record<IdentityKind, number> = {
  'named-person': 3,
  person: 3,
  cat: 2,
  other: 1,
}

type TimelineEvent = {
  event: DetectionEvent
  startTs: number
  endTs: number
}

type EventCluster = {
  id: string
  events: TimelineEvent[]
  startTs: number
  endTs: number
  color: string
}

function eventBounds(event: DetectionEvent, dayStartTs: number): TimelineEvent {
  const rawStart = typeof event.start_ts === 'number' && Number.isFinite(event.start_ts)
    ? event.start_ts
    : event.ts
  const rawEnd = typeof event.end_ts === 'number' && Number.isFinite(event.end_ts)
    ? event.end_ts
    : rawStart
  const dayEndTs = dayStartTs + DAY_S
  const startTs = Math.max(dayStartTs, Math.min(dayEndTs, rawStart))
  return {
    event,
    startTs,
    endTs: Math.max(startTs, Math.min(dayEndTs, rawEnd)),
  }
}

function clusterEvents(events: DetectionEvent[], dayStartTs: number): EventCluster[] {
  const timeline = events
    .filter((event) => {
      const startTs = typeof event.start_ts === 'number' && Number.isFinite(event.start_ts)
        ? event.start_ts
        : event.ts
      return startTs >= dayStartTs && startTs < dayStartTs + DAY_S
    })
    .map((event) => eventBounds(event, dayStartTs))
    .sort((a, b) => a.startTs - b.startTs)
  const clusters: EventCluster[] = []

  for (const item of timeline) {
    const current = clusters[clusters.length - 1]
    if (
      current
      && item.startTs - current.endTs <= CLUSTER_GAP_S
      && item.startTs - current.startTs <= CLUSTER_MAX_SPAN_S
    ) {
      current.events.push(item)
      current.endTs = Math.max(current.endTs, item.endTs, item.startTs)
      const winner = current.events.reduce((best, candidate) => {
        const bestRank = _KIND_RANK[identityOf(best.event).kind]
        const candidateRank = _KIND_RANK[identityOf(candidate.event).kind]
        return candidateRank > bestRank ? candidate : best
      })
      current.color = identityOf(winner.event).colorVar
      continue
    }

    const identity = identityOf(item.event)
    clusters.push({
      id: item.event.id,
      events: [item],
      startTs: item.startTs,
      endTs: item.endTs,
      color: identity.colorVar,
    })
  }
  return clusters
}

function pct(ts: number, dayStartTs: number): number {
  return Math.max(0, Math.min(100, ((ts - dayStartTs) / DAY_S) * 100))
}

function rangeLabel(cluster: EventCluster): string {
  const first = cluster.events[0].event
  const last = cluster.events[cluster.events.length - 1].event
  if (cluster.events.length === 1) return clockTime(first.ts)
  return `${clockTime(first.ts)}–${clockTime(last.ts)}`
}

function videoStatusLabel(event: DetectionEvent): string {
  switch (event.video_status) {
    case 'available': return 'video available'
    case 'recording': return 'recording video'
    case 'finalizing': return 'video processing'
    case 'failed': return 'video unavailable'
    default: return 'video status unknown'
  }
}

export function HourBand({
  events,
  dayStartTs,
  onSelectEvent,
  nowTs,
}: {
  events: DetectionEvent[]
  dayStartTs: number
  onSelectEvent?: (event: DetectionEvent) => void
  nowTs?: number
}) {
  const liveNowMs = useTicker(30_000)
  const effectiveNowTs = nowTs ?? liveNowMs / 1000
  const clusters = useMemo(() => clusterEvents(events, dayStartTs), [events, dayStartTs])
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null)
  const expandedCluster = clusters.find((cluster) => cluster.id === expandedClusterId) ?? null
  const eventCount = clusters.reduce((total, cluster) => total + cluster.events.length, 0)
  const nowInDay = effectiveNowTs >= dayStartTs && effectiveNowTs < dayStartTs + DAY_S
  const nowPercent = pct(effectiveNowTs, dayStartTs)
  const summary = clusters.length === 0
    ? 'Today timeline: no recorded events so far.'
    : `Today timeline: ${eventCount} recorded ${eventCount === 1 ? 'event' : 'events'} in ${clusters.length} ${clusters.length === 1 ? 'period' : 'periods'}.`

  const activateCluster = (cluster: EventCluster) => {
    if (cluster.events.length === 1 && onSelectEvent) {
      onSelectEvent(cluster.events[0].event)
      return
    }
    setExpandedClusterId((current) => current === cluster.id ? null : cluster.id)
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs text-[var(--color-text-secondary)]">
          Events at their exact time
        </span>
        {nowInDay ? (
          <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--color-brass-default)]">
            Now · {clockTime(effectiveNowTs)}
          </span>
        ) : null}
      </div>

      <div
        role="group"
        aria-label={summary}
        className="relative"
        data-testid="day-activity-ruler"
      >
        <div className="relative h-12 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          {nowInDay ? (
            <div
              aria-hidden="true"
              className="absolute inset-y-0 right-0 bg-[var(--color-surface-muted)]/75"
              style={{ width: `${100 - nowPercent}%` }}
            />
          ) : null}
          {[0, 25, 50, 75, 100].map((position) => (
            <span
              key={position}
              aria-hidden="true"
              className="absolute inset-y-0 w-px bg-[var(--color-border-subtle)]"
              style={{ left: `${position}%` }}
            />
          ))}
          {clusters.map((cluster) => {
            const startPercent = pct(cluster.startTs, dayStartTs)
            const endPercent = pct(cluster.endTs, dayStartTs)
            const durationWidth = endPercent - startPercent
            const markerPercent = durationWidth > 0
              ? startPercent + durationWidth / 2
              : startPercent
            const count = cluster.events.length
            const label = count === 1
              ? `${clockTime(cluster.events[0].event.ts)}, ${eventTitle(cluster.events[0].event)}, ${videoStatusLabel(cluster.events[0].event)}`
              : `${count} events from ${rangeLabel(cluster)}`
            return (
              <span key={cluster.id}>
                <span
                  aria-hidden="true"
                  className="absolute inset-y-2 z-[1] min-w-[3px] rounded-sm opacity-85"
                  style={{
                    background: cluster.color,
                    left: `${startPercent}%`,
                    width: durationWidth > 0 ? `${durationWidth}%` : '4px',
                    transform: durationWidth > 0 ? undefined : 'translateX(-50%)',
                  }}
                  data-testid="timeline-marker-fill"
                />
                <button
                  type="button"
                  aria-label={label}
                  aria-expanded={count > 1 ? expandedClusterId === cluster.id : undefined}
                  onClick={() => activateCluster(cluster)}
                  className="absolute inset-y-0 z-[2] min-w-8 -translate-x-1/2 rounded-md bg-transparent focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-[-2px]"
                  style={{ left: `${markerPercent}%` }}
                  data-testid="timeline-marker"
                />
              </span>
            )
          })}

          {nowInDay ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-[3] w-px bg-[var(--color-brass-default)]"
              style={{ left: `${nowPercent}%` }}
              data-testid="now-cursor"
            >
              <span className="absolute -left-1 -top-px h-2 w-2 rounded-full bg-[var(--color-brass-default)]" />
            </span>
          ) : null}
        </div>

        <div aria-hidden="true" className="relative mt-1 h-4 text-[10px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
          {_AXIS_LABELS.map(([label, position], index) => (
            <span
              key={`${label}-${position}`}
              className="absolute whitespace-nowrap"
              style={{
                left: `${position}%`,
                transform: index === 0 ? undefined : index === 4 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {expandedCluster ? (
        <div
          role="region"
          aria-label={`${expandedCluster.events.length} events from ${rangeLabel(expandedCluster)}`}
          className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-2"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">
              {rangeLabel(expandedCluster)}
            </span>
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              {expandedCluster.events.length} events
            </span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {expandedCluster.events.map(({ event }) => (
              <button
                key={event.id}
                type="button"
                onClick={() => onSelectEvent?.(event)}
                className="min-h-11 shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
              >
                <span className="block text-xs font-semibold tabular-nums text-[var(--color-text-primary)]">
                  {clockTime(event.ts)}
                </span>
                <span className="block max-w-28 truncate text-[10px] text-[var(--color-text-secondary)]">
                  {eventTitle(event)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)]">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--color-id-person)]" />
          People
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--color-id-mushu)]" />
          Cats
        </span>
        <span className="text-[10px] text-[var(--color-text-tertiary)]">
          Empty space = no recorded event
        </span>
      </div>
    </div>
  )
}
