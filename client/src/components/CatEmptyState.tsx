import type { ReactNode } from 'react'
import { BombaySprite, CalicoSprite, SleepingCatIllustration, TuxedoSprite } from './CatIcons'
import { Button } from './primitives/Button'

/**
 * iter-356.23 (Maya #1 ranked + Priya pattern propagation):
 * a single primitive every "this surface is empty" state across the
 * app uses. Replaces the iter-356.22 one-off in EventList that Maya
 * flagged as cosmetic-theater ("you shipped the cat-pattern in ONE
 * place") and Priya flagged as "Events got a pet, People got a
 * shrug" pattern asymmetry.
 *
 * Design decisions baked in (auditor convergence):
 *
 * - **No surrounding card / gradient tile.** Maya Major #1 — framing
 *   a 56px sprite in a 128×80 box reads as a debug-mode image
 *   placeholder. Linear/Things/Cron all float their illustrations on
 *   the page background. The illustration IS the figure; no frame
 *   needed.
 *
 * - **Default illustration is `SleepingCatIllustration`** (96px) —
 *   the calico Coco curled with three opacity-stepped Z's drifting
 *   above. Frank's #1 fix: the iter-356.22 plain CalicoSprite (no
 *   z's) was ambiguous at 56px — "a small colored smear." The
 *   illustration variant has the z-z-z that turns the pixel blob
 *   into a sleeping cat at a glance.
 *
 * - **Caller can override `illustration`** for surfaces where Coco
 *   asleep is the wrong mood (a future "no recent activity" page
 *   wanting Mushu's sit pose, for example). Default covers the
 *   common case; opt-in for personality variation.
 *
 * - **Hint text is `text-sm`, not `text-xs`** — Frank's #3 fix.
 *   11px on the line that tells the user what to DO is hostile to
 *   anyone with normal aging vision; 13px is forgiving.
 *
 * - **Responsive vertical rhythm** — `py-10 lg:py-16` per Priya's
 *   mobile note that 64px top+bottom pushed the hint below the fold
 *   on iPhone SE-class devices.
 *
 * - **`max-w-md`** (28rem ≈ 448px) — wider than the iter-356.22
 *   `max-w-sm` so copy doesn't wrap awkwardly on desktop. Mobile
 *   path (320-414px viewport) collapses naturally.
 *
 * - **`role="status"` + `aria-label`** — load-bearing for screen
 *   readers transitioning into an empty list. Default aria-label is
 *   the heading itself; caller can override for a richer announcement
 *   (Events uses "All quiet — no events yet" so SR users get the
 *   mood phrase, not just "All quiet out there").
 */
/**
 * iter-356.56 (cat-brand integration, Maya brand-identity tier):
 * `mood` lets the page pick a cat that fits the empty-state context
 * instead of every empty surface showing the same sleeping calico.
 *
 * - `'calm'` (default) — Coco asleep with z-z-z's. Reads "all is well."
 *   Used by Events when there are no detections.
 * - `'curious'` — Mushu sitting forward. Reads "ready to learn."
 *   Used by People + Training where the user is meant to teach the
 *   camera.
 * - `'watching'` — Panther in profile. Reads "on duty."
 *   Used by Review when the camera has nothing pending but is still
 *   working.
 *
 * Each mood is still a single visible cat at the same 96 px size so
 * the spatial rhythm across pages stays consistent. Caller can still
 * pass a custom `illustration` for fully bespoke surfaces.
 */
export type EmptyStateMood = 'calm' | 'curious' | 'watching'

export interface CatEmptyStateProps {
  heading: string
  body: string
  hint?: string
  illustration?: ReactNode
  ariaLabel?: string
  mood?: EmptyStateMood
  /**
   * redesign/warm-boutique (Sunroom): optional CTA rendered through
   * the Button primitive (secondary — paper + hairline; an empty
   * state's action never competes with the page's single primary).
   * Copy tiering: heading (Inter semibold) → body (secondary) →
   * action. Callers with no action keep the text-only `hint` tier.
   */
  action?: { label: string; onClick: () => void }
}

function moodIllustration(mood: EmptyStateMood): ReactNode {
  if (mood === 'curious') {
    return <TuxedoSprite size={96} state="sit" />
  }
  if (mood === 'watching') {
    return <BombaySprite size={96} state="sit" />
  }
  return <SleepingCatIllustration size={96} />
}

export function CatEmptyState({
  heading,
  body,
  hint,
  illustration,
  ariaLabel,
  mood = 'calm',
  action,
}: CatEmptyStateProps) {
  const finalIllustration = illustration ?? moodIllustration(mood)
  return (
    <div
      className="text-center py-10 lg:py-16 px-6 space-y-4 max-w-md mx-auto"
      role="status"
      aria-label={ariaLabel ?? heading}
    >
      <div className="flex justify-center text-[var(--color-text-secondary)]">
        {finalIllustration}
      </div>
      <div className="space-y-1.5">
        <p className="text-lg font-semibold text-[var(--color-text-primary)]">
          {heading}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)]">{body}</p>
      </div>
      {hint && (
        <p className="text-sm text-[var(--color-text-tertiary)] pt-1">{hint}</p>
      )}
      {action && (
        <div className="flex justify-center pt-1">
          <Button variant="secondary" size="md" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  )
}

// Re-export so `CalicoSprite` import doesn't show as unused; future
// callers may want the calico for a custom mood without restating
// the import path.
export const _calicoSprite = CalicoSprite
