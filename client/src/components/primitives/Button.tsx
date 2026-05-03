import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

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
 *   primary     — single CTA per screen; brand-blue fill, white label
 *   secondary   — neutral outline; confirms a non-primary action
 *   ghost       — text-only; cancel / dismiss / cleanup
 *   destructive — red fill / outline; reboot, delete, sign out
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
  // iter-356.26 fix: text-white is correct here. The iter-356.26 bulk
  // sed swept text-white → text-[var(--color-text-primary)] (warm dark) but
  // for the primary button the FILL is calico-orange (--color-accent-
  // default) — dark-brown text on dark-orange is muddy and on the
  // running app rendered the Sign-in button as INVISIBLE (text and bg
  // both warm-dark hues). White on orange is the readable contrast
  // pair (~5:1) and matches Linear/Things/Cron primary buttons.
  primary:
    'bg-[var(--color-accent-default)] text-white ' +
    'hover:bg-[var(--color-accent-bright)] active:bg-[var(--color-accent-muted)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  // iter-356.5 (desktop B1): pre-iter-356.5 hover was border-only
  // (border #2a → #3a, 16-pt lightness delta). On a typical office
  // TN panel with compressed darks the change was invisible; cursor
  // hover felt unresponsive on Settings + DangerZone buttons. Added
  // `hover:bg-[var(--color-surface-overlay)]` for unambiguous fill-area
  // feedback (matches the ghost variant pattern).
  secondary:
    'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] ' +
    'border border-[var(--color-border)] ' +
    'hover:bg-[var(--color-surface-overlay)] hover:border-[var(--color-border-strong)] ' +
    'active:bg-[var(--color-surface-overlay)] active:border-[var(--color-border-strong)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  ghost:
    'bg-transparent text-[var(--color-text-secondary)] ' +
    'hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-primary)] ' +
    'active:bg-[var(--color-surface-overlay)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
  // iter-356.5 (a11y E1): text-red-300 (#fca5a5) on the blended
  // danger surface measured ~4.3:1 — fails WCAG AA body-text 4.5:1.
  // Switched to the --color-danger token (#ef4444) which measures
  // ~5.1:1 on the same surface. Also restores token-system invariant
  // (no raw Tailwind color classes inside the primitive).
  // ANTI-RECO: do not auto-prepend a warning icon "for color-blind
  // safety." The destructive variant is reserved for unambiguous
  // labels ("Reboot Jetson", "Delete clip", "Sign out") — adding a
  // mandatory icon makes button rows wider and breaks the existing
  // ActionButton geometry. Color + label combination is sufficient
  // when the label is unambiguous; callers MUST keep it that way.
  destructive:
    // iter-356.14 (Maya MAJOR fix): pre-tokenized tinted bg via
    // color-mix in index.css. Pre-iter-356.14 the `/15` /opacity
    // modifier on a CSS-var-bg didn't apply reliably in Tailwind v4
    // → button rendered solid red instead of tinted danger surface.
    'bg-[var(--color-danger-bg)] text-[var(--color-danger)] ' +
    'border border-[var(--color-danger-muted)] ' +
    'hover:bg-[var(--color-danger-bg-strong)] active:bg-[var(--color-danger-bg-strong)] ' +
    'disabled:opacity-60 disabled:cursor-not-allowed',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs min-h-[32px] gap-1.5',
  md: 'px-4 py-2.5 text-sm min-h-[44px] gap-2',
  lg: 'px-5 py-3 text-base min-h-[48px] gap-2',
}

const BASE_CLASSES =
  'inline-flex items-center justify-center font-semibold ' +
  'rounded-xl transition-colors duration-150 ' +
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
      ...rest
    },
    ref,
  ) {
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
