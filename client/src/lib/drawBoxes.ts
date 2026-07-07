import { log } from './log'
import type { Identity } from './identity'
import type { DetectionBox } from './types'

// drawBoxes runs on a hot redraw path (per live-event / per ClipModal frame),
// so a degenerate-dimension condition that persists must NOT log per frame.
// This once-flag latches on the first occurrence and re-arms once a healthy
// (positive-dimension) draw happens, so a transient layout glitch logs once
// and a recurrence after recovery logs again.
let _degenerateWarned = false

// Playroom Modern (identity-colored boxes): canvas can't resolve `var(...)`
// tokens, so callers resolve the event's identity color ONCE (per event, not
// per frame — see `resolveIdColor` below) and pass the concrete rgb/hex
// string through `opts.color`. jsdom's `getComputedStyle` returns an empty
// string for unset custom properties, so this always has a real fallback.
const FALLBACK_ID_COLOR = '#2f5fe0'

/**
 * Resolves an `Identity`'s CSS custom-property color (e.g.
 * `var(--color-id-person)`) to a concrete string `drawBoxes` can hand to
 * `CanvasRenderingContext2D.strokeStyle`. Falls back to a stable blue when
 * the property isn't defined (jsdom, or a token that hasn't landed yet).
 */
export function resolveIdColor(identity: Pick<Identity, 'colorVar'>): string {
  if (typeof document === 'undefined') return FALLBACK_ID_COLOR
  const match = /--[\w-]+/.exec(identity.colorVar)
  if (!match) return FALLBACK_ID_COLOR
  const value = getComputedStyle(document.documentElement).getPropertyValue(match[0]).trim()
  return value || FALLBACK_ID_COLOR
}

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
 *
 * `opts.color` (Playroom Modern, ADDITIVE — VideoTile's 5-arg call is
 * unchanged and keeps the red/emerald split above) lets a caller override
 * every box's stroke/fill with one resolved identity color for the whole
 * event — the `drawBoxes(ctx, canvas, video, boxes, personName)` shape
 * VideoTile uses is untouched.
 */
export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  boxes: ReadonlyArray<DetectionBox>,
  personName: string | null,
  opts?: { color?: string },
): void {
  const w = video.clientWidth
  const h = video.clientHeight
  // Degenerate dims (video not laid out yet, detached, or display:none) mean
  // every box scales to a zero/NaN rect — nothing draws and the operator sees
  // "boxes disappeared" with no clue why. WARN (once) when there ARE boxes to
  // draw but the surface has no size; bail rather than paint garbage.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    if (boxes.length > 0 && !_degenerateWarned) {
      _degenerateWarned = true
      log.warn('drawBoxes:degenerate-dims', {
        width: w,
        height: h,
        boxes: boxes.length,
      })
    }
    return
  }
  _degenerateWarned = false
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
    const color = opts?.color ?? (matched ? '#34d399' : '#ef4444')
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
