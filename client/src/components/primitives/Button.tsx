import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import { useRipple } from '../../lib/ripple'

/**
 * iter-356.2 — Button primitive (Phase 2 of mega-overhaul).
 *
 * Replaces the five divergent button treatments scattered across
 * DangerZone (4 colors), the confirm modal Cancel/Confirm pair, the
 * VideoTile Retry overlay, the People-page Train button, the action
 * panel Move/Delete row, etc. All driven by iter-356.0 design tokens
 * (--color-accent-*, --color-danger, --color-surface-raised, radius
 * scale, focus-ring, motion).
 *
 * Variants:
 *   primary     — single CTA per screen; Panther-ink fill, white label
 *   secondary   — paper surface + hairline border; non-primary action
 *   ghost       — text-only; cancel / dismiss / cleanup
 *   destructive — solid danger-strong fill, white label; reboot, delete, sign out
 *
 * Sizes:
 *   sm — chip-density (compact rows, action-panel buttons)
 *   md — default (most interactive surfaces; meets 44 px tap target)
 *   lg — full-width hero buttons (Login submit, primary settings CTAs)
 *
 * Booleans:
 *   loading  — disables + swaps content with the optional loadingText +
 *              an inline spinner. If loadingText is omitted the children
 *              render with reduced opacity so width stays stable.
 *   fullWidth — width:100% (avoids the className override pattern).
 *
 * Usage:
 *   <Button variant="primary" size="md">Save</Button>
 *   <Button variant="destructive" size="md">Reboot Jetson</Button>
 *   <Button variant="ghost" size="sm">Cancel</Button>
 *   <Button variant="primary" loading loadingText="Signing in…">Sign in</Button>
 *
 * Accessibility: forwards `ref` so confirm.tsx's focus-restore
 * pattern (iter-270 sharp edge) keeps working. Disabled-while-loading
 * uses `aria-disabled` + `disabled` so SR announces the state and
 * pointer events are blocked.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  loadingText?: string
  fullWidth?: boolean
  children: ReactNode
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // redesign/warm-boutique (Sunroom): the calico tri-tone discipline —
  // primary actions are Panther-INK fills, not marmalade. Ink on linen
  // is the signature move (Things-3-style dark primary on a warm
  // ground); the marmalade accent stays reserved for links / focus /
  // live signal so a screen never shouts twice. Label uses
  // --color-on-ink, NOT text-white: the dual theme INVERTS the ink
  // fill on dark ("Sunroom at night" — ink becomes parchment), so a
  // hardcoded white label would vanish. on-ink is white on light,
  // dark ink on dark (~14:1 both ways); the focus ring stays
  // marmalade via BASE_CLASSES.
  // Press feedback: hover lifts to ink-hover, active steps back onto
  // the full ink (one past hover) — paired with the base active:scale
  // cue + Material ripple so a press never looks identical to a hover.
  primary:
    'bg-[var(--color-ink)] text-[var(--color-on-ink)] ' +
    'hover:bg-[var(--color-ink-hover)] active:bg-[var(--color-ink)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  // redesign/warm-boutique: secondary = paper card. Rest state sits on
  // --color-surface (cream paper) with the default hairline border;
  // hover lifts to --color-surface-raised + a stronger border so the
  // fill-area feedback stays unambiguous (iter-356.5 desktop B1 kept —
  // on the light theme surface→raised is a clear warm step, unlike the
  // old dark border-only delta).
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-text-primary)] ' +
    'border border-[var(--color-border)] ' +
    'hover:bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)] ' +
    'active:bg-[var(--color-surface-raised)] active:border-[var(--color-border-strong)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  // redesign/warm-boutique: ghost active state moves off
  // --color-surface-overlay (now the same paper as --color-surface, so
  // a press would flash LIGHTER than the hover) onto the raised tone.
  ghost:
    'bg-transparent text-[var(--color-text-secondary)] ' +
    'hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)] ' +
    'active:bg-[var(--color-surface-raised)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  // redesign/warm-boutique: destructive is a SOLID --color-danger-strong
  // fill with white text. text-white here is CORRECT (unlike primary):
  // danger-strong stays a constant red fill across both themes, so the
  // white label never inverts. The old dark-theme treatment was a translucent danger
  // tint + danger text — on the light linen ground that reads as a
  // pale pink chip, far too quiet for "Reboot Jetson" / "Delete clip".
  // Hover deepens to the brick --color-danger token.
  // ANTI-RECO (kept from iter-356.5): do not auto-prepend a warning
  // icon "for color-blind safety." Destructive is reserved for
  // unambiguous labels; a mandatory icon widens button rows and breaks
  // ActionButton geometry. Color + label is sufficient — callers MUST
  // keep labels unambiguous.
  destructive:
    'bg-[var(--color-danger-strong)] text-white ' +
    'hover:bg-[var(--color-danger)] active:bg-[var(--color-danger)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  // sm keeps chip-density padding/type but a 40px min-height (Frank A1:
  // 32px was under any sane touch-target floor on the phone).
  sm: 'px-3 py-1.5 text-xs min-h-[40px] gap-1.5',
  md: 'px-4 py-2.5 text-sm min-h-[44px] gap-2',
  lg: 'px-5 py-3 text-base min-h-[48px] gap-2',
}

// active:scale-[0.98] is the toast press idiom — every variant gets a
// physical press cue distinct from its hover state.
// `relative overflow-hidden` contains the Material press ripple
// (lib/ripple.ts): the ripple span is absolutely positioned inside the
// button and must clip to the rounded-xl bounds.
const BASE_CLASSES =
  'relative overflow-hidden ' +
  'inline-flex items-center justify-center font-semibold ' +
  'rounded-xl transition-colors duration-150 active:scale-[0.98] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ' +
  'select-none'

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      loadingText,
      fullWidth = false,
      disabled,
      className,
      children,
      type = 'button',
      onPointerDown,
      ...rest
    },
    ref,
  ) {
    const ripple = useRipple()
    const computed =
      `${BASE_CLASSES} ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}` +
      (fullWidth ? ' w-full' : '') +
      (className ? ` ${className}` : '')

    const isDisabled = disabled || loading

    // iter-356.5 (a11y C1, Top blocker #1): Dana's NVDA test —
    // pre-iter-356.5 the spinner was aria-hidden, the visible label
    // changed silently, the button was disabled, but no screen
    // reader event fired. Dana submitted the form and heard nothing
    // for several seconds, then submitted again (duplicate request).
    // Fix: aria-busy on the button + a visually-hidden live region
    // OUTSIDE the button (so the button label stays clean for the
    // accessible name) that announces loadingText once when loading
    // starts. The visible label can stay the same (no jiggle) and
    // SR users still get the state change.
    return (
      <>
        <button
          ref={ref}
          type={type}
          disabled={isDisabled}
          aria-disabled={isDisabled || undefined}
          aria-busy={loading || undefined}
          className={computed}
          // Material press ripple + the caller's own handler. Disabled
          // buttons don't fire pointer events in most browsers, but
          // jsdom does — guard so tests match reality.
          onPointerDown={(ev) => {
            if (!isDisabled) ripple(ev)
            onPointerDown?.(ev)
          }}
          {...rest}
        >
          {loading ? (
            <>
              <Spinner />
              {loadingText ?? children}
            </>
          ) : (
            children
          )}
        </button>
        <span role="status" aria-live="polite" className="sr-only">
          {loading ? (loadingText ?? 'Loading') : ''}
        </span>
      </>
    )
  },
)


function Spinner() {
  // Inline 4-spoke spinner. `animate-spin` + `prefers-reduced-motion`
  // global rule (index.css) means the rotation collapses to 0.01 ms
  // for vestibular-sensitive users; the static circle still reads as
  // "loading" via aria.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
