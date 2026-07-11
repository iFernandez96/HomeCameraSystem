import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  CatLayer,
  _catSequenceNamesForTransitionForTests,
  _resetCatWalkAnimationCacheForTests,
} from './CatLayer'

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
  return Array.from(
    { length: 12 },
    (_, frame) => `/cats/anim/${catId}/walk_${String(frame + 1).padStart(2, '0')}.png`,
  )
}

function sitToWalkUrls(catId: string): string[] {
  return [
    `/cats/anim/${catId}/seated.png`,
    `/cats/anim/${catId}/sit_b.png`,
    `/cats/anim/${catId}/sit_a.png`,
    `/cats/anim/${catId}/stand.png`,
    `/cats/anim/${catId}/turn.png`,
    `/cats/anim/${catId}/side_stand.png`,
    ...walkFrameUrls(catId),
  ]
}

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

  it('Given walking cats and fully loaded frame sets, When rAF advances, Then the twelve-frame walk sprites cycle', async () => {
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
    // are staggered so one tap never starts a 36-image request burst.
    act(() => window.dispatchEvent(new Event('pointerdown')))
    act(() => vi.advanceTimersByTime(0))
    expect(images).toHaveLength(18)
    act(() => vi.advanceTimersByTime(6000))
    expect(images).toHaveLength(36)
    act(() => vi.advanceTimersByTime(6000))

    // assert — all 12 frames per cat are requested once, while the
    // visible sprites remain on the built-in two-pose fallback.
    const expectedUrls = [
      ...sitToWalkUrls('panther'),
      ...sitToWalkUrls('mushu'),
      ...sitToWalkUrls('coco'),
    ]
    expect(images).toHaveLength(54)
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
        new RegExp(`^/cats/anim/${catId}/(?:seated|sit_[ab]|stand|turn|side_stand)\\.png$`),
      )
    }

    // act — finish the bridge, then observe the full 95ms walk cycle.
    act(() => frames.runNextFrame(3700))

    // assert
    const loadedSources = ['panther', 'mushu', 'coco'].map((catId) => {
      const sprite = catSprite(container, catId)
      expect(sprite.getAttribute('src')).toMatch(
        new RegExp(`^/cats/anim/${catId}/walk_(?:0[1-9]|1[0-2])\\.png$`),
      )
      expect(sprite).toHaveAttribute('data-walk-frame')
      return sprite.getAttribute('src')
    })

    // act — the same rAF/phase path advances at 95ms, visits all 12
    // frame numbers, and wraps to the frame at which observation began.
    const observedFrames = [Number(catSprite(container, 'panther').dataset.walkFrame)]
    for (let timestamp = 3795; timestamp <= 4840; timestamp += 95) {
      act(() => frames.runNextFrame(timestamp))
      observedFrames.push(Number(catSprite(container, 'panther').dataset.walkFrame))
    }

    // assert
    expect(new Set(observedFrames)).toEqual(
      new Set(Array.from({ length: 12 }, (_, index) => index + 1)),
    )
    expect(observedFrames[observedFrames.length - 1]).toBe(observedFrames[0])
    for (const [index, catId] of ['panther', 'mushu', 'coco'].entries()) {
      expect(catSprite(container, catId).getAttribute('src')).toBe(loadedSources[index])
    }
    expect(images).toHaveLength(54)
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

    // act — unaffected cats complete the bridge and enter the rich walk loop.
    act(() => frames.runNextFrame(3700))

    // assert
    expect(catSprite(container, 'mushu').getAttribute('src')).toMatch(
      /^\/cats\/anim\/mushu\/walk_(?:0[1-9]|1[0-2])\.png$/,
    )
    expect(catSprite(container, 'coco').getAttribute('src')).toMatch(
      /^\/cats\/anim\/coco\/walk_(?:0[1-9]|1[0-2])\.png$/,
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
})
