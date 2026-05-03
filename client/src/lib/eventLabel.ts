import type { DetectionEvent } from './types'

/**
 * iter-356.17 — shared event-label helpers, extracted from
 * EventList.tsx. ClipModal and SnapshotPreview now consume the
 * same `eventTitle()` so the modal header matches the card title
 * the user just tapped (Maya 11th CRITICAL #1 — the modal had
 * zero context, header bar restores parity).
 */

export function relativeTime(ts: number, nowMs: number): string {
  const seconds = Math.floor((nowMs - ts * 1000) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  const d = new Date(ts * 1000)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function clockTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function absoluteTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString()
}

/** Plain-English description of what the camera saw. Reads like a
 * notification headline, not a CSV row. Frank-test: mentions a real
 * thing ("Person at the front door") instead of internal naming
 * ("person · cam1"). */
export function eventTitle(e: DetectionEvent): string {
  const where = humanCameraName(e.camera_id)
  if (e.person_name) {
    return `${capitalize(e.person_name)} at ${where}`
  }
  const what = capitalize(e.label)
  return `${what} at ${where}`
}

/** Translate the internal camera_id to a friendlier label.
 * `cam1` → "the front door" by convention (single-camera default).
 * Multi-cam deploys can map ids to names in a future iter. */
export function humanCameraName(cameraId: string): string {
  if (cameraId === 'cam1') return 'the front door'
  return cameraId
}

export function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}
