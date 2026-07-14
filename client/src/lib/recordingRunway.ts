export const ASSUMED_GB_PER_DAY = 8

export type RecordingRunway = {
  daysLeft: number | null
  basis: 'measured-rate' | 'assumed-rate'
}

export function estimateDaysLeft(
  freeGb: number | null | undefined,
  measuredGbPerDay?: number | null,
): RecordingRunway {
  const hasMeasuredRate = measuredGbPerDay != null && measuredGbPerDay > 0
  const gbPerDay = hasMeasuredRate ? measuredGbPerDay : ASSUMED_GB_PER_DAY
  const basis = hasMeasuredRate ? 'measured-rate' : 'assumed-rate'
  if (freeGb == null) {
    return { daysLeft: null, basis }
  }
  return { daysLeft: freeGb / gbPerDay, basis }
}
