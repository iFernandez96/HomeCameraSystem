import type { Zone, ZonePoint } from './types'

const EPSILON = 1e-9

function orientation(a: ZonePoint, b: ZonePoint, c: ZonePoint): number {
  return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1])
}

function onSegment(a: ZonePoint, b: ZonePoint, point: ZonePoint): boolean {
  return (
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[0] + EPSILON >= Math.min(a[0], b[0]) &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON &&
    point[1] + EPSILON >= Math.min(a[1], b[1]) &&
    Math.abs(orientation(a, b, point)) <= EPSILON
  )
}

export function segmentsIntersect(
  a1: ZonePoint,
  a2: ZonePoint,
  b1: ZonePoint,
  b2: ZonePoint,
): boolean {
  const o1 = orientation(a1, a2, b1)
  const o2 = orientation(a1, a2, b2)
  const o3 = orientation(b1, b2, a1)
  const o4 = orientation(b1, b2, a2)
  if ((o1 > EPSILON) !== (o2 > EPSILON) && (o3 > EPSILON) !== (o4 > EPSILON)) return true
  return (
    onSegment(a1, a2, b1) ||
    onSegment(a1, a2, b2) ||
    onSegment(b1, b2, a1) ||
    onSegment(b1, b2, a2)
  )
}

export function pointInsidePolygon(point: ZonePoint, polygon: Zone): boolean {
  if (polygon.length < 3) return false
  for (let index = 0; index < polygon.length; index += 1) {
    if (onSegment(polygon[index], polygon[(index + 1) % polygon.length], point)) return true
  }
  const [x, y] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function edges(points: ZonePoint[], closed: boolean): Array<[ZonePoint, ZonePoint]> {
  const result: Array<[ZonePoint, ZonePoint]> = []
  for (let index = 0; index + 1 < points.length; index += 1) {
    result.push([points[index], points[index + 1]])
  }
  if (closed && points.length > 2) result.push([points[points.length - 1], points[0]])
  return result
}

/** Covers containment in either direction and every line/edge intersection. */
export function pathOverlapsPrivacyMasks(
  points: ZonePoint[],
  closed: boolean,
  masks: Zone[],
): boolean {
  if (points.length === 0) return false
  for (const mask of masks) {
    if (points.some((point) => pointInsidePolygon(point, mask))) return true
    if (closed && mask.some((point) => pointInsidePolygon(point, points))) return true
    const pathEdges = edges(points, closed)
    const maskEdges = edges(mask, true)
    if (pathEdges.some(([a1, a2]) => maskEdges.some(([b1, b2]) => segmentsIntersect(a1, a2, b1, b2)))) return true
  }
  return false
}
