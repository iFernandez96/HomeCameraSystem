import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CatParticles, type CatParticleType } from './CatParticles'

/**
 * iter-356.8 — CatParticles coverage. Test-coverage-auditor (iter-356.5)
 * flagged this file as untested (~230 lines, 0 tests). Pins:
 *   - All 5 particle types render correctly
 *   - LIFETIME_MS (2400) self-cleanup
 *   - prefers-reduced-motion gate (renders nothing)
 *   - aria-hidden on the wrapper (decorative)
 *   - count clamping to >= 1
 */

function mockReducedMotion(reduced: boolean) {
  const fn = (query: string): MediaQueryList =>
    ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList
  vi.stubGlobal('matchMedia', fn)
}

beforeEach(() => {
  mockReducedMotion(false)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('CatParticles', () => {
  test.each<[CatParticleType, RegExp]>([
    ['hearts', /💕|❤️/u],
    ['dust', /•/u],
    ['sparkles', /✨/u],
    ['anger', /💢/u],
    ['zzz', /z/u],
  ])(
    'given type=%s, when rendered with count=3, then 3 glyphs of expected character class appear',
    (type, glyphRe) => {
      // arrange + act
      const { container } = render(
        <CatParticles type={type} x={10} y={10} count={3} />,
      )

      // assert
      const spans = container.querySelectorAll('span')
      expect(spans.length).toBe(3)
      spans.forEach((s) => {
        expect(s.textContent ?? '').toMatch(glyphRe)
      })
    },
  )

  test('given count is below 1, when rendered, then floors to a single particle', () => {
    // arrange + act
    const { container } = render(
      <CatParticles type="hearts" x={0} y={0} count={0} />,
    )

    // assert
    expect(container.querySelectorAll('span').length).toBe(1)
  })

  test('given LIFETIME_MS (2400ms) elapses, then component renders nothing', () => {
    // arrange
    vi.useFakeTimers()
    const { container, rerender } = render(
      <CatParticles type="hearts" x={0} y={0} count={3} />,
    )
    expect(container.querySelectorAll('span').length).toBe(3)

    // act — advance past LIFETIME_MS
    vi.advanceTimersByTime(2500)
    rerender(<CatParticles type="hearts" x={0} y={0} count={3} />)

    // assert — component returns null after the timeout fires
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(container.firstChild).toBeNull()
  })

  test('given prefers-reduced-motion is true, when rendered, then returns null immediately', () => {
    // arrange
    mockReducedMotion(true)

    // act
    const { container } = render(
      <CatParticles type="hearts" x={0} y={0} count={5} />,
    )

    // assert — no spans, no wrapper div
    expect(container.firstChild).toBeNull()
  })

  test('when CatParticles renders, then the wrapper div carries aria-hidden=true', () => {
    // arrange + act
    const { container } = render(
      <CatParticles type="sparkles" x={5} y={5} count={2} />,
    )

    // assert
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).not.toBeNull()
    expect(wrapper.getAttribute('aria-hidden')).toBe('true')
  })

  test('given hearts particles render, then each particle is positioned absolutely with pointer-events:none', () => {
    // arrange + act
    const { container } = render(
      <CatParticles type="hearts" x={20} y={20} count={4} />,
    )

    // assert
    const spans = container.querySelectorAll('span')
    spans.forEach((s) => {
      expect(s.style.position).toBe('absolute')
      expect(s.style.pointerEvents).toBe('none')
    })
  })

  test('given anger type renders, then particles use --color-danger token', () => {
    // arrange + act
    const { container } = render(
      <CatParticles type="anger" x={0} y={0} count={2} />,
    )

    // assert
    const spans = container.querySelectorAll('span')
    spans.forEach((s) => {
      expect(s.style.color).toBe('var(--color-danger)')
    })
  })

  test('given zzz type renders, then particles use --color-text-secondary token', () => {
    // arrange + act
    const { container } = render(
      <CatParticles type="zzz" x={0} y={0} count={3} />,
    )

    // assert
    const spans = container.querySelectorAll('span')
    spans.forEach((s) => {
      expect(s.style.color).toBe('var(--color-text-secondary)')
    })
  })
})
