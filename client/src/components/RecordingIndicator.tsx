import type { ServerStatus } from '../lib/types'

/**
 * iter-356.C (mobile redesign Slice C — security clarity):
 * Honest "we are recording right now" signal that lives next to the
 * ArmedBadge on the Live page. Pre-iter-356.C the only on-screen
 * cue that the camera was capturing video to disk was the indirect
 * "Armed" badge — but armed simply means detection is on, not that
 * a clip is being persisted. Per CLAUDE.md the segment-recorder runs
 * a continuous pre-roll ring whenever the worker is alive AND
 * detection is active, so that's the truth this pill pins.
 *
 * Render gate: worker_alive === true AND detection_active === true.
 * Either flag false (or null/unknown) → no pill. We deliberately
 * stay silent during the indeterminate "connecting…" window — a
 * false-positive REC dot would erode the trust the pill exists to
 * build.
 *
 * Visible to ALL roles. The whole point is that any household member
 * can glance at the Live page and see the camera is recording.
 */
export function RecordingIndicator({
  status,
}: {
  status: ServerStatus | null
}) {
  if (!status) return null
  const recording =
    status.worker_alive === true && status.detection_active === true
  if (!recording) return null
  return (
    // Sunroom redesign (2026-07-01): shared over-video pill treatment
    // (black/60 scrim + white/20 ring); the REC dot uses danger-strong
    // so it stays vivid over video (brick danger is tuned for paper).
    <span
      className="inline-flex items-center gap-2 rounded-full bg-black/60 backdrop-blur px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20"
      aria-label="Recording"
    >
      <span
        aria-hidden="true"
        className="w-2 h-2 rounded-full bg-[var(--color-danger-strong)] animate-[pulse_2s_ease-in-out_infinite]"
      />
      Recording
    </span>
  )
}
