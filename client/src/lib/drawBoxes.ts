import type { DetectionBox } from './types'

/**
 * Renders normalized [0,1] detection boxes onto `canvas`, sized to the
 * `video` element's current client rect. Used by both the live
 * `VideoTile` (per-event redraw) and the `ClipModal` overlay (static
 * for the clip's duration). Single source of truth for box geometry +
 * color so the live and recorded surfaces never drift apart.
 *
 * The matched-person bbox (the highest-confidence `label === 'person'`
 * box when `personName` is non-null) is drawn in emerald; everything
 * else in red. Colors are intentionally hex-literal, not tokenized:
 * the canvas surface paints over a video frame, where token
 * resolution is moot — the box must read against arbitrary pixels.
 */
export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  boxes: ReadonlyArray<DetectionBox>,
  personName: string | null,
): void {
  const w = video.clientWidth
  const h = video.clientHeight
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.clearRect(0, 0, w, h)
  if (boxes.length === 0) return
  ctx.lineWidth = 2
  ctx.font = '600 12px sans-serif'

  let matchedIdx = -1
  if (personName) {
    let bestScore = -1
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (b.label === 'person' && b.score > bestScore) {
        bestScore = b.score
        matchedIdx = i
      }
    }
  }

  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    const matched = i === matchedIdx
    const color = matched ? '#34d399' : '#ef4444'
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h)
    const label =
      matched && personName
        ? `${personName} ${(b.score * 100).toFixed(0)}%`
        : `${b.label} ${(b.score * 100).toFixed(0)}%`
    ctx.fillText(label, b.x * w, Math.max(12, b.y * h - 4))
  }
}
