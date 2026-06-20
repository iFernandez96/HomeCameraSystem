import type { TimelapseManifest, TimelapseSegment } from './api'

// Client analog of lib/drawBoxes.ts for the stitched timelapse: pure helpers
// that map the reel's playhead to the original wall-clock capture time, so
// TimelapsesSection can paint a small forward-ticking timestamp over the
// <video>. Kept pure (no DOM) so the mapping is unit-testable in isolation.

/**
 * True iff `m` is a sidecar we can drive an overlay from: schema v1 with at
 * least one segment. Older reels (built before the de-overlap feature) have
 * no sidecar at all — the caller hides the overlay rather than guess.
 */
export function isUsableManifest(
  m: TimelapseManifest | null | undefined,
): m is TimelapseManifest {
  return (
    !!m &&
    m.v === 1 &&
    Array.isArray(m.segments) &&
    m.segments.length > 0
  )
}

/**
 * Map a playhead position in the stitched reel (`currentTime`, seconds) to
 * the real wall-clock time (unix epoch seconds) of the footage on screen.
 *
 * The reel is a concat of forward-running segments; segment `i` starts at
 * `offset_s` in the reel and corresponds to capture time `capture_ts`. Within
 * a segment, reel time advances 1:1 with real time:
 *   real_ts = segment.capture_ts + (currentTime - segment.offset_s)
 *
 * Binary-searches the last segment whose `offset_s <= currentTime`. Returns
 * null when there are no segments, the input is non-finite, or currentTime
 * precedes the first segment — so the caller hides the overlay rather than
 * paint a bogus time.
 */
export function reelTimeToCaptureTs(
  segments: ReadonlyArray<TimelapseSegment>,
  currentTime: number,
): number | null {
  if (!segments.length || !Number.isFinite(currentTime) || currentTime < 0) {
    return null
  }
  // Last segment with offset_s <= currentTime (segments are offset-sorted by
  // the server). Binary search so a long day's manifest stays cheap per frame.
  let lo = 0
  let hi = segments.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segments[mid].offset_s <= currentTime) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (idx < 0) return null
  const seg = segments[idx]
  const ts = seg.capture_ts + (currentTime - seg.offset_s)
  return Number.isFinite(ts) ? ts : null
}

/**
 * Format a unix-epoch-seconds instant as local `HH:MM:SS` for the corner
 * overlay. Local time matches the rest of the stack's localtime bucketing
 * (the operator sets container TZ).
 */
export function formatClock(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
