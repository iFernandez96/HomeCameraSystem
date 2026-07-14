import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { CatAnimId } from '../components/catAnimSequences'
import { GroundPoop, POOP_SIZE_FRAC } from '../components/GroundPoop'
import { PlaygroundCat } from './PlaygroundCat'
import { CAT_WIDTH_PX } from './sceneModel'
import { BACK_LANE_SCALE } from './playgroundTypes'
import {
  PlaygroundAmbient,
  PlaygroundFurniture,
  PlaygroundToys,
} from './PlaygroundProps'
import { VerbToolbar } from './VerbToolbar'
import {
  initialPlaygroundState,
  type PlaygroundState,
} from './playgroundState'
import { stepPlayground } from './stepPlayground'
import { resetToyLayer } from './toyLayer'
import { laneForY } from './toyPhysics'
import type { PlaygroundInput, PlaygroundVerb } from './playgroundTypes'

// Playground Slice B — the scene shell and rAF owner. One loop, one
// setState per frame; stepPlayground returns the SAME state reference
// when nothing moved so React's updater bails out of the re-render
// entirely (CatLayer perf discipline). ALL pointer traffic lands in a
// ref (never React state — no render per pointermove); the loop reads
// the input snapshot once per tick.
//
// staticScene (reduced-motion / reduced-data / battery): the cats pose
// at their home anchors, no rAF is EVER scheduled, no toolbar renders.

export type PlaygroundSceneProps = {
  /** Perf/preference gate from the page: render the posed diorama and
      never schedule animation work. */
  staticScene: boolean
  /** Sub-480px layout: the shelf superhighway + plant are hidden and
      their anchors leave the beat pool. */
  compact: boolean
}

// jsdom (and a first paint racing layout) measure 0×0 — fall back to a
// sane stage so the pure math never divides by zero. The real size is
// re-measured before the state initializes and on every resize.
const FALLBACK_W = 640
const FALLBACK_H = 360

const FLICK_SAMPLES = 3

/** A tap shorter than one-two frames would flip pointer.down back off
    before any rAF tick reads it — the laser dot would NEVER show for
    quick pokes (the live FINDING-3 miss). Sub-dwell laser taps latch
    the press so the dot flashes where the finger landed. */
const LASER_TAP_DWELL_MS = 280

function freshInput(): PlaygroundInput {
  return { pointer: null, activeVerb: null, petTarget: null, flick: null, treatTap: null }
}

