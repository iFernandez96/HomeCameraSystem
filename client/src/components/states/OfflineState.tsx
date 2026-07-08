import { Button } from '../primitives/Button'

/**
 * Designed offline state for camera / network failures. Two cases:
 *   kind="camera"  — WHEP collapsed; suggest power/cable check.
 *   kind="network" — fetch network-failed; suggest connectivity check.
 *
 * NO cat brand — cat illustrations are reserved for calm/idle
 * surfaces. Errors and offline get a stroked danger glyph so the
 * user reads "this is broken" instead of "the cat is napping."
 *
 * `size="full"` (default) — full-page treatment for route-level
 *   errors (EventList offline, People page network failure).
 * `size="compact"` (premium-launch slice — Maya Critical #4) — tight
 *   treatment for embedding inside a 16:9 video tile, where the
 *   full-size icon + heading + retry would overflow on short
 *   displays. Pre-fix VideoTile rendered the full-size variant
 *   inside a 16:9 container and the danger circle + paragraph + Retry
 *   button overflowed on landscape phones. Compact shrinks the icon
 *   to a 36 px pill, drops the multi-line body to a single
 *   actionable hint, and uses a sm-sized Retry button.
 */
export interface OfflineStateProps {
  kind: 'camera' | 'network'
  retry?: () => void
  /** @default 'full' */
  size?: 'full' | 'compact'
}

const HEADINGS = {
  camera: 'Camera offline',
  network: 'Network offline',
} as const

const FULL_BODIES = {
  camera:
    'We can’t reach your camera right now. Check that it’s powered on and connected to your home network.',
  network:
    'We can’t reach the server right now. Check your internet connection and try again.',
} as const

const COMPACT_BODIES = {
  // "Power-cycle the camera" alone was misleading (2026-07-07): the
  // tile lands here for phone-side drops too (backgrounded tab, radio
  // handoff), where the camera is fine — name both causes.
  camera: 'Check your connection or the camera, then tap Retry.',
  network: 'Check your connection, then tap Retry.',
} as const

export function OfflineState({
  kind,
  retry,
  size = 'full',
}: OfflineStateProps) {
  const heading = HEADINGS[kind]
  const isCompact = size === 'compact'
  const body = isCompact ? COMPACT_BODIES[kind] : FULL_BODIES[kind]

  if (isCompact) {
    return (
      <div
        className="text-center space-y-3 max-w-xs mx-auto px-4"
        role="status"
        aria-live="polite"
        aria-label={heading}
      >
        <div className="mx-auto w-9 h-9 rounded-full bg-[var(--color-danger-bg)] flex items-center justify-center">
          <OfflineIcon kind={kind} size={20} className="text-[var(--color-danger)]" />
        </div>
        <div className="space-y-1">
          <p className="text-base font-semibold text-white">{heading}</p>
          <p className="text-sm text-white/75">{body}</p>
        </div>
        {retry && (
          <Button variant="primary" size="sm" onClick={retry}>
            Retry
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      className="text-center py-10 lg:py-16 px-6 space-y-4 max-w-md mx-auto"
      role="status"
      aria-live="polite"
      aria-label={heading}
    >
      <div className="mx-auto w-16 h-16 rounded-full bg-[var(--color-danger-bg)] flex items-center justify-center">
        <OfflineIcon kind={kind} size={32} className="text-[var(--color-danger)]" />
      </div>
      <div className="space-y-1.5">
        <p className="text-lg font-semibold text-[var(--color-text-primary)]">
          {heading}
        </p>
        <p className="text-sm text-[var(--color-text-secondary)]">{body}</p>
      </div>
      {retry && (
        <Button variant="primary" size="md" onClick={retry} className="mt-2">
          Retry
        </Button>
      )}
    </div>
  )
}

function OfflineIcon({
  kind,
  size,
  className,
}: {
  kind: 'camera' | 'network'
  size: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {kind === 'camera' ? (
        <>
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </>
      )}
    </svg>
  )
}
