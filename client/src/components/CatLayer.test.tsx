import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  CatLayer,
  _animationPlanForForTests,
  _catSequenceNamesForTransitionForTests,
  _resetCatWalkAnimationCacheForTests,
  _rollBoutVariantForTests,
  _rollGaitVariantForTests,
  _rollWithoutImmediateRepeatForTests,
  _setActivityForTests,
  type _CatStateForTests,
  _stepCatsForTests,
} from './CatLayer'
import { WALK_STEP_ORDER } from './catAnimSequences'

// Frames-30 variant wiring: a minimal in-repose cat for the engine-level
// pins below (gait rotation, sleep breathe/dream). Field defaults mirror
// initialCats; tests override what they exercise.
function makeCatForTests(over: Partial<_CatStateForTests>): _CatStateForTests {
  return {
    id: 'panther',
    x: 100,
    y: 0,
    direction: 'L',
    activity: 'sit',
    previousActivity: 'sit',
    activityStartedAt: 0,
    activityUntil: 10_000,
    mood: null,
    moodSecondary: null,
    moodUntil: 0,
    targetX: null,
    lastInteractedWith: null,
    lastInteractedAt: 0,
    phase: 0,
    phaseTime: 0,
    idleSequence: null,
    idleSequenceStartedAt: 0,
    nextIdleLifeAt: 0,
    lastIdleLifeWasSpecial: false,
    poop: null,
    turn: null,
    boutVariant: null,
    ...over,
  }
}

type MqlInit = {
  matches: boolean
}

function stubMatchMedia({ matches }: MqlInit) {
  // Minimal MediaQueryList stub: only the surface CatLayer's
  // usePrefersReducedMotion hook touches (matches + addEventListener +
  // removeEventListener). The hook lazy-inits from `matches` at mount and
  // then subscribes to 'change' — neither path needs real timers.
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia
  return mql
}

// iter-356-E (Slice E): per-query matchMedia stub so the reduced-data
// gate can be toggled while reduced-motion stays off (the production
// hook calls matchMedia with each query string independently).
function stubMatchMediaPerQuery(map: Record<string, boolean>) {
  window.matchMedia = vi.fn((query: string) => {
    const matches = map[query] ?? false
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }
  }) as unknown as typeof window.matchMedia
}

type BatteryStub = {
  level: number
  charging: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function stubGetBattery(level: number, charging: boolean): BatteryStub {
  const battery: BatteryStub = {
    level,
    charging,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  ;(navigator as unknown as { getBattery: () => Promise<BatteryStub> }).getBattery = () =>
    Promise.resolve(battery)
  return battery
}

type ControlledImage = {
  src: string
  onload: (() => void) | null
  onerror: (() => void) | null
}

function stubControlledImage(): ControlledImage[] {
  const images: ControlledImage[] = []

  class ControlledImageMock implements ControlledImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private currentSrc = ''

    constructor() {
      images.push(this)
    }

    get src(): string {
      return this.currentSrc
    }

    set src(value: string) {
      this.currentSrc = value
    }
  }

  vi.stubGlobal('Image', ControlledImageMock)
  return images
}

function stubAnimationFrameDriver() {
  let nextFrame: FrameRequestCallback | null = null
  const rafSpy = vi.fn((callback: FrameRequestCallback): number => {
    nextFrame = callback
    return 1
  })
  vi.stubGlobal('requestAnimationFrame', rafSpy)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())

  return {
    rafSpy,
    runNextFrame(timestamp: number) {
      const callback = nextFrame as FrameRequestCallback | null
      if (!callback) throw new Error('No animation frame is queued')
      nextFrame = null
      callback(timestamp)
    },
  }
}

function catSprite(container: HTMLElement, catId: string): HTMLImageElement {
  const sprite = container.querySelector<HTMLImageElement>(
    `[data-testid="cat-sprite"][data-cat-id="${catId}"]`,
  )
  if (!sprite) throw new Error(`Missing ${catId} sprite`)
  return sprite
}

function walkFrameUrls(catId: string): string[] {
  // Frames-30: the walk cycle is 30 frames (originals + m/n midpoints);
  // preload follows the canonical step order.
  return WALK_STEP_ORDER.map((frame) => `/cats/anim/${catId}/${frame}.png`)
}

function sitToWalkUrls(catId: string): string[] {
  // seated_to_stand + front_to_walk unique frames (tween wave 2 added
  // the sit_b1/sit_ab/sit_0a and turn_2 in-betweens; frames-30 burst 3
  // interleaved sit_m0..m5) + the walk cycle.
  return [
    `/cats/anim/${catId}/seated.png`,
    `/cats/anim/${catId}/sit_m5.png`,
    `/cats/anim/${catId}/sit_n5.png`,
    `/cats/anim/${catId}/sit_b1.png`,
    `/cats/anim/${catId}/sit_m4.png`,
    `/cats/anim/${catId}/sit_n4.png`,
    `/cats/anim/${catId}/sit_b.png`,
    `/cats/anim/${catId}/sit_m3.png`,
    `/cats/anim/${catId}/sit_n3.png`,
    `/cats/anim/${catId}/sit_ab.png`,
    `/cats/anim/${catId}/sit_m2.png`,
    `/cats/anim/${catId}/sit_n2.png`,
    `/cats/anim/${catId}/sit_a.png`,
    `/cats/anim/${catId}/sit_m1.png`,
    `/cats/anim/${catId}/sit_n1.png`,
    `/cats/anim/${catId}/sit_0a.png`,
    `/cats/anim/${catId}/sit_m0.png`,
    `/cats/anim/${catId}/sit_n0.png`,
    `/cats/anim/${catId}/stand.png`,
    `/cats/anim/${catId}/turn_n5.png`,
    `/cats/anim/${catId}/turn_2c.png`,
    `/cats/anim/${catId}/turn_2.png`,
    `/cats/anim/${catId}/turn_n4.png`,
    `/cats/anim/${catId}/turn_1b.png`,
    `/cats/anim/${catId}/turn_n3.png`,
    `/cats/anim/${catId}/turn.png`,
    `/cats/anim/${catId}/turn_n2.png`,
    `/cats/anim/${catId}/turn_0a.png`,
    `/cats/anim/${catId}/turn_n1.png`,
    `/cats/anim/${catId}/side_stand.png`,
    ...walkFrameUrls(catId),
  ]
}