export function PlaygroundScene({ staticScene, compact }: PlaygroundSceneProps) {
  const sceneRef = useRef<HTMLDivElement | null>(null)
  const sizeRef = useRef({ w: FALLBACK_W, h: FALLBACK_H })
  /** The live input snapshot — written by pointer handlers, read (and
      one-shot-consumed) by the toy layer once per tick. */
  const inputRef = useRef<PlaygroundInput>(freshInput())
  /** Ring buffer of the last pointer samples while pressed — flick
      velocity for the yarn throw comes from its endpoints. */
  const flickRef = useRef<{ x: number; y: number; t: number }[]>([])
  /** Laser tap latch: press start stamp + the pending release timer. */
  const pressAtRef = useRef(0)
  const tapReleaseRef = useRef<number | null>(null)

  const [state, setState] = useState<PlaygroundState | null>(null)
  const [verb, setVerb] = useState<PlaygroundVerb | null>(null)
  // Rendered scene width — the packed furniture layout derives from it
  // (px positions, not CSS percentages), so the render side needs a
  // re-render on resize. The rAF loop keeps reading the ref.
  const [sceneW, setSceneW] = useState(FALLBACK_W)

  const measure = useCallback(() => {
    const rect = sceneRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      sizeRef.current = { w: rect.width, h: rect.height }
      setSceneW((prev) => (prev === rect.width ? prev : rect.width))
    }
  }, [])

  // Init after first paint (microtask, so the scene box is measurable
  // and the React 19 no-sync-setState-in-effect rule stays satisfied).
  useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      measure()
      setState(
        initialPlaygroundState(
          performance.now(),
          sizeRef.current.w,
          sizeRef.current.h,
          Math.random,
          compact,
        ),
      )
    })
    return () => {
      cancelled = true
    }
    // compact only seeds the INITIAL pose; live flips flow through the
    // step options, so re-init on change is unnecessary (and unwanted).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure])

  // Track resizes so travel targets stay on their furniture. Anchored
  // cats re-seat on their next beat; nothing needs a state rebuild.
  useEffect(() => {
    if (typeof ResizeObserver !== 'undefined' && sceneRef.current) {
      const observer = new ResizeObserver(measure)
      observer.observe(sceneRef.current)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // The toy layer's verb memory is module-level (one scene at a time);
  // forget it when the scene unmounts so a return visit starts fresh.
  useEffect(() => () => resetToyLayer(), [])

  const ready = state !== null

  // --- The rAF loop -----------------------------------------------------------
  useEffect(() => {
    if (staticScene || !ready) return
    let raf = 0
    let lastTs = performance.now()
    let visible = !document.hidden
    const onVis = () => {
      // Pause stepping while hidden; reset the clock on return so the
      // first visible frame doesn't integrate the whole absence.
      visible = !document.hidden
      lastTs = performance.now()
    }
    document.addEventListener('visibilitychange', onVis)

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // dt clamp 33ms (CatLayer iter-356.21): a stutter or tab return
      // plays out at slow motion instead of teleporting every actor.
      const dt = Math.min(now - lastTs, 33)
      lastTs = now
      if (!visible) return
      // ONE setState per frame. stepPlayground returns `prev` itself
      // when no cat/toy/ambient changed, so React bails out.
      setState((prev) =>
        prev === null
          ? prev
          : stepPlayground(
              prev,
              inputRef.current,
              dt,
              now,
              sizeRef.current.w,
              sizeRef.current.h,
              { compact },
            ),
      )
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [staticScene, ready, compact])

  // --- Pointer input (refs only — no render per move) --------------------------

  const toScene = useCallback((event: ReactPointerEvent) => {
    const rect = sceneRef.current?.getBoundingClientRect()
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    }
  }, [])

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const p = toScene(event)
      const input = inputRef.current
      input.pointer = { x: p.x, y: p.y, down: true }
      pressAtRef.current = performance.now()
      if (tapReleaseRef.current !== null) {
        window.clearTimeout(tapReleaseRef.current)
        tapReleaseRef.current = null
      }
      flickRef.current = [{ x: p.x, y: p.y, t: performance.now() }]
      if (input.activeVerb === 'treat') {
        input.treatTap = { x: p.x, y: p.y, lane: laneForY(p.y, sizeRef.current.h) }
      }
    },
    [toScene],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const p = toScene(event)
      const input = inputRef.current
      const down = input.pointer?.down ?? false
      input.pointer = { x: p.x, y: p.y, down }
      if (down) {
        const buf = flickRef.current
        buf.push({ x: p.x, y: p.y, t: performance.now() })
        if (buf.length > FLICK_SAMPLES) buf.shift()
      }
    },
    [toScene],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const p = toScene(event)
      const input = inputRef.current
      const wasDown = input.pointer?.down ?? false
      if (wasDown && input.activeVerb === 'yarn') {
        // Flick velocity (px/ms) across the sample window; a stationary
        // release still throws — the yarn just drops where it is.
        const first = flickRef.current[0]
        const dtMs = first ? Math.max(performance.now() - first.t, 1) : 1
        input.flick = {
          x: p.x,
          y: p.y,
          vx: first ? (p.x - first.x) / dtMs : 0,
          vy: first ? (p.y - first.y) / dtMs : 0,
        }
      }
      if (
        wasDown &&
        input.activeVerb === 'laser' &&
        performance.now() - pressAtRef.current < LASER_TAP_DWELL_MS
      ) {
        // Sub-dwell tap: keep the press latched so at least a few ticks
        // see it — the dot flashes at the tap point, then releases.
        input.pointer = { x: p.x, y: p.y, down: true }
        tapReleaseRef.current = window.setTimeout(() => {
          const current = inputRef.current.pointer
          if (current !== null) {
            inputRef.current.pointer = { ...current, down: false }
          }
          tapReleaseRef.current = null
        }, LASER_TAP_DWELL_MS)
      } else {
        input.pointer = { x: p.x, y: p.y, down: false }
      }
      flickRef.current = []
    },
    [toScene],
  )

  const onPointerLeave = useCallback(() => {
    // Touch pointers "leave" the instant the finger lifts — that must
    // not wipe a latched tap flash mid-dwell.
    if (tapReleaseRef.current !== null) return
    inputRef.current.pointer = null
    flickRef.current = []
  }, [])

  // The tap latch's pending release must not fire into an unmounted ref.
  useEffect(
    () => () => {
      if (tapReleaseRef.current !== null) window.clearTimeout(tapReleaseRef.current)
    },
    [],
  )

  const onSelectVerb = useCallback((next: PlaygroundVerb | null) => {
    inputRef.current.activeVerb = next
    setVerb(next)
  }, [])

  // Petting: reported by each cat's own hit area (which stops
  // propagation so the stroke never doubles as a verb gesture).
  const onPetStart = useCallback((catId: CatAnimId) => {
    inputRef.current.petTarget = catId
  }, [])
  const onPetEnd = useCallback((catId: CatAnimId) => {
    if (inputRef.current.petTarget === catId) inputRef.current.petTarget = null
  }, [])

  const tunnelRustling =
    !staticScene && (state?.cats.some((cat) => cat.activity === 'tunnel') ?? false)

  return (
    <div className="space-y-3">
      <div
        ref={sceneRef}
        data-testid="playground-scene"
        data-motion={staticScene ? 'static' : 'animated'}
        aria-hidden="true"
        className="relative overflow-hidden h-[min(52vh,420px)] rounded-2xl border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)]"
        style={{ touchAction: verb !== null ? 'none' : 'pan-y' }}
        onPointerDown={staticScene ? undefined : onPointerDown}
        onPointerMove={staticScene ? undefined : onPointerMove}
        onPointerUp={staticScene ? undefined : onPointerUp}
        onPointerLeave={staticScene ? undefined : onPointerLeave}
        onPointerCancel={staticScene ? undefined : onPointerLeave}
      >
        <style>{`
          /* CatLayer keeps these keyframes in its own <style> block and
             is never mounted on /playground, so the scene carries its
             own copies. Names match deliberately — if both ever mount,
             identical definitions collapse harmlessly. */
          @keyframes cat-mood-rise {
            0% { transform: translateX(-50%) translateY(2px) scale(0.6); opacity: 0; }
            12% { transform: translateX(-50%) translateY(-6px) scale(1.05); opacity: 1; }
            18% { transform: translateX(-50%) translateY(-8px) scale(1); opacity: 1; }
            78% { transform: translateX(-50%) translateY(-26px) scale(1); opacity: 1; }
            100% { transform: translateX(-50%) translateY(-42px) scale(0.85); opacity: 0; }
          }
          @keyframes cat-walk-bob {
            0%   { transform: translateY(0)    rotate(-1deg); }
            50%  { transform: translateY(-3px) rotate(1deg);  }
            100% { transform: translateY(0)    rotate(-1deg); }
          }
          @keyframes cat-breathe {
            0%, 100% { transform: scale(1, 1); }
            50%      { transform: scale(1.04, 0.92); }
          }
        `}</style>
        {/* Depth cue: the back-lane floor band (Slice A). */}
        <div
          className="absolute inset-x-0 bottom-0 bg-[var(--color-surface-raised)]"
          style={{ height: '38%' }}
        />
        <PlaygroundFurniture compact={compact} sceneW={sceneW} tunnelRustling={tunnelRustling} />
        {/* Ground poops (2026-07-11): spawned by stepPlayground when a
            floor squat completes, anchored in scene coordinates so they
            stay put while the cat walks away, then fade. Rendered
            before the cats at the cats' z so a cat paints over its own
            handiwork. */}
        {state?.cats.map(
          (cat) =>
            cat.poop && (
              <GroundPoop
                key={`${cat.id}-poop-${cat.poop.spawnedAt}`}
                x={cat.poop.x}
                bottom={cat.poop.y}
                size={Math.round(
                  CAT_WIDTH_PX *
                    POOP_SIZE_FRAC *
                    (cat.poop.lane === 'back' ? BACK_LANE_SCALE : 1),
                )}
                visibleMs={cat.poop.fadeAt - cat.poop.spawnedAt}
                zIndex={cat.poop.lane === 'back' ? 1 : 2}
              />
            ),
        )}
        {state?.cats.map((cat) => (
          <PlaygroundCat
            key={cat.id}
            cat={cat}
            onPetStart={onPetStart}
            onPetEnd={onPetEnd}
          />
        ))}
        {state !== null && !staticScene && (
          <>
            <PlaygroundToys toys={state.toys} />
            <PlaygroundAmbient ambient={state.ambient} />
          </>
        )}
      </div>
      {!staticScene && <VerbToolbar activeVerb={verb} onSelect={onSelectVerb} />}
    </div>
  )
}
