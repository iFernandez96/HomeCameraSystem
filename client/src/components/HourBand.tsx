import type { DetectionEvent } from '../lib/types'
import { identityOf, type IdentityKind } from '../lib/identity'

/**
 * HourBand — 24-cell hour-by-hour identity timeline (Playroom Modern,
 * Task 6). Each cell is colored by the identity of the FIRST event
 * that lands in that hour, bucketed from `dayStartTs` (local midnight
 * for "today"). When a person and a cat both appear in the same hour,
 * the person wins the cell — a person sighting is the higher-signal
 * event. Empty hours render as the neutral raised-surface tone.
 */
const _KIND_RANK: Record<IdentityKind, number> = {
  'named-person': 3,
  person: 3,
  cat: 2,
  other: 1,
}

/** Word used in the aria sentence for whoever won a cell. */
function _kindWord(kind: IdentityKind, name: string | null): string {
  if (name) return name
  if (kind === 'person') return 'person'
  if (kind === 'cat') return 'cat'
  return 'something else'
}

/** "8 AM", "2 PM", "12 AM" (midnight), "12 PM" (noon). */
function _hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12} ${hour < 12 ? 'AM' : 'PM'}`
}

/** Density steps — a lone sighting reads lighter than a busy hour,
 * while the identity hue stays the same. */
function _opacityFor(count: number): number {
  if (count >= 4) return 1
  if (count >= 2) return 0.8
  return 0.55
}

export function HourBand({
  events,
  dayStartTs,
}: {
  events: DetectionEvent[]
  dayStartTs: number
}) {
  const cellColors: (string | null)[] = Array(24).fill(null)
  const cellRank: number[] = Array(24).fill(0)
  const cellWord: (string | null)[] = Array(24).fill(null)
  const cellCount: number[] = Array(24).fill(0)
  // Final whole-branch review fix batch #7: which ts currently "owns"
  // each cell, so an equal-rank event can be compared against it.
  const cellTs: (number | null)[] = Array(24).fill(null)
  for (const e of events) {
    const hour = Math.floor((e.ts - dayStartTs) / 3600)
    if (hour < 0 || hour > 23) continue
    cellCount[hour] += 1
    const identity = identityOf(e)
    const rank = _KIND_RANK[identity.kind]
    // A higher rank always wins outright. On a rank TIE, prefer the
    // EARLIEST ts — `events` arrives newest-first, so a naive "keep
    // the first event seen" rule (the old `>` -only comparison)
    // actually kept the NEWEST of a tie, contradicting "first event
    // of the hour" wins. Comparing ts directly is order-independent.
    const isNewWinner =
      rank > cellRank[hour] ||
      (rank === cellRank[hour] &&
        cellRank[hour] > 0 &&
        cellTs[hour] != null &&
        e.ts < cellTs[hour])
    if (isNewWinner) {
      cellRank[hour] = rank
      cellColors[hour] = identity.colorVar
      cellWord[hour] = _kindWord(identity.kind, identity.name)
      cellTs[hour] = e.ts
    }
  }

  const activeHours = cellColors.filter((c) => c !== null).length
  const quietHours = 24 - activeHours
  // Accessible sentence names each ACTIVE hour so a screen-reader user
  // gets the same "who, when" story a sighted user reads off the
  // colored band — not just an aggregate count.
  const activeParts = cellColors
    .map((color, hour) =>
      color === null
        ? null
        : `${_hourLabel(hour)} ${cellWord[hour]}${cellCount[hour] > 1 ? ` (x${cellCount[hour]})` : ''}`,
    )
    .filter((p): p is string => p !== null)
  const ariaLabel =
    activeHours === 0
      ? 'Today hour by hour: quiet so far, no activity.'
      : `Today hour by hour: ${activeParts.join(', ')}${quietHours > 0 ? ', rest quiet' : ''}.`

  return (
    <div>
      <div role="img" aria-label={ariaLabel} className="grid grid-cols-[repeat(24,1fr)] gap-[3px]">
        {cellColors.map((color, hour) => (
          <div
            key={hour}
            data-hour={hour}
            className="h-8 rounded-[5px]"
            style={{
              background: color ?? 'var(--color-surface-raised)',
              opacity: color ? _opacityFor(cellCount[hour]) : 1,
            }}
          />
        ))}
      </div>
      {/* Legend — color alone never carries meaning; the words do the
          talking, the dots are purely decorative. */}
      <div className="flex items-center gap-3 mt-2 text-xs text-[var(--color-text-secondary)]">
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--color-id-person)' }}
          />
          People
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--color-id-mushu)' }}
          />
          Cats
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: 'var(--color-surface-raised)' }}
          />
          Quiet
        </span>
      </div>
    </div>
  )
}
