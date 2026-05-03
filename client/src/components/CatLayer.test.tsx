import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { CatLayer } from './CatLayer'

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

describe('CatLayer', () => {
  let originalMatchMedia: typeof window.matchMedia | undefined

  beforeEach(() => {
    originalMatchMedia = window.matchMedia
  })

  afterEach(() => {
    if (originalMatchMedia) {
      window.matchMedia = originalMatchMedia
    } else {
      // jsdom doesn't ship matchMedia by default — drop our stub if there
      // was nothing here originally.
      delete (window as unknown as { matchMedia?: unknown }).matchMedia
    }
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
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

    // assert — three independent cat sprite SVGs are rendered. The layer
    // root is the first child of the container. The iter-356.30 habitat
    // background also renders 6 decorative SVGs (yarn / mouse / feather
    // / bed / ledge / box) inside the layer; we count CAT sprites only
    // by filtering on the data-testid="habitat-*" markers.
    const layer = container.firstElementChild
    expect(layer).not.toBeNull()
    const allSvgs = layer!.querySelectorAll('svg')
    const habitatSvgs = layer!.querySelectorAll('[data-testid^="habitat-"] svg')
    expect(allSvgs.length - habitatSvgs.length).toBe(3)
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

  // iter-356.30 (Pet Habitat slice 1): habitat objects render only when
  // CatLayer mounts (which happens iff authed && catsEnabled — gated in
  // App.tsx). The layer itself is the right granularity to pin: when the
  // gate flips off, App.tsx unmounts CatLayer entirely, which takes the
  // habitat with it.
  it('given the layer is mounted, when it renders, then all six habitat objects appear with stable test ids', () => {
    // arrange
    stubMatchMedia({ matches: true })

    // act
    const { container } = render(<CatLayer />)

    // assert — every habitat object has its own data-testid for slice
    // 2's movement-zone targeting, and all six are present.
    const ids = [
      'habitat-yarn',
      'habitat-mouse',
      'habitat-feather',
      'habitat-bed',
      'habitat-ledge',
      'habitat-box',
    ]
    for (const id of ids) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull()
    }
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
    // If the order is correct, habitats[5] precedes firstCatBlock
    const lastHabitat = habitats[habitats.length - 1] as HTMLElement
    const cmp = lastHabitat.compareDocumentPosition(firstCatBlock as Node)
    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    expect(cmp & 4).toBe(4)
    // unused-but-referenced sanity (silence prettier noise; firstCat may match firstCatBlock):
    expect(firstCat ?? firstCatBlock).toBeDefined()
  })
})
