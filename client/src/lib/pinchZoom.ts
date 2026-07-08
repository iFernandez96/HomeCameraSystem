/**
 * pinchZoom — pure math for the fullscreen live-view pinch-to-zoom
 * (fullscreen contract item 7, 2026-07-07).
 *
 * Model: the zoomed layer renders with
 *   transform: translate(tx px, ty px) scale(scale)
 * and transform-origin at the viewport center. scale=1/tx=0/ty=0 is
 * identity. Translation is clamped so the scaled content always covers
 * the viewport (no black edges revealed by panning), which also makes
 * pinching back down glide home to identity.
 *
 * Kept side-effect free (no DOM) so it unit-tests offline — the
 * gesture handlers in Watch.tsx own the DOM writes.
 */

export interface ZoomState {
  scale: number
  tx: number
  ty: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 5

export const ZOOM_IDENTITY: ZoomState = { scale: 1, tx: 0, ty: 0 }

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Clamp scale to [ZOOM_MIN, ZOOM_MAX] and translation so the scaled
 * content still covers the whole viewport (vw × vh). */
export function clampZoom(s: ZoomState, vw: number, vh: number): ZoomState {
  const scale = clamp(s.scale, ZOOM_MIN, ZOOM_MAX)
  const maxTx = ((scale - 1) * vw) / 2
  const maxTy = ((scale - 1) * vh) / 2
  return {
    scale,
    tx: clamp(s.tx, -maxTx, maxTx),
    ty: clamp(s.ty, -maxTy, maxTy),
  }
}

/**
 * Apply a pinch step: `ratio` is (current finger distance / distance at
 * the previous step), (fx, fy) is the pinch focal point in viewport
 * coordinates. The content point under the focal point stays put:
 * a screen point p maps as p = center + (c - center)·k + t, so holding
 * p fixed while k → k' gives t' = (p - center) - ((p - center) - t)·(k'/k).
 */
export function pinchUpdate(
  prev: ZoomState,
  fx: number,
  fy: number,
  ratio: number,
  vw: number,
  vh: number,
): ZoomState {
  const nextScale = clamp(prev.scale * ratio, ZOOM_MIN, ZOOM_MAX)
  const r = nextScale / prev.scale
  const cx = vw / 2
  const cy = vh / 2
  const tx = fx - cx - (fx - cx - prev.tx) * r
  const ty = fy - cy - (fy - cy - prev.ty) * r
  return clampZoom({ scale: nextScale, tx, ty }, vw, vh)
}

/** Apply a one-finger pan step (dx, dy in viewport px). */
export function panUpdate(
  prev: ZoomState,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): ZoomState {
  return clampZoom({ scale: prev.scale, tx: prev.tx + dx, ty: prev.ty + dy }, vw, vh)
}

export function isZoomed(s: ZoomState): boolean {
  return s.scale > 1.001
}

export function toTransform(s: ZoomState): string {
  return isZoomed(s) || s.tx !== 0 || s.ty !== 0
    ? `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`
    : ''
}