/** Per-cat preload set size: 30 bridge frames (wave 5 added sit_n0..n5
    to seated_to_stand and turn_n1..n5 to front_to_walk on top of the
    burst-3/wave-1 midpoints) + 30 walk frames. */
const SIT_TO_WALK_SET_SIZE = 60

describe('CatLayer', () => {
  let originalMatchMedia: typeof window.matchMedia | undefined

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
    _resetCatWalkAnimationCacheForTests()
  })

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      // jsdom doesn't ship matchMedia by default — drop our stub if there
      // was nothing here originally.
      delete (window as unknown as { matchMedia?: unknown }).matchMedia
    }
    delete (navigator as unknown as { getBattery?: unknown }).getBattery
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('Given walk and sit activities, When their transitions are planned, Then both directions use the stop-and-turn bridge', () => {
    // arrange
    const leavingWalk = _catSequenceNamesForTransitionForTests('walk', 'sit')

    // act
    const resumingWalk = _catSequenceNamesForTransitionForTests('sit', 'walk')

    // assert
    expect(leavingWalk).toEqual(['walk_to_front', 'stand_to_seated'])
    expect(resumingWalk).toEqual(['seated_to_stand', 'front_to_walk'])
  })

  it('Given walking cats and fully loaded frame sets, When rAF advances, Then the thirty-frame walk sprites cycle', async () => {
    // arrange
    vi.useFakeTimers()
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': false,
    })
    const images = stubControlledImage()
    const frames = stubAnimationFrameDriver()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const { container } = render(<CatLayer placement="login" />)

    // assert — initial resting poses do not eagerly fetch walk frames.
    expect(images).toHaveLength(0)

    // act — the login settling beat expires and all three deterministic
    // solo rolls enter `walk`. Rich frames still stay off the critical path
    // until a real interaction; the two-frame fallback remains visible.
    act(() => frames.runNextFrame(2500))
    expect(images).toHaveLength(0)

    // act — the first interaction unlocks progressive enhancement. Cat sets
    // are staggered so one tap never starts a 66-image request burst.
    act(() => window.dispatchEvent(new Event('pointerdown')))
    act(() => vi.advanceTimersByTime(0))
    expect(images).toHaveLength(SIT_TO_WALK_SET_SIZE)
    act(() => vi.advanceTimersByTime(6000))
    expect(images).toHaveLength(2 * SIT_TO_WALK_SET_SIZE)
    act(() => vi.advanceTimersByTime(6000))

    // assert — all 12 frames per cat are requested once, while the
    // visible sprites remain on the built-in two-pose fallback.
    const expectedUrls = [
      ...sitToWalkUrls('panther'),
      ...sitToWalkUrls('mushu'),
      ...sitToWalkUrls('coco'),
    ]
    expect(images).toHaveLength(3 * SIT_TO_WALK_SET_SIZE)
    expect(new Set(images.map((image) => image.src))).toEqual(new Set(expectedUrls))
    const pendingSources: Array<string | null> = []
    for (const catId of ['panther', 'mushu', 'coco']) {
      const source = catSprite(container, catId).getAttribute('src')
      expect(source).toMatch(
        new RegExp(`^/cats/${catId}-walk_[ab]\\.png$`),
      )
      expect(catSprite(container, catId)).not.toHaveAttribute('data-walk-frame')
      pendingSources.push(source)
    }

    // act — pending warm-up still uses the existing two-pose rAF cycle.
    act(() => frames.runNextFrame(2600))
    act(() => frames.runNextFrame(2790))

    // assert
    for (const [index, catId] of ['panther', 'mushu', 'coco'].entries()) {
      const source = catSprite(container, catId).getAttribute('src')
      expect(source).toMatch(new RegExp(`^/cats/${catId}-walk_[ab]\\.png$`))
      expect(source).not.toBe(pendingSources[index])
    }

    // act — a cat only swaps after its complete 12-frame set is ready.
    await act(async () => {
      for (const image of images) image.onload?.()
      await Promise.resolve()
    })

    // assert — the reverse sit/turn bridge is visible before locomotion.
    for (const catId of ['panther', 'mushu', 'coco']) {
      expect(catSprite(container, catId).getAttribute('src')).toMatch(
        new RegExp(`^/cats/anim/${catId}/(?:seated|sit_(?:0a|ab|b1|[ab])|stand|turn(?:_2)?|side_stand)\\.png$`),
      )
    }

    // act — finish the bridge, then observe the full 38ms walk cycle.
    // The 3795 frame is the observation base: loadedSources and the wrap
    // comparison below both reference the state at this exact timestamp.
    act(() => frames.runNextFrame(3700))
    act(() => frames.runNextFrame(3795))

    // assert
    const loadedSources = ['panther', 'mushu', 'coco'].map((catId) => {
      const sprite = catSprite(container, catId)
      expect(sprite.getAttribute('src')).toMatch(
        // frames-30: any of the 30 walk-cycle frames (originals + m/n mids)
        new RegExp(`^/cats/anim/${catId}/walk_(?:0[1-9]|1[0-2]|m(?:0[1-9]|1[0-2])|n(?:0[13579]|11))\\.png$`),
      )
      expect(sprite).toHaveAttribute('data-walk-frame')
      return sprite.getAttribute('src')
    })

    // act — the same rAF/phase path advances at 38ms (frames-30 step),
    // visits all 30 step indices, and wraps to the frame at which
    // observation began.
    const observedFrames = [Number(catSprite(container, 'panther').dataset.walkFrame)]
    for (let timestamp = 3795 + 38; timestamp <= 3795 + 1140; timestamp += 38) {
      act(() => frames.runNextFrame(timestamp))
      observedFrames.push(Number(catSprite(container, 'panther').dataset.walkFrame))
    }

    // assert
    expect(new Set(observedFrames)).toEqual(
      new Set(Array.from({ length: 30 }, (_, index) => index + 1)),
    )
    expect(observedFrames[observedFrames.length - 1]).toBe(observedFrames[0])
    for (const [index, catId] of ['panther', 'mushu', 'coco'].entries()) {
      expect(catSprite(container, catId).getAttribute('src')).toBe(loadedSources[index])
    }
    expect(images).toHaveLength(3 * SIT_TO_WALK_SET_SIZE)
  })

  it('Given a walking cat that reaches a wall, When the bounce fires, Then it plants and plays the turn-around pivot — frames ladder through the frontal stand, the mirror flips exactly once on it, x freezes, and the new heading resumes after (2026-07-11)', async () => {
    // arrange — deterministic login rolls (Math.random 0.99 → every cat
    // walks 'R'); Mushu starts 10px from the right wall so he bounces
    // first while the others are still mid-scene. All frame sets load
    // up front so the rich pivot frames are observable.
    vi.useFakeTimers()
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': false,
    })
    const images = stubControlledImage()
    const frames = stubAnimationFrameDriver()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const { container } = render(<CatLayer placement="login" />)
    act(() => window.dispatchEvent(new Event('pointerdown')))
    act(() => vi.advanceTimersByTime(12_000))

    // act — settle → walk roll, then let the staggered per-cat preload
    // timers fire for the NEW sit→walk sets and feed every request.
    act(() => frames.runNextFrame(2500))
    act(() => vi.advanceTimersByTime(12_000))
    await act(async () => {
      for (const image of images) image.onload?.()
      await Promise.resolve()
    })

    // act — sample every 16ms across bridge → walk → bounce → pivot →
    // resume. Property assertions below; no timestamp is load-bearing.
    type Sample = { frame: string | null; transition: string; transform: string; x: string }
    const samples: Sample[] = []
    for (let timestamp = 2516; timestamp <= 4450; timestamp += 16) {
      act(() => frames.runNextFrame(timestamp))
      const sprite = catSprite(container, 'mushu')
      const flip = sprite.closest<HTMLElement>('[data-testid="cat-direction-flip"]')
      const outer = sprite.closest<HTMLElement>('[data-testid="cat-entrance-wrapper"]')
        ?.parentElement as HTMLElement
      samples.push({
        frame: sprite.getAttribute('data-anim-frame'),
        transition: flip?.style.transition ?? '',
        transform: flip?.style.transform ?? '',
        x: outer.style.transform,
      })
    }

    // assert — the pivot window is exactly the samples whose flip div
    // dropped its 220ms ease (the instant-flip contract).
    const firstPivot = samples.findIndex((s) => s.transition === 'none')
    expect(firstPivot).toBeGreaterThan(0)
    const pivot: Sample[] = []
    for (let i = firstPivot; i < samples.length && samples[i].transition === 'none'; i++) {
      pivot.push(samples[i])
    }

    // assert — (a) the pivot frame ladder: side→front→side through the
    // symmetric stand, in order, nothing else.
    const ladder = pivot
      .map((s) => s.frame)
      .filter((frame, i, all) => i === 0 || frame !== all[i - 1])
    // wave 5: the ladder carries the level-2 rungs — 19 rungs at 17-18ms,
    // still >= the 16ms sampling interval, so every rung is caught once.
    expect(ladder).toEqual([
      'turn_0a', 'turn_n2', 'turn', 'turn_n3', 'turn_1b', 'turn_n4',
      'turn_2', 'turn_2c', 'turn_n5',
      'stand',
      'turn_n5', 'turn_2c', 'turn_2', 'turn_n4', 'turn_1b', 'turn_n3',
      'turn', 'turn_n2', 'turn_0a',
    ])

    // assert — the mirror flips exactly once inside the pivot, ON the
    // frontal stand frame (scaleX(-1) while facing the old 'R' heading,
    // cleared for the new 'L'), so the seam is invisible.
    const flips = pivot.filter((s, i) => i > 0 && s.transform !== pivot[i - 1].transform)
    expect(flips).toHaveLength(1)
    expect(flips[0].frame).toBe('stand')
    expect(pivot[0].transform).toBe('scaleX(-1)')
    expect(pivot[pivot.length - 1].transform).toBe('')

    // assert — (b) the cat PLANTS: translateX is constant for the whole
    // pivot (it was walking right up to the bounce).
    expect(new Set(pivot.map((s) => s.x)).size).toBe(1)
    expect(samples[firstPivot - 1].x).not.toBe(pivot[0].x)

    // assert — (c) the pivot ends within the sampling window and normal
    // walking resumes on the new heading: walk frames come back, the
    // 220ms ease returns, and x moves left away from the wall.
    const after = samples.slice(firstPivot + pivot.length)
    expect(after.length).toBeGreaterThan(3)
    expect(after[0].transition).not.toBe('none')
    expect(after.some((s) => s.frame?.startsWith('walk_'))).toBe(true)
    const parseX = (transform: string) => Number(/translateX\(([-\d.]+)px\)/.exec(transform)?.[1])
    expect(parseX(after[after.length - 1].x)).toBeLessThan(parseX(pivot[0].x))
  })

  it('Given a walk-frame preload error, When the other requests settle, Then that cat keeps its built-in two-pose fallback', async () => {
    // arrange
    vi.useFakeTimers()
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': false,
    })
    const images = stubControlledImage()
    const frames = stubAnimationFrameDriver()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { container } = render(<CatLayer placement="login" />)
    act(() => frames.runNextFrame(2500))
    act(() => window.dispatchEvent(new Event('pointerdown')))
    act(() => vi.advanceTimersByTime(12_000))
    const failedFrame = images.find((image) => image.src.includes('/panther/'))
    expect(failedFrame).toBeDefined()
    expect(catSprite(container, 'panther').getAttribute('src')).toMatch(
      /^\/cats\/panther-walk_[ab]\.png$/,
    )

    // act — one Panther frame fails; every remaining request succeeds.
    await act(async () => {
      failedFrame?.onerror?.()
      for (const image of images) image.onload?.()
      await Promise.resolve()
    })

    // assert — Panther never risks a missing frame, while unaffected
    // cats progressively enhance after their complete sets load.
    expect(catSprite(container, 'panther').getAttribute('src')).toMatch(
      /^\/cats\/panther-walk_[ab]\.png$/,
    )
    expect(catSprite(container, 'panther')).not.toHaveAttribute('data-walk-frame')
    expect(catSprite(container, 'mushu').getAttribute('src')).toContain('/cats/anim/mushu/')
    expect(catSprite(container, 'coco').getAttribute('src')).toContain('/cats/anim/coco/')

    // act — unaffected cats complete the bridge and enter the rich walk
    // loop (wave 5 re-budgeted the sit chain 282→420ms, so the bridge ends
    // ~140ms later than before).
    act(() => frames.runNextFrame(4000))

    // assert
    expect(catSprite(container, 'mushu').getAttribute('src')).toMatch(
      // frames-30: the rich walk loop may land on an original OR a
      // midpoint (walk_mXX / walk_nXX) — all 30 exist on disk.
      /^\/cats\/anim\/mushu\/walk_(?:0[1-9]|1[0-2]|m(?:0[1-9]|1[0-2])|n(?:0[13579]|11))\.png$/,
    )
    expect(catSprite(container, 'coco').getAttribute('src')).toMatch(
      /^\/cats\/anim\/coco\/walk_(?:0[1-9]|1[0-2]|m(?:0[1-9]|1[0-2])|n(?:0[13579]|11))\.png$/,
    )

    // act — the failed cat still alternates the original pair as its
    // rAF phase advances; no animated URL is ever exposed for it.
    act(() => frames.runNextFrame(3795))
    const firstFallback = catSprite(container, 'panther').getAttribute('src')
    act(() => frames.runNextFrame(3890))
    const secondFallback = catSprite(container, 'panther').getAttribute('src')

    // assert
    expect(firstFallback).toMatch(/^\/cats\/panther-walk_[ab]\.png$/)
    expect(secondFallback).toMatch(/^\/cats\/panther-walk_[ab]\.png$/)
    expect(secondFallback).not.toBe(firstFallback)
  })

  it('given prefers-reduced-motion is false, when the layer mounts and timers advance ~5s, then 3 cat sprites render', () => {
    // arrange
    stubMatchMedia({ matches: false })
    vi.useFakeTimers()
    // Drive the rAF loop off the fake clock so time control is deterministic.
    // The production code calls bare requestAnimationFrame / cancelAnimationFrame
    // (no window. prefix), so the stubs need to land on globalThis.
    const rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number
    })
    const cancelSpy = vi.fn((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>))
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)

    // act
    const { container } = render(<CatLayer />)
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    // assert — three independent cat sprite imgs are rendered. iter-356.38
    // migrated the side-profile sprites from inline-SVG to raster PNGs
    // sliced from the user's sprite-sheet; each sprite carries
    // data-testid="cat-sprite" + data-cat-id so they're easy to count.
    const layer = container.firstElementChild
    expect(layer).not.toBeNull()
    const catSprites = layer!.querySelectorAll('[data-testid="cat-sprite"]')
    expect(catSprites.length).toBe(3)
  })

  it('given prefers-reduced-motion is true, when the layer mounts, then it does not schedule any animation frame', () => {
    // arrange
    stubMatchMedia({ matches: true })
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)

    // act
    render(<CatLayer />)

    // assert — the effect early-returns when reduced-motion matches, so
    // no rAF is ever queued. Cats render in their initial pose only.
    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('when the layer mounts, then the root element is aria-hidden so screen readers skip it', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert
    const layer = container.firstElementChild as HTMLElement | null
    expect(layer).not.toBeNull()
    expect(layer!.getAttribute('aria-hidden')).toBe('true')
  })

  it('when the layer mounts, then it carries pointer-events:none so it does not intercept clicks', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — the layer uses Tailwind's `pointer-events-none` class
    // (the production source of truth — no inline style for it).
    const layer = container.firstElementChild as HTMLElement | null
    expect(layer).not.toBeNull()
    expect(layer!.className).toMatch(/pointer-events-none/)
  })

  it('given login placement, when the layer mounts, then it is absolutely anchored below the z-10 form', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer placement="login" />)

    // assert
    const layer = container.firstElementChild as HTMLElement
    expect(layer.className).toMatch(/pointer-events-none/)
    expect(layer.className).toMatch(/\babsolute\b/)
    expect(layer.className).toMatch(/\bz-0\b/)
    expect(layer.className).not.toMatch(/\bfixed\b/)
    expect(layer.className).toMatch(/\bbottom-0\b/)
    expect(layer.className).toContain(
      'translate-y-[calc(-1*env(safe-area-inset-bottom,0px))]',
    )
  })

  it('Given reduced motion and login placement, When time advances, Then all three cats remain on static built-in sprites', () => {
    // arrange
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': true,
      '(prefers-reduced-data: reduce)': false,
    })
    const images = stubControlledImage()
    vi.useFakeTimers()
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)

    // act
    const { container } = render(<CatLayer placement="login" />)
    const initialSources = Array.from(
      container.querySelectorAll<HTMLImageElement>('[data-testid="cat-sprite"]'),
      (sprite) => sprite.getAttribute('src'),
    )
    act(() => vi.advanceTimersByTime(5000))

    // assert
    expect(container.querySelectorAll('[data-testid="cat-sprite"]')).toHaveLength(3)
    expect(rafSpy).not.toHaveBeenCalled()
    expect(container.firstElementChild).toHaveAttribute('data-motion', 'static')
    expect(images).toHaveLength(0)
    expect(
      Array.from(
        container.querySelectorAll<HTMLImageElement>('[data-testid="cat-sprite"]'),
        (sprite) => sprite.getAttribute('src'),
      ),
    ).toEqual(initialSources)
    expect(initialSources.every((src) => src?.startsWith('/cats/'))).toBe(true)
    expect(initialSources.every((src) => !src?.includes('/anim/'))).toBe(true)
  })

  it('Given login placement, When the household scene renders, Then it exposes playful props and grounded cats', () => {
    // arrange
    stubMatchMedia({ matches: false })
    vi.stubGlobal('requestAnimationFrame', vi.fn((_cb: FrameRequestCallback): number => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    // act
    const { container } = render(<CatLayer placement="login" />)

    // assert
    const layer = container.firstElementChild
    expect(layer).toHaveAttribute('data-scene-tempo', 'playful')
    expect(layer).toHaveAttribute('data-motion', 'animated')
    expect(container.querySelector('[data-testid="habitat-yarn"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="habitat-box"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="habitat-cat-tree"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="cat-ground-shadow"]')).toHaveLength(3)
    expect(container.querySelectorAll('.cat-micro-life')).toHaveLength(3)
  })

  it('Given app placement, When the scene renders, Then it keeps the calm tempo without login micro-life', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer placement="app" />)

    // assert
    expect(container.firstElementChild).toHaveAttribute('data-scene-tempo', 'calm')
    expect(container.querySelectorAll('.cat-micro-life')).toHaveLength(0)
  })

  // iter-356.30 (Pet Habitat slice 1): habitat objects render only when
  // CatLayer mounts (which happens iff authed && catsEnabled — gated in
  // App.tsx). The layer itself is the right granularity to pin: when the
  // gate flips off, App.tsx unmounts CatLayer entirely, which takes the
  // habitat with it.
  it('given the layer is mounted, when it renders, then the six habitat objects appear with stable test ids — yarn, mouse, bed, ledge, box, cat-tree (iter-356.41)', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — every habitat object has its own data-testid; iter-356.41
    // adds the cat tree (`habitat-cat-tree`) so cats can climb onto the
    // perch via the new `on_post` activity. iter-356.34 had dropped the
    // feather wand; that exclusion is preserved.
    const ids = [
      'habitat-yarn',
      'habitat-mouse',
      'habitat-bed',
      'habitat-ledge',
      'habitat-box',
      'habitat-cat-tree',
    ]
    for (const id of ids) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    }
    expect(container.querySelector('[data-testid="habitat-feather"]')).toBeNull()
  })

  it('given habitat objects render, when reduced-motion matches, then no animation classes are applied to them', () => {
    // arrange — reduced-motion ON: cats freeze; habitat is static art
    // by design and must not introduce ANY motion in this slice.
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — no habitat node carries Tailwind's animate-* utility
    // (slice 4 will add bed-bob and toy-jiggle, gated on
    // !prefers-reduced-motion). Today: zero motion at all.
    const nodes = container.querySelectorAll('[data-testid^="habitat-"]')
    expect(nodes.length).toBe(6)
    for (const n of nodes) {
      expect((n as HTMLElement).className).not.toMatch(/animate-/)
    }
  })

  it('given habitat objects render, when inspecting their order in the DOM, then they precede the cat sprites so cats stack on top', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — habitat <div>s appear before cat <div>s in DOM order. We
    // detect cat sprites via the absence of the habitat-* test id +
    // presence of an inner <svg>. Last habitat node's compareDocument
    // position vs first cat node should be FOLLOWING (cat is later).
    const layer = container.firstElementChild as HTMLElement
    const habitats = Array.from(
      layer.querySelectorAll('[data-testid^="habitat-"]'),
    )
    const directChildren = Array.from(layer.children) as HTMLElement[]
    // First non-habitat <div> child of the layer is the first cat
    const firstCat = directChildren.find(
      (el) => !el.hasAttribute('data-testid') || !el.getAttribute('data-testid')!.startsWith('habitat-'),
    )
    // Filter out the inline <style> tag (which is also a child).
    const firstCatBlock = directChildren.find(
      (el) => el.tagName !== 'STYLE' && !el.hasAttribute('data-testid'),
    )
    expect(habitats.length).toBe(6)
    expect(firstCatBlock).toBeDefined()
    // If the order is correct, last habitat precedes firstCatBlock
    const lastHabitat = habitats[habitats.length - 1] as HTMLElement
    const cmp = lastHabitat.compareDocumentPosition(firstCatBlock as Node)
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    expect(cmp & 4).toBe(4)
    // unused-but-referenced sanity (silence prettier noise; firstCat may match firstCatBlock):
    expect(firstCat ?? firstCatBlock).toBeDefined()
  })

  // iter-356-E (Slice E): perf gates — reduced-data + battery short-circuit
  // the rAF loop the same way reduced-motion does. The cats stay mounted
  // (brand identity is load-bearing per CLAUDE.md "Don't reintroduce")
  // — only the per-frame state-machine pauses.
  it('Given prefers-reduced-data is true, When the layer mounts, Then it neither animates nor requests walk frames (iter-356-E)', () => {
    // arrange — reduced-MOTION off, reduced-DATA on. Production hooks
    // each call matchMedia with their own query string; the per-query
    // stub returns true only for the data query.
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': true,
    })
    const images = stubControlledImage()
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)

    // act
    const { container } = render(<CatLayer />)

    // assert — rAF never queued; cats render in their initial pose only.
    expect(rafSpy).not.toHaveBeenCalled()
    // The brand stays visible: 3 sprites + the habitat both render.
    const sprites = container.querySelectorAll('[data-testid="cat-sprite"]')
    expect(sprites.length).toBe(3)
    expect(images).toHaveLength(0)
    for (const sprite of sprites) {
      expect(sprite.getAttribute('src')).not.toContain('/cats/anim/')
    }
  })

  it('given navigator.getBattery resolves with level<20% AND not charging, when the battery hook settles, then the rAF loop pauses (iter-356-E)', async () => {
    // arrange — reduced-motion off, reduced-data off, but battery is
    // critical AND the device isn't on power. Promise resolves after
    // mount; the useEffect cleanup must let the .then() flip the gate
    // via the cancelled flag (React 19 lint rule).
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': false,
    })
    stubGetBattery(0.1, false)
    const rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number
    })
    const cancelSpy = vi.fn((id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    )
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)

    // act — render, then flush microtasks so the getBattery() Promise
    // resolves and the gate flips. The effect re-runs and the rAF loop
    // tears down (cancelAnimationFrame fires on cleanup).
    render(<CatLayer />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // assert — once the gate flipped, the second-mount-after-gate-flip
    // never re-queued a frame. cancelAnimationFrame fired on the first
    // teardown, AND the count of rAFs never exceeds the initial pre-
    // gate-flip pump (a small finite number; we check teardown ran).
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('given battery level<20% but device IS charging, when the hook settles, then the gate stays open (cats keep animating, iter-356-E)', async () => {
    // arrange — low battery WITH charger plugged in is not a gate trip.
    // The user wants the cats; saving cycles is unwarranted on AC.
    stubMatchMediaPerQuery({
      '(prefers-reduced-motion: reduce)': false,
      '(prefers-reduced-data: reduce)': false,
    })
    stubGetBattery(0.1, true) // charging=true
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 1)
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    // act
    render(<CatLayer />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // assert — rAF was queued (animation runs) AND no teardown of the
    // loop happened from a gate flip after settle.
    expect(rafSpy).toHaveBeenCalled()
  })

  it('Given the entrance animation classes, When a cat renders, Then no cat-entrance-* class sits on the element that owns the direction flip (facing bug 2026-07-11)', () => {
    // arrange — the cat-arrive-* keyframes use `fill: both`, and a filled
    // CSS animation overrides inline `transform` on its own element
    // forever. When cat-entrance-panther lived on the flip div, its final
    // keyframe pinned Panther mirrored permanently, so she faced RIGHT
    // while walking left. jsdom cannot compute animation fill, so this
    // pin is structural: entrance class and direction transform must
    // live on different elements.
    stubMatchMedia({ matches: false })

    // act
    const { container } = render(<CatLayer placement="login" />)

    // assert
    const entranceEls = container.querySelectorAll('[class*="cat-entrance-"]')
    expect(entranceEls.length).toBeGreaterThan(0)
    for (const el of entranceEls) {
      const style = el.getAttribute('style') ?? ''
      expect(style).not.toMatch(/scaleX/)
      const flipChild = el.querySelector('[data-testid="cat-direction-flip"]')
      expect(flipChild).not.toBeNull()
    }
  })

  it('Given a roll that repeats the finished activity, When the anti-repeat wrapper runs, Then it re-rolls once and keeps a differing second roll (idle variation, 2026-07-11)', () => {
    // arrange — a fake roller whose first roll repeats the cat's current
    // activity ('sit') and whose second roll differs ('walk').
    const cat = { activity: 'sit' } as Parameters<typeof _rollWithoutImmediateRepeatForTests>[1]
    const rolls: string[] = []
    const roller = (c: typeof cat) => {
      const next = rolls.length === 0 ? 'sit' : 'walk'
      rolls.push(next)
      return { ...c, activity: next } as typeof cat
    }

    // act
    const result = _rollWithoutImmediateRepeatForTests(roller, cat, 0, 640)

    // assert — two rolls happened and the non-repeating one won.
    expect(rolls).toEqual(['sit', 'walk'])
    expect(result.activity).toBe('walk')
  })

  it('Given both re-rolls land on the same activity, When the wrapper settles, Then the repeat is accepted rather than looping forever', () => {
    // arrange
    const cat = { activity: 'sleep' } as Parameters<typeof _rollWithoutImmediateRepeatForTests>[1]
    let count = 0
    const roller = (c: typeof cat) => {
      count += 1
      return { ...c, activity: 'sleep' } as typeof cat
    }

    // act
    const result = _rollWithoutImmediateRepeatForTests(roller, cat, 0, 640)

    // assert — exactly two attempts, then acquiesce (cats DO nap twice).
    expect(count).toBe(2)
    expect(result.activity).toBe('sleep')
  })

  describe('frames-30 wave 3 — character beats', () => {
    it('Given a play bout entry, When the variant is rolled repeatedly, Then it rotates pounce/hop/tailhunt with no immediate repeat', () => {
      // arrange — scripted roll always takes the pool head.
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const cat = makeCatForTests({ activity: 'sit', boutVariant: null })

      // act
      const p1 = _setActivityForTests(cat, 'play', 3000, 1000)
      const p2 = _setActivityForTests(p1, 'play', 3000, 5000)
      const p3 = _setActivityForTests(p2, 'play', 3000, 9000)

      // assert — head of ['pounce','hop_bounce','tailhunt'] minus previous.
      expect(p1.boutVariant).toBe('pounce')
      expect(p2.boutVariant).toBe('hop_bounce')
      expect(p3.boutVariant).toBe('pounce')
    })

    it('Given a scared cat whose bout expires, When stepCats ticks past expiry, Then it recovers through shake_off before any new roll', () => {
      // arrange — scared since t=1000, expires at t=2000; tick at t=2100.
      vi.spyOn(Math, 'random').mockReturnValue(0.99)
      const scared = makeCatForTests({
        activity: 'scared',
        previousActivity: 'hiss',
        activityStartedAt: 1000,
        activityUntil: 2000,
      })

      // act
      const stepped = _stepCatsForTests([scared], 2100, 16, { current: 0 }, 'login')[0]

      // assert — the recovery beat interposes; its own expiry rolls next.
      expect(stepped.activity).toBe('shake_off')
    })

    it('Given the scared and hiss transitions, When their chains are read, Then scared backs away and hiss escalates into the arch', () => {
      // arrange / act / assert
      expect(_catSequenceNamesForTransitionForTests('walk', 'scared')).toEqual(['retreat'])
      expect(_catSequenceNamesForTransitionForTests('sit', 'hiss')).toEqual(['hiss_arch'])
      expect(_catSequenceNamesForTransitionForTests('walk', 'hiss')).toEqual(['walk_to_front', 'hiss_arch'])
    })
  })

  describe('frames-30 variant gaits + sleep life', () => {
    it('Given consecutive sprint bouts, When the gait variant is rolled, Then no bout repeats its predecessor and mushu never draws the dropped lope', () => {
      // arrange — script the roll to always take the first choice.
      vi.spyOn(Math, 'random').mockReturnValue(0)

      // act
      const pantherAfterRun = _rollGaitVariantForTests('panther', 'run')
      const pantherAfterBound = _rollGaitVariantForTests('panther', 'run_bound')
      const mushuAfterRun = _rollGaitVariantForTests('mushu', 'run')
      const mushuAfterBound = _rollGaitVariantForTests('mushu', 'run_bound')

      // assert — previous variant is excluded; mushu's pool is [run,
      // run_bound] because his lope frames were dropped.
      expect(pantherAfterRun).toBe('run_bound')
      expect(pantherAfterBound).not.toBe('run_bound')
      expect(mushuAfterRun).toBe('run_bound')
      expect(mushuAfterBound).toBe('run')
    })

    it('Given a bout entry, When setActivity runs, Then chase/flee roll a gait variant and calm activities clear it', () => {
      // arrange
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const cat = makeCatForTests({ activity: 'sit', boutVariant: null })

      // act — first sprint has no predecessor, so the scripted roll takes
      // the pool head ('run'); the follow-up sit clears the variant.
      const sprinting = _setActivityForTests(cat, 'chase', 3000, 1000)
      const settled = _setActivityForTests(sprinting, 'sit', 3000, 5000)

      // assert
      expect(sprinting.boutVariant).toBe('run')
      expect(settled.boutVariant).toBeNull()
    })

    it('Given wave-2 variant pools, When bout entries are scripted, Then groom rotates without repeats and the 2-pools roll true probabilities', () => {
      // arrange — groom: 3-pool with anti-repeat; pooped: 50/50; pounce: 20% miss
      const roll = vi.spyOn(Math, 'random')
      const cat = makeCatForTests({ activity: 'sit', boutVariant: null })

      // act / assert — groom pool head with no predecessor
      roll.mockReturnValue(0)
      const g1 = _setActivityForTests(cat, 'groom', 3000, 1000)
      expect(g1.boutVariant).toBe('groom_bout')
      // anti-repeat: same scripted roll from groom_bout skips to the chest bout
      const g2 = _setActivityForTests(g1, 'groom', 3000, 5000)
      expect(g2.boutVariant).toBe('groom_chest_bout')

      // pooped: < 0.5 strains, >= 0.5 stays plain (independent roll, no alternation)
      roll.mockReturnValue(0.4)
      expect(_setActivityForTests(cat, 'pooped', 4500, 1000).boutVariant).toBe('poop_squat_strained')
      roll.mockReturnValue(0.6)
      expect(_setActivityForTests(cat, 'pooped', 4500, 1000).boutVariant).toBe('poop_squat')

      // pounce: < 0.2 tumbles
      roll.mockReturnValue(0.1)
      expect(_setActivityForTests(cat, 'pounce', 3000, 1000).boutVariant).toBe('pounce_tumble')
      roll.mockReturnValue(0.5)
      expect(_setActivityForTests(cat, 'pounce', 3000, 1000).boutVariant).toBe('pounce')
    })

    it('Given a pouncing cat that rolled the miss, When the plan is built past the arc, Then tumble frames render instead of the landing', () => {
      // arrange — elapsed 700ms lands inside tumble_a/ab (windup 441 + arc 230 = 671)
      const cat = makeCatForTests({
        activity: 'pounce',
        previousActivity: 'pounce',
        boutVariant: 'pounce_tumble',
      })

      // act
      const missing = _animationPlanForForTests(cat, 700)

      // assert
      expect(['tumble_a', 'tumble_ab']).toContain(missing.frame)
    })

    it('Given a finished squat, When the pooped bout expires, Then the poop spawns AND the cat exits through the dirt-kick beat', () => {
      // arrange — a pooped cat past its activityUntil
      vi.spyOn(Math, 'random').mockReturnValue(0.6)
      const cat = makeCatForTests({
        activity: 'pooped',
        previousActivity: 'sit',
        activityStartedAt: 1000,
        activityUntil: 5000,
        poop: null,
      })

      // act
      const stepped = _stepCatsForTests([cat], 6000, 16, { current: 0 }, 'login')[0]

      // assert — ground poop spawned at expiry (same tick as before) and
      // the next beat is the kick, not a rolled solo
      expect(stepped.activity).toBe('kick_dirt')
      expect(stepped.poop).not.toBeNull()
    })

    it('Given a chasing cat with a rolled bound gallop, When the plan is built across a cycle, Then bound frames render instead of the base run ring', () => {
      // arrange — previousActivity chase ⇒ no transition chain; timeline
      // starts at 0 so plan time maps directly onto the 150ms cycle.
      const cat = makeCatForTests({
        activity: 'chase',
        previousActivity: 'chase',
        boutVariant: 'run_bound',
      })

      // act
      const early = _animationPlanForForTests(cat, 10)
      const mid = _animationPlanForForTests(cat, 40)

      // assert — [bound_a 38, bound_ab 37, ...]
      expect(early.frame).toBe('bound_a')
      expect(mid.frame).toBe('bound_ab')
    })

    it('Given a sleeping cat past its curl-down, When the plan samples the breathe loop, Then the curl inhales and exhales on the 1400ms beat', () => {
      // arrange
      const cat = makeCatForTests({ activity: 'sleep', previousActivity: 'sleep' })

      // act
      const inhale = _animationPlanForForTests(cat, 100)
      const exhale = _animationPlanForForTests(cat, 1500)
      const wrap = _animationPlanForForTests(cat, 2900)

      // assert — breath_a 0..1400, breath_b 1400..2800, loops.
      expect(inhale.frame).toBe('breath_a')
      expect(exhale.frame).toBe('breath_b')
      expect(wrap.frame).toBe('breath_a')
    })

    it('Given a mid-sleep dream twitch, When the idle plays, Then dream frames override the breathe loop and hand back to it', () => {
      // arrange
      const cat = makeCatForTests({
        activity: 'sleep',
        previousActivity: 'sleep',
        idleSequence: 'dream_twitch',
        idleSequenceStartedAt: 5000,
      })

      // act — dream_twitch is [dream_a 320, dream_b 320, dream_a 260, sleep 1]
      const twitchStart = _animationPlanForForTests(cat, 5100)
      const twitchFlinch = _animationPlanForForTests(cat, 5450)
      const afterIdle = _animationPlanForForTests(makeCatForTests({
        activity: 'sleep',
        previousActivity: 'sleep',
      }), 5450)

      // assert
      expect(twitchStart.frame).toBe('dream_a')
      expect(twitchFlinch.frame).toBe('dream_b')
      expect(afterIdle.frame).toMatch(/^breath_/)
    })
  })
})

