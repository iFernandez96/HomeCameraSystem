/**
 * watchState — the ONE armed-state vocabulary for the whole app
 * (UI/UX overhaul 2026-07-07, W1 item 2 / polish blocker #1).
 *
 * Before this module, three surfaces each recomputed the same truth
 * with three different word sets: WatchRibbon said "On watch",
 * Watch's glance card said "Watching", and VideoTile's pill said
 * "Live" — all potentially visible at once on one screen. A security
 * console must say the same word everywhere, so the ribbon and the
 * glance card now share this label map and dot/text color map.
 *
 * Deliberately NOT adopted by VideoTile's StatusPill: that pill is
 * stream-truth ("Live" / "Connecting" / "Offline" = is video actually
 * flowing over WebRTC), a different channel from the detection-armed
 * state this module names. Collapsing them would reintroduce the
 * status-truth contradiction fixed 2026-07-07 (API says down, video
 * visibly streaming).
 *
 * Pure decision logic, stdlib-only, unit-tested offline
 * (watchState.test.ts) — CLAUDE.md engineering principle #2.
 */

export type WatchStateKind =
  | 'offline'
  | 'detection-unavailable'
  | 'armed'
  | 'reconnecting'
  | 'off-duty'
  | 'checking'

export interface WatchStateInput {
  /** Is /api/status reachable (status object non-null)? */
  statusKnown: boolean
  /** status.worker_alive — null when unknown / status not loaded. */
  workerAlive: boolean | null
  /** status.detection_active — null when unknown. */
  detectionActive: boolean | null
  /** Detector has not decoded a frame for the stale threshold. */
  detectionFramesStale?: boolean
  /**
   * Independent video-truth channel (Watch's VideoTile
   * onPlayingChange): true = frames confirmed flowing, false = WHEP
   * path confirmed dead, null/omitted = not resolved yet. Callers
   * without a video tile (WatchRibbon) simply omit it.
   */
  videoPlaying?: boolean | null
}

/**
 * Three-state truth model (status-truth fix, 2026-07-07):
 *  1. DETECTOR DOWN — the API is reachable and says only the detection
 *     worker is silent. This is a warning, not proof that video is down.
 *     If the independent video channel also confirms failure, the camera
 *     is offline.
 *  2. STATUS UNKNOWN — the API is unreachable. Video-confirmed
 *     playing -> low-alarm 'reconnecting'; video-confirmed dead ->
 *     both channels dark, treat as 'offline'; video unresolved ->
 *     neutral 'checking' (cold mount must not flash danger).
 *  3. HEALTHY — armed / off-duty from detection_active.
 */
export function watchStateOf(input: WatchStateInput): WatchStateKind {
  const { statusKnown, workerAlive, detectionActive } = input
  const videoPlaying = input.videoPlaying ?? null
  if (videoPlaying === false) return 'offline'
  if (
    statusKnown &&
    (workerAlive === false || input.detectionFramesStale === true)
  ) return 'detection-unavailable'
  if (statusKnown && detectionActive === true && workerAlive === true) {
    return 'armed'
  }
  if (!statusKnown && videoPlaying === true) return 'reconnecting'
  if (statusKnown && detectionActive === false) return 'off-duty'
  return 'checking'
}

/** The one user-facing name per state, everywhere it renders. */
export const WATCH_STATE_LABEL: Record<WatchStateKind, string> = {
  offline: 'Camera offline',
  'detection-unavailable': 'Detection unavailable',
  armed: 'On watch',
  reconnecting: 'Reconnecting…',
  'off-duty': 'Off duty',
  checking: 'Checking…',
}

/** Status-dot Tailwind classes, shared by ribbon + Watch overlays. */
export function watchStateDotClass(kind: WatchStateKind): string {
  switch (kind) {
    case 'offline':
      return 'bg-[var(--color-danger)]'
    case 'armed':
      return 'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]'
    case 'detection-unavailable':
      return 'bg-[var(--color-warning)]'
    case 'reconnecting':
      return 'bg-[var(--color-warning)] animate-pulse'
    case 'off-duty':
      return 'bg-[var(--color-warning)]'
    case 'checking':
      return 'bg-[var(--color-text-tertiary)]'
  }
}

/** Label text-color classes (WatchRibbon's colored state label). */
export function watchStateTextClass(kind: WatchStateKind): string {
  switch (kind) {
    case 'offline':
      return 'text-[var(--color-danger)]'
    case 'armed':
      return 'text-[var(--color-success)]'
    case 'reconnecting':
    case 'detection-unavailable':
    case 'off-duty':
      return 'text-[var(--color-warning)]'
    case 'checking':
      return 'text-[var(--color-text-tertiary)]'
  }
}
