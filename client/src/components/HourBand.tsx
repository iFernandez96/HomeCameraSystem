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

export function HourBand({
  events,
  dayStartTs,
}: {
  events: DetectionEvent[]
  dayStartTs: number
}) {
  const cellColors: (string | null)[] = Array(24).fill(null)
  const cellRank: number[] = Array(24).fill(0)
  for (const e of events) {
    const hour = Math.floor((e.ts - dayStartTs) / 3600)
    if (hour < 0 || hour > 23) continue
    const identity = identityOf(e)
    const rank = _KIND_RANK[identity.kind]
    // Strictly greater than — ties keep the FIRST event's color (the
    // rank comparison is what lets a later, higher-ranked event in
    // the same hour override an earlier lower-ranked one).
    if (rank > cellRank[hour]) {
      cellRank[hour] = rank
      cellColors[hour] = identity.colorVar
    }
  }

  const activeHours = cellColors.filter((c) => c !== null).length
  const quietHours = 24 - activeHours
  const ariaLabel = `Today hour by hour: ${quietHours} quiet hour${
    quietHours === 1 ? '' : 's'
  }, ${activeHours} with activity`

  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="grid grid-cols-[repeat(24,1fr)] gap-[3px]">
        {cellColors.map((color, hour) => (
          <div
            key={hour}
            data-hour={hour}
            className="h-6 rounded-[5px]"
            style={{ background: color ?? 'var(--color-surface-raised)' }}
          />
        ))}
      </div>
    </div>
  )
}
