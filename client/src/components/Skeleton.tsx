/**
 * Premium-launch slice — first-impression polish.
 *
 * Each skeleton paints a `--color-skeleton` surface (tobacco hue between
 * page bg and card surface, defined in index.css) so the placeholders
 * read as resolving content rather than a cooler-tinted "broken theme"
 * stripe — Maya Critical: "skeletons are blue-grey while the rest of
 * the app is warm tobacco; instant 'broken theme' smell."
 *
 * Each skeleton's geometry MUST match the resolved content beneath it
 * so first paint settles into final layout without reflow:
 *  - LivePageSkeleton  → matches `Live.tsx`'s full-bleed video field +
 *                        bottom action strip + bottom health strip.
 *  - EventListSkeleton → matches `EventList.tsx`'s vertical timeline
 *                        (time column + axis line + horizontal log card).
 *  - HeatmapSkeleton   → matches `EventHeatmap.tsx`'s day-cell row.
 */

/**
 * Live page skeleton — full-bleed video + below-fold action strip +
 * health strip. Matches the iter-356.58 layout-rebuild geometry of
 * Live.tsx so the first-paint shape settles into the resolved page
 * without CLS reflow.
 */
export function LivePageSkeleton() {
  return (
    <div
      className="flex flex-col h-[calc(100dvh-3.5rem-5rem)] lg:h-[calc(100dvh-3.5rem)]"
      role="status"
      aria-label="Loading camera"
      aria-busy="true"
    >
      <span className="sr-only">Loading camera</span>
      {/* Video field — full bleed, dark, with placeholder overlay
          shapes that mirror the resolved camera label + trust cluster. */}
      <div className="relative flex-1 min-h-0 bg-black overflow-hidden lg:rounded-tl-2xl">
        <div className="absolute inset-0 bg-gradient-to-b from-black/0 via-black/0 to-black/40" />
        {/* Bottom-left identity placeholder — camera name + subtitle */}
        <div className="absolute left-4 sm:left-6 bottom-4 right-4 sm:right-6 flex items-end justify-between gap-4">
          <div className="flex flex-col gap-2 min-w-0">
            <div className="h-6 w-32 bg-white/15 rounded animate-pulse" />
            <div className="h-3 w-44 bg-white/10 rounded animate-pulse" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-20 bg-white/12 rounded-full animate-pulse" />
          </div>
        </div>
      </div>
      {/* Mobile-only action strip placeholder. Desktop overlays on the
          video, so this section is hidden on lg+. */}
      <div className="sm:hidden flex flex-col gap-2 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <div className="h-14 w-full bg-[var(--color-skeleton)] rounded-xl animate-pulse" />
        <div className="grid grid-cols-2 gap-2">
          <div className="h-11 bg-[var(--color-skeleton)] rounded-xl animate-pulse" />
          <div className="h-11 bg-[var(--color-skeleton)] rounded-xl animate-pulse" />
        </div>
      </div>
      <div className="sm:hidden px-4 py-3">
        <div className="h-20 w-full bg-[var(--color-skeleton)] rounded-2xl animate-pulse" />
      </div>
    </div>
  )
}

/** Lazy-EventHeatmap fallback: mirrors the day-cell row geometry so
 *  the resolved chunk doesn't reflow the surrounding content. */
export function HeatmapSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading detection calendar"
      aria-busy="true"
      className="px-4 py-3 animate-pulse"
    >
      <div className="h-4 w-32 bg-[var(--color-skeleton)] rounded mb-2" />
      <div className="flex gap-1">
        {Array.from({ length: 30 }).map((_, i) => (
          <div
            key={i}
            className="h-6 w-2 rounded-sm bg-[var(--color-skeleton)]"
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Timeline-shaped event list skeleton. Pre-fix the skeleton was a
 * generic 16×16 thumb + two text lines per row — it didn't match the
 * resolved timeline's time-column / axis-tick / horizontal-card
 * geometry, so first paint shifted ~24-40 px on resolve. Maya
 * Critical: "EventListSkeleton rows={6} doesn't match the timeline
 * geometry (time-column + axis-tick + horizontal log-row). Build a
 * TimelineRowSkeleton."
 *
 * The geometry mirrors `EventList.tsx`'s timeline:
 *   - left edge: 14-px-wide brass-tinted time column
 *   - axis: 1-px line at left:4.25rem
 *   - axis tick: small accent-colored ring at the row's center
 *   - row card: thumbnail-left (112×72) + meta-right (title + meta)
 */
export function EventListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading events"
      aria-busy="true"
      className="pb-4 lg:max-w-3xl lg:mx-auto"
    >
      {/* Mock day-header so the resolved timeline drops into the same
          y-position rather than pushing the first row down 56 px. */}
      <div className="px-4 pt-3 pb-2 flex items-baseline gap-3 border-b border-[var(--color-border-subtle)]">
        <div className="h-7 w-40 bg-[var(--color-skeleton)] rounded animate-pulse" />
        <div className="h-3 w-16 bg-[var(--color-skeleton)] rounded animate-pulse" />
      </div>
      <ol className="relative list-none px-4 pt-2 pb-3">
        {/* Axis line — exactly the same geometry as the resolved one
            so the eye doesn't perceive a shift. */}
        <span
          aria-hidden="true"
          className="absolute left-[4.25rem] top-2 bottom-2 w-px bg-[var(--color-border-subtle)]"
        />
        {Array.from({ length: rows }).map((_, i) => (
          <li
            key={i}
            className="relative pl-20 pb-3 last:pb-0 animate-pulse"
            style={{
              // Stagger the pulse phase a touch so all six rows don't
              // breathe in lockstep — feels mechanical otherwise.
              animationDelay: `${i * 80}ms`,
            }}
          >
            {/* TIME column placeholder */}
            <span
              aria-hidden="true"
              className="absolute left-0 top-2 w-14 h-3 bg-[var(--color-skeleton)] rounded"
            />
            {/* AXIS tick — same dot color the resolved one uses, lower
                opacity so it reads as not-yet-loaded. */}
            <span
              aria-hidden="true"
              className="absolute left-[3.875rem] top-3.5 w-2.5 h-2.5 rounded-full bg-[var(--color-border-strong)] ring-2 ring-[var(--color-bg)]"
            />
            {/* Card body — 112×72 thumb on the left, meta on the right. */}
            <div className="flex gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-skeleton)] p-2">
              <div className="w-28 h-[72px] flex-none rounded-lg bg-[var(--color-skeleton-strong)]" />
              <div className="flex-1 min-w-0 flex flex-col py-0.5 gap-1.5">
                <div className="h-4 w-3/4 bg-[var(--color-skeleton-strong)] rounded" />
                <div className="h-3 w-1/2 bg-[var(--color-skeleton-strong)] rounded" />
                <div className="mt-auto h-4 w-24 bg-[var(--color-skeleton-strong)] rounded-full" />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
