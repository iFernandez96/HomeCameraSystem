import { Button } from '../primitives/Button'

/**
 * iter-356.63 (mobile redesign Slice F): designed error state.
 *
 * Replaces the inline error blocks scattered across People / Events /
 * Training / Review with a single primitive. NO cat — the cat brand
 * is reserved for calm/idle surfaces; errors get a yellow-warn glyph
 * so the user reads "something went wrong" without anthropomorphizing.
 *
 * Friendly copy in `title` + `message`; raw exception text goes into
 * a collapsed `<details>` so Frank doesn't see "TypeError: cannot read
 * property 'foo' of undefined" on first paint.
 *
 * The h2 is the title — pages that already render an h1 get an h2 in
 * the error block so the heading hierarchy doesn't break.
 */
export interface ErrorStateProps {
  title: string
  message?: string
  retry?: () => void
  technicalDetail?: string
}

export function ErrorState({
  title,
  message,
  retry,
  technicalDetail,
}: ErrorStateProps) {
  return (
    <div
      className="text-center py-10 lg:py-16 px-6 space-y-4 max-w-md mx-auto"
      role="alert"
      aria-live="polite"
    >
      <div className="mx-auto w-16 h-16 rounded-full bg-[var(--color-warning-bg,_rgba(234,179,8,0.12))] flex items-center justify-center">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-yellow-600"
          aria-hidden="true"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {title}
        </h2>
        {message && (
          <p className="text-sm text-[var(--color-text-secondary)]">
            {message}
          </p>
        )}
      </div>
      {retry && (
        <Button variant="primary" size="md" onClick={retry} className="mt-2">
          Retry
        </Button>
      )}
      {technicalDetail && (
        <details className="mt-2 text-sm text-[var(--color-text-tertiary)] text-left max-w-md mx-auto">
          <summary className="cursor-pointer hover:text-[var(--color-text-secondary)] text-center">
            Technical details
          </summary>
          <p className="mt-1 break-all">{technicalDetail}</p>
        </details>
      )}
    </div>
  )
}
