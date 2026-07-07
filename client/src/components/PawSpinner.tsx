/**
 * Playroom Modern brand loading spinner. Replaces the iter-356.35
 * paw-print glyph with three WhoMark geometric marks — the same
 * rounded-square + triangle-ear language used for cat avatars — in
 * the brand trio hues (Panther / Mushu / Coco). They bounce in
 * sequence (left -> right) so the motion still reads as "someone's
 * walking past," just drawn in the current brand shape instead of a
 * literal paw print.
 *
 * Reduced-motion: the bounce keyframe's duration is clamped to
 * 0.01ms by the global `prefers-reduced-motion: reduce` rule in
 * index.css (applies to every animation on the page), which leaves
 * the marks resting at their final keyframe state — full opacity,
 * no vertical offset. The ARIA role=status still announces "Loading"
 * so screen-reader UX is unchanged either way.
 */

import { WhoMark } from './WhoMark'
import { BRAND_CATS } from '../lib/identity'

export function PawSpinner({
  size = 14,
  ariaLabel = 'Loading',
  className,
}: {
  size?: number
  ariaLabel?: string
  className?: string
}) {
  return (
    <div
      className={`inline-flex items-center gap-1.5 ${className ?? ''}`}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
    >
      {BRAND_CATS.map((cat, i) => (
        <span
          key={cat.name}
          aria-hidden="true"
          className="brand-spinner-dot inline-flex"
          style={{ animationDelay: `${i * 0.2}s` }}
        >
          <WhoMark
            size={size}
            identity={{ kind: 'cat', name: null, colorVar: cat.colorVar, softVar: '' }}
          />
        </span>
      ))}
    </div>
  )
}
