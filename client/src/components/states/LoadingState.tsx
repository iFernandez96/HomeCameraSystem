import { EventListSkeleton } from '../Skeleton'

/**
 * Shape-aware route-loading skeleton. Renders the geometry of the
 * resolved content so the user sees the layout settle before data
 * arrives — no "blank → spinner → pop" flicker.
 *
 * iter-356.63 introduced the four shapes; the premium-launch slice
 * tightened each variant's tone so the placeholder reads as warm
 * resolving content rather than a cooler-tinted "broken theme"
 * rectangle (Maya Critical). All blocks use `--color-skeleton` (a
 * tobacco hue between `--color-bg` and `--color-surface`) instead of
 * the cooler `--color-surface-raised` pine.
 */
export type LoadingShape = 'list' | 'grid' | 'video' | 'form'

export interface LoadingStateProps {
  shape: LoadingShape
}

export function LoadingState({ shape }: LoadingStateProps) {
  if (shape === 'list') {
    // EventListSkeleton renders its own role="status" + aria-busy on
    // the timeline-shaped wrapper. No extra outer wrapper — the
    // skeleton owns the geometry end-to-end so first paint matches
    // the resolved timeline pixel-for-pixel.
    return <EventListSkeleton rows={6} />
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
            className="aspect-square rounded-xl bg-[var(--color-skeleton)] border border-[var(--color-border)] animate-pulse"
            style={{ animationDelay: `${i * 60}ms` }}
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
        <div className="aspect-video w-full rounded-xl bg-[var(--color-skeleton)] border border-[var(--color-border)] animate-pulse" />
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
      <div className="h-7 w-40 bg-[var(--color-skeleton)] rounded animate-pulse" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-4 w-24 bg-[var(--color-skeleton)] rounded animate-pulse" />
            <div className="h-10 w-full bg-[var(--color-skeleton)] rounded-lg animate-pulse" />
          </div>
        ))}
        <div className="h-11 w-full bg-[var(--color-skeleton)] rounded-xl animate-pulse" />
      </div>
    </div>
  )
}
