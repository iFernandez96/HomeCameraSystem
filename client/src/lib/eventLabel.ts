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
 * ("person · cam1").
 *
 * iter-357 (multi-person face-recog): when multiple known faces
 * matched the event, the title fans out as
 *   - 2 names → "Israel & Sheenal at the front door"
 *   - 3 names → "Israel, Sheenal & Coco at the front door"
 *   - 4+ names → "Israel, Sheenal & 2 others at the front door"
 * The single-person + unmatched-person paths are unchanged. The
 * Oxford-comma + ampersand reads like a household sentence, not
 * a CSV row, which is the same Frank-test bar we set at iter-22. */
export function eventTitle(e: DetectionEvent): string {
  const where = humanCameraName(e.camera_id)
  const names = recognizedNames(e)
  if (names.length === 1) {
    return `${capitalize(names[0])} at ${where}`
  }
  if (names.length === 2) {
    return `${capitalize(names[0])} & ${capitalize(names[1])} at ${where}`
  }
  if (names.length === 3) {
    return `${capitalize(names[0])}, ${capitalize(names[1])} & ${capitalize(names[2])} at ${where}`
  }
  if (names.length >= 4) {
    const others = names.length - 2
    return `${capitalize(names[0])}, ${capitalize(names[1])} & ${others} others at ${where}`
  }
  const what = capitalize(e.label)
  return `${what} at ${where}`
}

/** iter-357: normalize the iter-22 `person_name` + iter-357
 * `person_names` fields to a single string[] so consumers don't
 * have to handle three states (legacy field only, new field only,
 * both). Returns the new field when present, falls back to a
 * single-element list from the legacy field, else empty. The
 * server-side Pydantic invariant guarantees `person_names[0] ===
 * person_name` when both are set, so deduping isn't needed
 * here. */
export function recognizedNames(e: DetectionEvent): string[] {
  if (e.person_names && e.person_names.length > 0) {
    return e.person_names
  }
  if (e.person_name) {
    return [e.person_name]
  }
  return []
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
