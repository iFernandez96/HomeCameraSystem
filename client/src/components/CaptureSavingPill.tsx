import { useFaceCaptureEnabled } from '../lib/useFaceCaptureEnabled'

/**
 * iter-356.C (mobile redesign Slice C — security clarity):
 * Plain-language signal that face captures are being persisted for
 * training. Renders next to the ArmedBadge / RecordingIndicator on
 * Live. Visible to ALL roles — household members deserve to know
 * when their faces are being saved, regardless of whether they can
 * change the setting (only owners can PATCH /detection/config).
 *
 * iter-356.66 (perfection sweep): fetch hoisted to
 * `useFaceCaptureEnabled` so the People banner can share the same
 * signal without duplicating the network call.
 *
 * No render unless the flag is explicitly `true`. While the fetch
 * is in flight or it 4xx's (anon, network), the pill stays silent —
 * the default-quiet failure mode is correct here (don't claim we
 * are saving faces when we are not sure).
 */
export function CaptureSavingPill() {
  const enabled = useFaceCaptureEnabled()

  if (enabled !== true) return null

  return (
    // Sunroom redesign (2026-07-01): shared over-video pill treatment
    // (black/60 scrim + white/20 ring) matching the trust cluster.
    <span
      className="inline-flex items-center gap-2 rounded-full bg-black/60 backdrop-blur px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20"
      aria-label="Saving faces for training"
    >
      <CameraDiskIcon />
      Saving faces for training
    </span>
  )
}

/**
 * Camera + disk pictogram — a camera body with a small disk badge in
 * its lower-right corner. Says "this lens captures and stores"
 * without leaning on color or copy alone.
 */
function CameraDiskIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Camera body */}
      <path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5" />
      {/* Lens */}
      <circle cx="12" cy="12" r="3" />
      {/* Disk badge — bottom-left corner spool */}
      <circle cx="6" cy="18" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
