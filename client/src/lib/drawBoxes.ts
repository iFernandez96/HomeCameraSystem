import { log } from './log'
import type { Identity } from './identity'
import type { DetectionBox } from './types'

// drawBoxes runs on a hot redraw path (per live-event / per ClipModal frame),
// so a degenerate-dimension condition that persists must NOT log per frame.
// This once-flag latches on the first occurrence and re-arms once a healthy
// (positive-dimension) draw happens, so a transient layout glitch logs once
// and a recurrence after recovery logs again.
let _degenerateWarned = false

// Playroom Modern (identity-colored boxes): canvas cannot resolve CSS
// custom-property tokens, so callers resolve the event's identity color ONCE
// (per event, not per frame — see `resolveIdColor` below) and pass the
// concrete rgb/hex string through `opts.color`. (Comment deliberately avoids
// spelling the bracketed token form: Tailwind v4's scanner reads comments too
// and was emitting a junk utility rule + build warning from it — perf A5.) jsdom's `getComputedStyle` returns an empty
// string for unset custom properties, so this always has a real fallback.
const FALLBACK_ID_COLOR = '#2f5fe0'

type MediaRect = {
  x: number
  y: number
  w: number
  h: number
}

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

function renderedMediaRect(video: HTMLVideoElement, w: number, h: number): MediaRect {
  const intrinsicW = video.videoWidth
  const intrinsicH = video.videoHeight
  if (
    !Number.isFinite(intrinsicW) ||
    !Number.isFinite(intrinsicH) ||
    intrinsicW <= 0 ||
    intrinsicH <= 0
  ) {
    return { x: 0, y: 0, w, h }
  }

  const objectFit =
    typeof getComputedStyle === 'function' ? getComputedStyle(video).objectFit : video.style.objectFit
  const fit = objectFit || video.style.objectFit || 'fill'
  if (fit !== 'contain' && fit !== 'cover' && fit !== 'scale-down') {
    return { x: 0, y: 0, w, h }
  }

  const scaleContain = Math.min(w / intrinsicW, h / intrinsicH)
  const scale =
    fit === 'cover'
      ? Math.max(w / intrinsicW, h / intrinsicH)
      : fit === 'scale-down'
        ? Math.min(1, scaleContain)
        : scaleContain
  const mediaW = intrinsicW * scale
  const mediaH = intrinsicH * scale
  return {
    x: (w - mediaW) / 2,
    y: (h - mediaH) / 2,
    w: mediaW,
    h: mediaH,
  }
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
  const media = renderedMediaRect(video, w, h)
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
    const x = media.x + b.x * media.w
    const y = media.y + b.y * media.h
    const bw = b.w * media.w
    const bh = b.h * media.h
    ctx.strokeRect(x, y, bw, bh)
    const label =
      matched && personName
        ? `${personName} ${(b.score * 100).toFixed(0)}%`
        : `${b.label} ${(b.score * 100).toFixed(0)}%`
    ctx.fillText(label, x, Math.max(12, y - 4))
  }
}
