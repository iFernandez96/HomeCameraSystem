import { describe, expect, it } from 'vitest'
import { drawBoxes, resolveIdColor } from './drawBoxes'
import type { DetectionBox } from './types'

/**
 * Playroom Modern (identity-colored boxes). `HTMLCanvasElement.getContext`
 * is stubbed to return null globally (src/test/setup.ts — jsdom has no
 * canvas backend), so tests build a minimal fake 2D-context object rather
 * than reading a real one back. drawBoxes only calls a handful of methods
 * plus assigns strokeStyle/fillStyle, so the fake only needs to satisfy
 * those calls.
 */
function fakeCtx() {
  return {
    clearRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
  } as unknown as CanvasRenderingContext2D
}

function fakeVideo(width = 100, height = 100): HTMLVideoElement {
  const video = document.createElement('video')
  Object.defineProperty(video, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(video, 'clientHeight', { value: height, configurable: true })
  return video
}

function setIntrinsicVideoSize(video: HTMLVideoElement, width: number, height: number): void {
  Object.defineProperty(video, 'videoWidth', { value: width, configurable: true })
  Object.defineProperty(video, 'videoHeight', { value: height, configurable: true })
}

function box(overrides: Partial<DetectionBox> = {}): DetectionBox {
  return { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'person', score: 0.9, ...overrides }
}

describe('drawBoxes — opts.color (identity-colored boxes)', () => {
  it('Given opts.color, When a box is drawn, Then strokeStyle and fillStyle use the passed color', () => {
    // arrange
    const ctx = fakeCtx()
    const canvas = document.createElement('canvas')
    const video = fakeVideo()
    // act
    drawBoxes(ctx, canvas, video, [box()], 'Someone', { color: '#123abc' })
    // assert
    expect(ctx.strokeStyle).toBe('#123abc')
    expect(ctx.fillStyle).toBe('#123abc')
  })

  it('Given no opts, When a matched person box is drawn, Then the legacy emerald color is preserved', () => {
    // arrange
    const ctx = fakeCtx()
    const canvas = document.createElement('canvas')
    const video = fakeVideo()
    // act
    drawBoxes(ctx, canvas, video, [box()], 'Israel')
    // assert
    expect(ctx.strokeStyle).toBe('#34d399')
  })

  it('Given no opts, When an unmatched box is drawn, Then the legacy red color is preserved', () => {
    // arrange
    const ctx = fakeCtx()
    const canvas = document.createElement('canvas')
    const video = fakeVideo()
    // act
    drawBoxes(ctx, canvas, video, [box({ label: 'cat' })], null)
    // assert
    expect(ctx.strokeStyle).toBe('#ef4444')
  })
})

describe('drawBoxes — object-fit geometry', () => {
  it('Given a 16:9 clip object-contained in a portrait event viewer, Then boxes map into the letterboxed video rect', () => {
    // arrange
    const calls: Array<[number, number, number, number]> = []
    const ctx = {
      ...fakeCtx(),
      strokeRect: (x: number, y: number, w: number, h: number) => {
        calls.push([x, y, w, h])
      },
    } as unknown as CanvasRenderingContext2D
    const canvas = document.createElement('canvas')
    const video = fakeVideo(400, 800)
    setIntrinsicVideoSize(video, 1920, 1080)
    video.style.objectFit = 'contain'

    // act
    drawBoxes(ctx, canvas, video, [box()], null)

    // assert — 16:9 content inside 400x800 is 400x225, vertically centered.
    expect(calls[0]).toEqual([40, 310, 80, 45])
  })

  it('Given a 16:9 clip object-covered in a portrait surface, Then boxes account for cropped media outside the element', () => {
    // arrange
    const calls: Array<[number, number, number, number]> = []
    const ctx = {
      ...fakeCtx(),
      strokeRect: (x: number, y: number, w: number, h: number) => {
        calls.push([x, y, w, h])
      },
    } as unknown as CanvasRenderingContext2D
    const canvas = document.createElement('canvas')
    const video = fakeVideo(400, 800)
    setIntrinsicVideoSize(video, 1920, 1080)
    video.style.objectFit = 'cover'

    // act
    drawBoxes(ctx, canvas, video, [box()], null)

    // assert — cover scales to 1422.222px wide and crops both sides.
    expect(calls[0][0]).toBeCloseTo(-368.889, 3)
    expect(calls[0][1]).toBeCloseTo(80, 3)
    expect(calls[0][2]).toBeCloseTo(284.444, 3)
    expect(calls[0][3]).toBeCloseTo(160, 3)
  })
})

describe('resolveIdColor', () => {
  it('Given jsdom has no computed custom-property value, When resolving, Then the stable fallback color is returned', () => {
    // arrange / act
    const color = resolveIdColor({ colorVar: 'var(--color-id-person)' })
    // assert
    expect(color).toBe('#2f5fe0')
  })

  it('Given a colorVar with no CSS custom property inside it, When resolving, Then the fallback color is returned', () => {
    // arrange / act
    const color = resolveIdColor({ colorVar: 'not-a-var()' })
    // assert
    expect(color).toBe('#2f5fe0')
  })
})
