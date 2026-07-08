import { describe, expect, it } from 'vitest'
import {
  ZOOM_IDENTITY,
  ZOOM_MAX,
  clampZoom,
  isZoomed,
  panUpdate,
  pinchUpdate,
  toTransform,
} from './pinchZoom'

const VW = 800
const VH = 400

describe('pinchZoom', () => {
  it('Given identity state, When pinching out around the center, Then scale grows and translation stays zero', () => {
    // arrange
    const prev = ZOOM_IDENTITY

    // act
    const next = pinchUpdate(prev, VW / 2, VH / 2, 2, VW, VH)

    // assert
    expect(next.scale).toBe(2)
    expect(next.tx).toBe(0)
    expect(next.ty).toBe(0)
  })

  it('Given identity state, When pinching out around an off-center focal point, Then the content under the focal point stays put (translation compensates)', () => {
    // arrange — focal point at the top-left quarter.
    const fx = VW / 4
    const fy = VH / 4

    // act
    const next = pinchUpdate(ZOOM_IDENTITY, fx, fy, 2, VW, VH)

    // assert — p = center + (p - center)·k + t must still equal p:
    // t = (p - center)·(1 - k)
    expect(next.tx).toBeCloseTo((fx - VW / 2) * (1 - 2))
    expect(next.ty).toBeCloseTo((fy - VH / 2) * (1 - 2))
  })

  it('Given a zoomed state, When pinching far beyond the max, Then scale clamps to ZOOM_MAX', () => {
    // arrange / act
    const next = pinchUpdate({ scale: 4, tx: 0, ty: 0 }, VW / 2, VH / 2, 10, VW, VH)

    // assert
    expect(next.scale).toBe(ZOOM_MAX)
  })

  it('Given a zoomed state, When pinching all the way back in, Then the state glides home to exact identity', () => {
    // arrange
    const zoomed = pinchUpdate(ZOOM_IDENTITY, 100, 100, 3, VW, VH)

    // act — huge pinch-in ratio undershoots 1 and clamps.
    const next = pinchUpdate(zoomed, 300, 200, 0.01, VW, VH)

    // assert — scale 1 forces tx/ty clamp bounds to zero.
    expect(next).toEqual(ZOOM_IDENTITY)
  })

  it('Given a 2x zoom, When panning past the content edge, Then translation clamps so no off-content gap is revealed', () => {
    // arrange — at scale 2, max |tx| is vw/2, max |ty| is vh/2.
    const prev = { scale: 2, tx: 0, ty: 0 }

    // act
    const next = panUpdate(prev, 10_000, -10_000, VW, VH)

    // assert
    expect(next.tx).toBe(VW / 2)
    expect(next.ty).toBe(-VH / 2)
  })

  it('Given an out-of-bounds state, When clamped, Then both scale and translation land inside the legal envelope', () => {
    // arrange / act
    const next = clampZoom({ scale: 0.2, tx: 999, ty: -999 }, VW, VH)

    // assert — toBeCloseTo, not toEqual: clamping a negative overshoot
    // against a zero bound produces -0, which is the same value.
    expect(next.scale).toBe(1)
    expect(next.tx).toBeCloseTo(0)
    expect(next.ty).toBeCloseTo(0)
  })

  it('Given identity, When rendered, Then toTransform is the empty string (no residual transform on the video layer)', () => {
    // arrange / act / assert
    expect(toTransform(ZOOM_IDENTITY)).toBe('')
    expect(isZoomed(ZOOM_IDENTITY)).toBe(false)
  })

  it('Given a zoomed state, When rendered, Then toTransform emits translate-then-scale in px units', () => {
    // arrange / act / assert
    expect(toTransform({ scale: 2, tx: -10, ty: 5 })).toBe(
      'translate(-10px, 5px) scale(2)',
    )
  })
})
