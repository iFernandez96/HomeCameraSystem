import { useEffect, useState } from 'react'
import { PawSpinner } from '../components/PawSpinner'
import { preloadImageUrls } from '../components/catImageCache'
import {
  useBatteryLow,
  usePrefersReducedData,
  usePrefersReducedMotion,
} from '../components/catPerfGates'
import {
  PLAYGROUND_PRELOAD_WAVE_1,
  PLAYGROUND_PRELOAD_WAVE_2,
} from '../playground/playgroundAssets'
import { PlaygroundScene } from '../playground/PlaygroundScene'

/**
 * Playground: an interactive side-view diorama room for the household
 * cats — autonomous beats (Slice B) plus the four user verbs
 * (Slice C: laser / yarn / treat / wand, with petting on the cats
 * themselves). This page owns the wave-1 preload gate and the
 * perf-preference gate; PlaygroundScene owns the rAF loop and falls
 * back to a static posed diorama when animations are paused.
 *
 * Assets may still be generating: every scene <img> hides itself
 * onError so a missing PNG degrades to an emptier room, never a
 * broken page.
 */

// Same lazy-init + change-listener pattern as catPerfGates (React 19
// lint rule: no synchronous setState in a useEffect body).
function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(max-width: 479px)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(max-width: 479px)')
    const onChange = (e: MediaQueryListEvent) => setCompact(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return compact
}

export function Playground() {
  const reducedMotion = usePrefersReducedMotion()
  const reducedData = usePrefersReducedData()
  const batteryLow = useBatteryLow()
  // Perf-gate static fallback: PlaygroundScene poses the cats at their
  // home anchors and never schedules a rAF when this is true.
  const animationsPaused = reducedMotion || reducedData || batteryLow
  const compact = useCompactLayout()

  const [sceneReady, setSceneReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Reveal on success OR failure: the art set may still be
    // generating, and each scene <img> self-hides on a 404. Gating
    // forever on a missing PNG would brick the page for no reason.
    void preloadImageUrls(
      'playground:wave1',
      PLAYGROUND_PRELOAD_WAVE_1,
      'playground:wave1-preload-failed',
    ).then(() => {
      if (!cancelled) setSceneReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Wave 2 (toys / ambient / per-cat frames) warms in the background
  // once the room is up — skipped under prefers-reduced-data since it
  // only feeds animation the gate pauses anyway.
  useEffect(() => {
    if (!sceneReady || reducedData) return
    void preloadImageUrls(
      'playground:wave2',
      PLAYGROUND_PRELOAD_WAVE_2,
      'playground:wave2-preload-failed',
    )
  }, [sceneReady, reducedData])

  return (
    <div className="p-4 space-y-4 max-w-3xl lg:max-w-4xl mx-auto">
      <header>
        {/* Same header grammar as Training.tsx: sr-only h1 for AT,
            visible display-face p (the WatchRibbon owns page identity). */}
        <h1 className="sr-only">Playground</h1>
        <p
          className="font-display text-2xl font-bold text-[var(--color-text-primary)] tracking-tight"
          aria-hidden="true"
        >
          Playground
        </p>
        <p className="text-sm text-[var(--color-text-secondary)] mt-1">
          The cats have a room of their own. Pick a toy, or just give
          someone a scritch.
        </p>
      </header>

      {!sceneReady ? (
        <div
          className="flex items-center justify-center h-[min(52vh,420px)] rounded-2xl border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)]"
          data-testid="playground-loading"
        >
          <PawSpinner size={16} ariaLabel="Setting up the playground" />
        </div>
      ) : (
        <PlaygroundScene staticScene={animationsPaused} compact={compact} />
      )}
    </div>
  )
}
