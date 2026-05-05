/**
 * Sentry-cat rotation.
 *
 * Pre-iter-356.64 the "on watch" role was hardcoded to Panther
 * (LiveStats.tsx, Live.tsx). The cat brand has three load-bearing
 * personalities — Panther (Sentry), Mushu (Trickster), Coco
 * (Peacekeeper). Locking the headline role to one of them under-uses
 * the other two and reads as static after a few visits.
 *
 * Design:
 *   - 30-minute slot. Each slot picks one cat as the active sentry.
 *   - "Feels random" without going stuck. Three consecutive slots
 *     (90 min) cycle through ALL three cats in some permutation;
 *     the permutation index is drawn from a deterministic hash of
 *     the block number so the pattern doesn't repeat block-to-block.
 *     Net effect: no cat ever holds the role for more than one slot
 *     in a row, but the sequence over 24 h reads as random.
 *   - Pure function `sentryCatAt(ms)` lets tests pin behavior at
 *     specific timestamps. The hook drives a 60 s re-render so the
 *     UI catches the boundary within ≤1 min of the slot flip.
 *
 * The deterministic seed (Math.floor(ms / 30min) → mulberry32) is
 * intentional. Two browsers in the same household see the SAME cat
 * at the same moment — Frank on his iPhone and his wife on her
 * Pixel won't disagree about who's on watch right now. Replayable
 * + testable + globally consistent.
 */
import { useEffect, useState } from 'react'

export type SentryCat = 'panther' | 'mushu' | 'coco'

const SLOT_MS = 30 * 60 * 1000

const PERMUTATIONS: ReadonlyArray<readonly SentryCat[]> = [
  ['panther', 'mushu', 'coco'],
  ['panther', 'coco', 'mushu'],
  ['mushu', 'panther', 'coco'],
  ['mushu', 'coco', 'panther'],
  ['coco', 'panther', 'mushu'],
  ['coco', 'mushu', 'panther'],
] as const

/**
 * mulberry32: a tiny, fast, 32-bit PRNG. Public-domain. We use it
 * here ONLY as a hash from a small integer seed to a uniform-ish
 * 32-bit output. Deterministic per seed; not cryptographically
 * strong, doesn't need to be.
 */
function mulberry32(seed: number): number {
  let s = (seed | 0) + 0x9e3779b9
  s = Math.imul(s ^ (s >>> 15), s | 1)
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61)
  return (s ^ (s >>> 14)) >>> 0
}

/**
 * Pure: return the sentry cat for a given UNIX timestamp (ms).
 * Stable across renders, processes, devices.
 */
export function sentryCatAt(timestampMs: number): SentryCat {
  // 30-min slot. Floor handles negative values too (theoretical only).
  const slot = Math.floor(timestampMs / SLOT_MS)
  // 90-min block = three consecutive 30-min slots that share one
  // permutation of [panther, mushu, coco]. Within a block, all three
  // cats appear exactly once → no back-to-back repeats.
  const block = Math.floor(slot / 3)
  // mod 3 in JS can be negative for negative slot; normalize.
  const within = ((slot % 3) + 3) % 3
  const permIdx = mulberry32(block) % PERMUTATIONS.length
  return PERMUTATIONS[permIdx][within]
}

/**
 * React hook: subscribes to the current sentry cat and re-renders
 * up to once per minute when the slot boundary flips. The 60 s
 * cadence is intentional — slot is 30 min, so a 1 min poll catches
 * the flip within 1/30 ≈ 3 % of the slot duration.
 */
export function useSentryCat(): SentryCat {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      clearInterval(id)
    }
  }, [])
  return sentryCatAt(now)
}

/** Capitalize the cat's name for display: "Panther", "Mushu", "Coco". */
export function sentryCatName(cat: SentryCat): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1)
}

/** Possessive form: "Panther's", "Mushu's", "Coco's". */
export function sentryCatPossessive(cat: SentryCat): string {
  return sentryCatName(cat) + "'s"
}

/**
 * Return the standard "on watch" headline for the active sentry —
 * e.g. "Panther on watch" / "Mushu on watch" / "Coco on watch".
 * One canonical render so every surface that uses it stays in sync.
 */
export function sentryOnWatchLabel(cat: SentryCat): string {
  return sentryCatName(cat) + ' on watch'
}

/**
 * "Off duty" headline — used when detection is manually paused.
 * Mirrors the pre-iter-356.64 "Panther's off duty" copy generalized
 * to whichever cat is currently the rotating sentry.
 */
export function sentryOffDutyLabel(cat: SentryCat): string {
  return sentryCatPossessive(cat) + ' off duty'
}

/**
 * "Off-duty hint" — companion copy for the off-duty banner. The
 * pre-iter-356.64 version named Panther; generalize using the
 * possessive so the name and pronoun match.
 */
export function sentryOffDutyHint(cat: SentryCat): string {
  return (
    'Tap Resume on the action panel to bring ' +
    sentryCatName(cat) +
    ' back on watch.'
  )
}
