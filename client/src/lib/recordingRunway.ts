export const ASSUMED_GB_PER_DAY = 8

export type RecordingRunway = {
  daysLeft: number | null
  basis: 'assumed-rate'
}

export function estimateDaysLeft(
  freeGb: number | null | undefined,
  gbPerDay = ASSUMED_GB_PER_DAY,
): RecordingRunway {
  if (freeGb == null || gbPerDay <= 0) {
    return { daysLeft: null, basis: 'assumed-rate' }
  }
  return { daysLeft: freeGb / gbPerDay, basis: 'assumed-rate' }
}
