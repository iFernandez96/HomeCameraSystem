import { Button } from '../primitives/Button'

/**
 * iter-356.63 (mobile redesign Slice F): designed offline state.
 *
 * Pre-Slice-F: VideoTile rendered an inline div + plain text + a
 * Retry button when WHEP collapsed; EventList / People rendered a
 * default `<p>Could not load…</p>` block when fetch failed with a
 * network error. Two divergent treatments for the same idea ("the
 * network or the camera dropped").
 *
 * This primitive consolidates the two cases:
 *   kind="camera"  — WHEP collapsed; suggest power/cable check.
 *   kind="network" — fetch network-failed; suggest connectivity check.
 *
 * NO cat. The cat brand is reserved for calm/neutral surfaces (empty
 * lists, idle states). Errors and offline get a stroked danger glyph
 * so the user reads "this is broken" instead of "the cat is napping."
 */
export interface OfflineStateProps {
  kind: 'camera' | 'network'
  retry?: () => void
}

export function OfflineState({ kind, retry }: OfflineStateProps) {
  const heading = kind === 'camera' ? 'Camera offline' : 'Network offline'
  const body =
    kind === 'camera'
      ? 'We can’t reach your camera right now. Check that it’s powered on and connected to your home network.'
      : 'We can’t reach the server right now. Check your internet connection and try again.'
  return (
    <div
      className="text-center py-10 lg:py-16 px-6 space-y-4 max-w-md mx-auto"
      role="status"
      aria-live="polite"
      aria-label={heading}
    >
      <div className="mx-auto w-16 h-16 rounded-full bg-[var(--color-danger-bg)] flex items-center justify-center">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[var(--color-danger)]"
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