describe('frames-30 wave 5 — engine behaviors', () => {
  it('Given a chase that expires, When stepCats rolls the next beat, Then the cat brakes through the skid_stop activity first', () => {
    // arrange — a chasing cat past its activityUntil
    const cat = {
      ...makeCatForTests({ id: 'panther' }),
      activity: 'chase' as const,
      previousActivity: 'walk' as const,
      activityStartedAt: 0,
      activityUntil: 900,
    }

    // act
    const out = _stepCatsForTests([cat], 1000, 16, { current: 0 }, 'app')

    // assert
    expect(out[0]!.activity).toBe('skid_stop')
  })

  it('Given the groom pool, When bouts are rolled repeatedly, Then all six targets appear and no bout repeats back-to-back', () => {
    // arrange
    let cat = { ...makeCatForTests({ id: 'mushu' }), boutVariant: null as string | null }
    const seen = new Set<string>()

    // act
    let prev: string | null = null
    for (let i = 0; i < 120; i++) {
      const rolled = _rollBoutVariantForTests(cat as never, 'groom')
      expect(rolled).not.toBe(prev)
      seen.add(String(rolled))
      prev = rolled
      cat = { ...cat, boutVariant: rolled }
    }

    // assert
    expect([...seen].sort()).toEqual([
      'gface_bout', 'groom_bout', 'groom_chest_bout',
      'groom_leg_bout', 'gshoulder_bout', 'gtail_bout',
    ])
  })

  it('Given nap rolls under scripted random, When sleep starts, Then curl/sprawl/belly follow the 50/25/25 thresholds', () => {
    // arrange / act / assert
    const cat = makeCatForTests({ id: 'coco' })
    const r = vi.spyOn(Math, 'random')
    r.mockReturnValue(0.4)
    expect(_rollBoutVariantForTests(cat as never, 'sleep')).toBeNull()
    r.mockReturnValue(0.6)
    expect(_rollBoutVariantForTests(cat as never, 'sleep')).toBe('sprawl_nap')
    r.mockReturnValue(0.9)
    expect(_rollBoutVariantForTests(cat as never, 'sleep')).toBe('belly_nap')
    r.mockRestore()
  })
})
