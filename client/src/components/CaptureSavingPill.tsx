import { useEffect, useState } from 'react'
import { getDetectionConfig } from '../lib/api'

/**
 * iter-356.C (mobile redesign Slice C — security clarity):
 * Plain-language signal that face captures are being persisted for
 * training. Renders next to the ArmedBadge / RecordingIndicator on
 * Live. Visible to ALL roles — household members deserve to know
 * when their faces are being saved, regardless of whether they can
 * change the setting (only owners can PATCH /detection/config).
 *
 * Source of truth: GET /api/detection/config → face_capture_enabled.
 * The route only requires auth (not owner role), so family/viewer
 * can read it; PATCH stays owner-gated server-side.
 *
 * No render unless the flag is explicitly true. While the fetch is
 * in flight or it 4xx's (anon, network), the pill stays silent — the
 * default-off failure mode is correct here (don't claim we are
 * saving faces when we are not sure).
 */
export function CaptureSavingPill() {
  const [enabled, setEnabled] = useState<boolean>(false)

  // React 19 react-hooks/set-state-in-effect: setState only inside
  // .then with a `cancelled` guard.
  useEffect(() => {
    let cancelled = false
    getDetectionConfig()
      .then((c) => {
        if (cancelled) return
        setEnabled(c.face_capture_enabled === true)
      })
      .catch(() => {
        if (cancelled) return
        setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!enabled) return null

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full bg-black/55 backdrop-blur px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20"
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
