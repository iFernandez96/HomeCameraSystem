import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { _resetImageCacheForTests } from '../components/catImageCache'
import {
  PLAYGROUND_FURNITURE_NAMES,
  PLAYGROUND_PRELOAD_WAVE_1,
} from '../playground/playgroundAssets'
import { Playground } from './Playground'

// Per-query matchMedia stub (same helper shape as CatLayer.test.tsx):
// the perf-gate hooks and the compact-layout hook each call matchMedia
// with their own query string.
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

const DEFAULT_QUERIES = {
  '(prefers-reduced-motion: reduce)': false,
  '(prefers-reduced-data: reduce)': false,
  '(max-width: 479px)': false,
}

describe('Playground page (Slice A scaffolding)', () => {
  let originalMatchMedia: typeof window.matchMedia | undefined

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
    _resetImageCacheForTests()
  })

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('Given wave-1 furniture art still loading, When the page mounts, Then the paw-spinner loading state shows and no furniture renders yet', () => {
    // arrange
    stubMatchMediaPerQuery(DEFAULT_QUERIES)
    const images = stubControlledImage()

    // act
    render(<Playground />)

    // assert — wave-1 preload started (12 furniture URLs) but nothing
    // settled, so the gate holds on the brand spinner.
    expect(images).toHaveLength(PLAYGROUND_PRELOAD_WAVE_1.length)
    expect(
      screen.getByRole('status', { name: /setting up the playground/i }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('playground-scene')).not.toBeInTheDocument()
  })

  it('Given wave-1 art loads, When the gate opens, Then all 12 furniture pieces render with stable testids across both depth lanes', async () => {
    // arrange
    stubMatchMediaPerQuery(DEFAULT_QUERIES)
    const images = stubControlledImage()
    render(<Playground />)

    // act — every wave-1 image loads.
    await act(async () => {
      for (const image of [...images]) image.onload?.()
      await Promise.resolve()
    })

    // assert — the scene replaces the spinner; each manifest furniture
    // name has its diorama node, split across back and front lanes.
    expect(screen.queryByTestId('playground-loading')).not.toBeInTheDocument()
    const scene = screen.getByTestId('playground-scene')
    expect(scene).toHaveAttribute('data-motion', 'animated')
    for (const name of PLAYGROUND_FURNITURE_NAMES) {
      expect(screen.getByTestId(`playground-furniture-${name}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('playground-furniture-window_perch')).toHaveAttribute(
      'data-lane',
      'back',
    )
    expect(screen.getByTestId('playground-furniture-cat_tree_deluxe')).toHaveAttribute(
      'data-lane',
      'front',
    )
  })

  it('Given the art set is still generating (every image 404s), When wave 1 fails, Then the scene still renders instead of stalling on the spinner', async () => {
    // arrange
    stubMatchMediaPerQuery(DEFAULT_QUERIES)
    const images = stubControlledImage()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<Playground />)

    // act — the first error fails the whole preload set.
    await act(async () => {
      images[0].onerror?.()
      await Promise.resolve()
    })

    // assert — graceful degrade: the room appears (imgs self-hide via
    // onError at the element level); the page never looks broken.
    expect(screen.getByTestId('playground-scene')).toBeInTheDocument()
    expect(screen.queryByTestId('playground-loading')).not.toBeInTheDocument()
  })

  it('Given prefers-reduced-motion, When the scene renders, Then it is marked static and no animation frame is ever scheduled', async () => {
    // arrange
    stubMatchMediaPerQuery({
      ...DEFAULT_QUERIES,
      '(prefers-reduced-motion: reduce)': true,
    })
    const images = stubControlledImage()
    const rafSpy = vi.fn((_cb: FrameRequestCallback): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    render(<Playground />)

    // act
    await act(async () => {
      for (const image of [...images]) image.onload?.()
      await Promise.resolve()
    })

    // assert — Slice A is a static diorama; under reduced motion the
    // scene self-declares static and schedules zero rAF work.
    expect(screen.getByTestId('playground-scene')).toHaveAttribute(
      'data-motion',
      'static',
    )
    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('Given a compact viewport under 480px, When the scene renders, Then the plant and wall shelf set are dropped while the rest of the room remains', async () => {
    // arrange
    stubMatchMediaPerQuery({
      ...DEFAULT_QUERIES,
      '(max-width: 479px)': true,
    })
    const images = stubControlledImage()
    render(<Playground />)

    // act
    await act(async () => {
      for (const image of [...images]) image.onload?.()
      await Promise.resolve()
    })

    // assert
    expect(screen.queryByTestId('playground-furniture-plant')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('playground-furniture-wall_shelf_set'),
    ).not.toBeInTheDocument()
    for (const name of PLAYGROUND_FURNITURE_NAMES) {
      if (name === 'plant' || name === 'wall_shelf_set') continue
      expect(screen.getByTestId(`playground-furniture-${name}`)).toBeInTheDocument()
    }
  })
})
