import { useEffect, useState } from 'react'
import { getDetectionConfig } from './api'

/**
 * iter-356.66 (mobile-redesign perfection sweep): shared accessor for
 * the household-trust signal `face_capture_enabled`. Live's
 * `CaptureSavingPill` and People's banner both need to know whether
 * face crops are being saved for retraining. Folding the fetch
 * behind one hook avoids duplicate network calls on a session and
 * keeps the failure-mode contract identical across surfaces:
 *
 *   - `null`  → unknown (still fetching, or fetch failed). Render
 *               NOTHING; never claim a state we are unsure of.
 *   - `true`  → face captures saving is enabled. Show the pill /
 *               banner so household members see the trust signal.
 *   - `false` → explicitly off; no pill / banner.
 *
 * React 19 `react-hooks/set-state-in-effect`: the setState lives
 * inside `.then` / `.catch` with a `cancelled` guard, per the
 * CLAUDE.md sharp edge.
 */
export function useFaceCaptureEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    getDetectionConfig()
      .then((c) => {
        if (cancelled) return
        setEnabled(c.face_capture_enabled === true)
      })
      .catch(() => {
        if (cancelled) return
        // `null` (not `false`) so consumers can distinguish "we
        // looked and it's off" from "we couldn't look." Both
        // currently render nothing, but a future surface might
        // want to show "Captures status unavailable" on the
        // failed branch.
        setEnabled(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  return enabled
}
