/**
 * iter-356.20 (Maya 14th CRITICAL #1): Live-shaped skeleton for the
 * cold-load FOUC fix. Pre-iter-356.20 the cycle was navbar → empty
 * <main> (RequireAuth `null` while auth loads) → spinner (Suspense
 * fallback) → empty (Live mounts) → video. ~800-1500ms of nervous
 * tic on Tailscale cellular.
 *
 * This skeleton renders the page-to-be: 16:9 dark video tile (left,
 * 2/3 on lg) + side rail with 3 stacked card outlines (action panel,
 * system health, cat layer area). User sees the SHAPE settling
 * already and knows where the video and stats will appear.
 */
export function LivePageSkeleton() {
  // iter-356.25 (light theme): all neutral-800/900 hardcoded greys
  // tokenized to --color-surface-raised (warm cream) so the skeleton
  // reads as soft loading-paper on the cream page bg, not as dark
  // tiles inverted from the deploy.
  return (
    <div
      className="p-4 space-y-4 max-w-5xl mx-auto"
      role="status"
      aria-label="Loading camera"
      aria-busy="true"
    >
      <div className="h-7 w-32 bg-[var(--color-surface-raised)] rounded animate-pulse" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="aspect-video w-full rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] animate-pulse" />
        </div>
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-3 py-3 space-y-2.5 animate-pulse">
            <div className="h-14 w-full bg-[var(--color-surface-raised)] rounded-xl" />
            <div className="grid grid-cols-2 gap-2">
              <div className="h-11 bg-[var(--color-surface-raised)] rounded-xl" />
              <div className="h-11 bg-[var(--color-surface-raised)] rounded-xl" />
            </div>
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl px-4 py-3 animate-pulse">
            <div className="flex items-center gap-2.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-border-strong)]" />
              <div className="h-5 w-40 bg-[var(--color-surface-raised)] rounded" />
            </div>
            <div className="h-4 w-56 bg-[var(--color-surface-raised)] rounded mt-2 ml-5" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function EventListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul
      className="divide-y divide-[var(--color-border-subtle)]"
      role="status"
      aria-label="Loading events"
      aria-busy="true"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
          <div className="w-16 h-16 rounded-lg bg-[var(--color-surface-raised)] flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 bg-[var(--color-surface-raised)] rounded" />
            <div className="h-3 w-40 bg-[var(--color-surface-raised)] rounded" />
          </div>
          <div className="h-3 w-8 bg-[var(--color-surface-raised)] rounded" />
        </li>
      ))}
    </ul>
  )
}
