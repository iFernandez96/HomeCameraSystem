/**
 * iter-356.35 — paw-print loading spinner. Replaces the generic ring
 * spinner used in `App.tsx::PageFallback` and other ad-hoc loading
 * surfaces. Three paw glyphs fade in sequentially (left → right) so
 * the motion reads as "cat walking past" instead of a mechanical
 * carousel — on brand with the rest of the cat theme.
 *
 * Reduced-motion: the 1.2s fade animation is gated on the
 * `prefers-reduced-motion: no-preference` media query in `index.css`
 * (the same gate the cats + skeletons use). Under reduced-motion all
 * three paws render at full opacity; the ARIA role=status still
 * announces "Loading" so screen-reader UX is unchanged.
 */

import { PawMark } from './CatIcons'

export function PawSpinner({
  size = 16,
  ariaLabel = 'Loading',
  className,
}: {
  size?: number
  ariaLabel?: string
  className?: string
}) {
  return (
    <div
      className={`paw-spinner inline-flex items-center gap-1.5 ${className ?? ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
    >
      <PawMark size={size} className="paw-spinner-dot paw-spinner-dot-1 text-[var(--color-accent-default)]" />
      <PawMark size={size} className="paw-spinner-dot paw-spinner-dot-2 text-[var(--color-accent-default)]" />
      <PawMark size={size} className="paw-spinner-dot paw-spinner-dot-3 text-[var(--color-accent-default)]" />
    </div>
  )
}
