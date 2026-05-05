import { EventListSkeleton } from '../Skeleton'

/**
 * iter-356.63 (mobile redesign Slice F): route-shaped skeleton loader.
 *
 * Pre-Slice-F: Suspense fallbacks were a centered <PawSpinner> — a
 * gray puck on an empty background, then the page popped in. The
 * shape change from "nothing" → "list" caused content reflow that
 * read as "something broke and reloaded."
 *
 * Each shape returns a Skeleton composition that matches the geometry
 * of the resolved content so the user sees the layout settle before
 * data arrives.
 */
export type LoadingShape = 'list' | 'grid' | 'video' | 'form'

export interface LoadingStateProps {
  shape: LoadingShape
}

export function LoadingState({ shape }: LoadingStateProps) {
  if (shape === 'list') {
    return (
      <div className="px-4 py-3" role="status" aria-busy="true" aria-label="Loading">
        <span className="sr-only">Loading</span>
        <EventListSkeleton rows={6} />
      </div>
    )
  }
  if (shape === 'grid') {
    return (
      <div
        className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <span className="sr-only">Loading</span>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="aspect-square rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] animate-pulse"
          />
        ))}
      </div>
    )
  }
  if (shape === 'video') {
    return (
      <div
        className="p-4 max-w-5xl mx-auto"
        role="status"
        aria-busy="true"
        aria-label="Loading video"
      >
        <span className="sr-only">Loading video</span>
        <div className="aspect-video w-full rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] animate-pulse" />
      </div>
    )
  }
  // form
  return (
    <div
      className="p-4 max-w-md mx-auto space-y-4"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <span className="sr-only">Loading</span>
      <div className="h-7 w-40 bg-[var(--color-surface-raised)] rounded animate-pulse" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-4 w-24 bg-[var(--color-surface-raised)] rounded animate-pulse" />
            <div className="h-10 w-full bg-[var(--color-surface-raised)] rounded-lg animate-pulse" />
          </div>
        ))}
        <div className="h-11 w-full bg-[var(--color-surface-raised)] rounded-xl animate-pulse" />
      </div>
    </div>
  )
}
