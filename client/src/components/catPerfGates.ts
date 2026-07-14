import { useEffect, useState } from 'react'

// Playground Slice A: perf-gate hooks extracted VERBATIM from
// CatLayer.tsx so the Playground page (and any future ambient
// surface) shares the exact same reduced-motion / reduced-data /
// battery gating. CatLayer imports these back — behavior unchanged,
// CatLayer.test.tsx is the regression pin.

// === Reduced-motion preference hook =========================================

export function usePrefersReducedMotion(): boolean {
  // iter-356.4-cats: lazy-init from matchMedia AT MOUNT (avoids the
  // react-hooks/set-state-in-effect lint trap — synchronous setReduced
  // inside useEffect is what the rule rejects).
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// iter-356-E (Slice E): mirror of usePrefersReducedMotion for the
// `prefers-reduced-data: reduce` media query. Same lazy-init + change-
// listener pattern so the lint rule (no setState in useEffect body) is
// honored. Browsers without the query (most as of 2026) report `false`
// at construction — the user opts in via a known browser flag or OS-
// level data-saver, so missing support === "no preference set."
export function usePrefersReducedData(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-data: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-data: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// iter-356-E (Slice E): best-effort Battery Status API gate. Returns
// `true` when battery level < 20% AND the device is not charging.
// Wrapped in try/catch + feature detect because the API is unevenly
// shipped (Chromium yes, Safari no, Firefox removed). React 19 lint
// rule (no setState in useEffect body) is honored via a `cancelled`
// flag in the .then() — same pattern as the AuthProvider /me fetch.
type BatteryManagerLike = {
  level: number
  charging: boolean
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}
export function useBatteryLow(): boolean {
  const [low, setLow] = useState(false)
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<BatteryManagerLike>
    }
    if (typeof nav.getBattery !== 'function') return
    let cancelled = false
    let battery: BatteryManagerLike | null = null
    const evaluate = (b: BatteryManagerLike) => {
      // < 20% AND not charging — plugging in cancels the gate even if
      // the cell is at 5%, which matches the "save what's left" intent.
      const isLow = b.level < 0.2 && !b.charging
      if (!cancelled) setLow(isLow)
    }
    try {
      nav
        .getBattery()
        .then((b) => {
          if (cancelled) return
          battery = b
          evaluate(b)
          const onChange = () => {
            if (battery) evaluate(battery)
          }
          b.addEventListener('levelchange', onChange)
          b.addEventListener('chargingchange', onChange)
          // Stash the listener on the battery object via a closure so
          // cleanup can reach it. Returning early-cleanup from a
          // .then() isn't possible — instead the outer useEffect
          // returns a cleanup that flips `cancelled` AND tears down
          // the listeners by re-binding via `battery` ref capture.
          ;(battery as BatteryManagerLike & { __homecamCleanup?: () => void }).__homecamCleanup = () => {
            b.removeEventListener('levelchange', onChange)
            b.removeEventListener('chargingchange', onChange)
          }
        })
        .catch(() => {
          // getBattery() can reject in privacy-restricted contexts
          // (some Chromium policies block it). Treat as "no signal."
          if (!cancelled) setLow(false)
        })
    } catch {
      // Synchronous throw from a non-conforming polyfill; default
      // initial state is already `false` so no setState is needed
      // (and the React 19 lint rule rejects sync setState here).
    }
    return () => {
      cancelled = true
      const b = battery as
        | (BatteryManagerLike & { __homecamCleanup?: () => void })
        | null
      if (b && typeof b.__homecamCleanup === 'function') {
        b.__homecamCleanup()
      }
    }
  }, [])
  return low
}
