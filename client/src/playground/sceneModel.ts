import type { CatAnimSequenceName } from '../components/catAnimSequences'
import type { PlaygroundFurnitureName } from './playgroundAssets'
import {
  BACK_LANE_FLOOR_PCT,
  FRONT_LANE_FLOOR_PCT,
  SCENE_MARGIN_PX,
  type PlaygroundLane,
} from './playgroundTypes'

// Playground Slice B — the pure scene model. Anchors are the named
// places a cat can travel to and occupy, arranged in the design doc's
// THREE vertical tiers (Jackson Galaxy verticality):
//   floor — rug, bowls, tunnel (Coco's nook), litter, scratching post
//   mid   — cat tree platform, hammock
//   high  — the wall-shelf superhighway (three individually occupiable
//           rest stops) + tree top + window perch ("Cat TV")
// Reachability is anchor METADATA: elevated anchors declare the
// `approach` waypoints a floor cat must traverse first, so a cat
// routes floor → tree → shelf instead of levitating.
//
// FURNITURE PACKING (Slice D rework): placement is a packing problem,
// not independent percentages — the old percent-x layout piled every
// prop into the center-left at phone widths. Each lane packs its props
// left→right in a deliberate composition order with a minimum breathing
// gap; when the row can't fit, low-priority props DROP first, then the
// remainder scales down. Leftover space distributes into weighted gaps
// (bowls cluster as a feeding corner; zones breathe apart). Anchors
// derive their geometry from the SAME packed rects, so cats always land
// ON their furniture at every width. Pinned by the bounding-box
// intersection test in sceneModel.test.ts.
//
// Everything here is side-effect-free and stdlib-only (engineering
// principle #2): geometry fns take scene dimensions as arguments.

export const CAT_WIDTH_PX = 44
export const CAT_HEIGHT_PX = Math.round(CAT_WIDTH_PX * 1.2)

/** Minimum breathing gap between same-lane furniture (px). */
export const FURNITURE_GAP_PX = 8

/** Natural PNG dimensions of the exported furniture masters — the
    source of truth for rendered heights (height = width × h/w), so
    anchor elevations track the art at every render scale. */
export const FURNITURE_NATURAL: Record<PlaygroundFurnitureName, { w: number; h: number }> = {
  cat_tree_deluxe: { w: 190, h: 256 },
  wall_shelf_set: { w: 270, h: 200 },
  tunnel: { w: 228, h: 110 },
  hammock: { w: 239, h: 120 },
  window_perch: { w: 157, h: 170 },
  scratching_post: { w: 82, h: 150 },
  rug: { w: 149, h: 70 },
  food_bowl: { w: 111, h: 56 },
  water_bowl: { w: 97, h: 52 },
  litter_box: { w: 106, h: 90 },
  plant: { w: 81, h: 110 },
  bird_feeder: { w: 79, h: 110 },
}

export type PackedSpot = {
  name: PlaygroundFurnitureName
  lane: PlaygroundLane
  /** Left edge in scene px. */
  left: number
  /** Rendered width in px (base width × the lane's fit scale). */
  width: number
  /** Rendered height in px (width × natural aspect). */
  height: number
  /** Render elevation above the lane's floor line, as a fraction of
      scene height (wall-mounted back-wall props hang in the upper
      third; floor props sit at 0). */
  elevPct: number
}

type LaneSlot = {
  name: PlaygroundFurnitureName
  /** Base render width at full scale. */
  width: number
  elevPct: number
  /** Extra-space weight for the gap AFTER this prop (composition:
      big weights separate zones, tiny weights cluster pairs). */
  gapAfter: number
}

const slot = (
  name: PlaygroundFurnitureName,
  width: number,
  elevPct: number,
  gapAfter: number,
): LaneSlot => ({ name, width, elevPct, gapAfter })

// The room, left→right (design doc composition): the cat tree anchors
// the left end with its activity corner (scratching post), the tunnel +
// rug form the cozy middle (Coco's nook, Mushu's beach), the hammock
// rests right-of-center, the bowls cluster as a feeding corner, and the
// litter box tucks into the far edge.
const FRONT_SLOTS: readonly LaneSlot[] = [
  slot('cat_tree_deluxe', 120, 0, 1),
  slot('scratching_post', 52, 0, 2),
  slot('tunnel', 100, 0, 2),
  slot('rug', 110, 0, 2),
  slot('hammock', 88, 0, 3),
  slot('food_bowl', 36, 0, 0.3),
  slot('water_bowl', 34, 0, 3),
  slot('litter_box', 60, 0, 0),
]

// Back wall, upper third: window ("Cat TV") left, the feeder beside it,
// the shelf superhighway right-of-center, a floor plant at the edge.
const BACK_SLOTS: readonly LaneSlot[] = [
  slot('window_perch', 96, 0.1, 1),
  slot('bird_feeder', 46, 0.18, 2),
  slot('wall_shelf_set', 150, 0.22, 1.5),
  slot('plant', 50, 0, 0),
]

/** Dropped first (in order) when a lane can't fit, and always dropped
    under the sub-480px compact layout. */
const FRONT_DROPPABLE: readonly PlaygroundFurnitureName[] = ['scratching_post', 'hammock']
const BACK_DROPPABLE: readonly PlaygroundFurnitureName[] = ['plant', 'wall_shelf_set']

/** Below this fit scale, drop the next droppable prop instead of
    shrinking everything into dollhouse furniture. */
const DROP_BELOW_SCALE = 0.72
const MIN_FIT_SCALE = 0.5

function packLane(
  slots: readonly LaneSlot[],
  droppable: readonly PlaygroundFurnitureName[],
  lane: PlaygroundLane,
  sceneW: number,
  compact: boolean,
): PackedSpot[] {
  const inner = Math.max(120, sceneW - 2 * SCENE_MARGIN_PX)
  let kept = compact ? slots.filter((s) => !droppable.includes(s.name)) : [...slots]
  let dropIndex = 0
  const fitScale = () => {
    const gaps = FURNITURE_GAP_PX * (kept.length - 1)
    const sum = kept.reduce((total, s) => total + s.width, 0)
    return Math.min(1, (inner - gaps) / sum)
  }
  while (fitScale() < DROP_BELOW_SCALE && dropIndex < droppable.length) {
    const name = droppable[dropIndex++]
    kept = kept.filter((s) => s.name !== name)
  }
  const scale = Math.max(fitScale(), MIN_FIT_SCALE)
  const widths = kept.map((s) => Math.round(s.width * scale))
  const usedByProps = widths.reduce((total, w) => total + w, 0)
  const minGaps = FURNITURE_GAP_PX * (kept.length - 1)
  const extra = Math.max(0, inner - usedByProps - minGaps)
  const weightTotal = kept.slice(0, -1).reduce((total, s) => total + s.gapAfter, 0)
  let cursor = SCENE_MARGIN_PX
  return kept.map((s, i) => {
    const width = widths[i]
    const natural = FURNITURE_NATURAL[s.name]
    const spot: PackedSpot = {
      name: s.name,
      lane,
      left: Math.round(cursor),
      width,
      height: Math.round(width * (natural.h / natural.w)),
      elevPct: s.elevPct,
    }
    const grow = weightTotal > 0 ? (extra * s.gapAfter) / weightTotal : 0
    cursor += width + FURNITURE_GAP_PX + grow
    return spot
  })
}

let packCacheKey = ''
let packCacheValue: readonly PackedSpot[] = []

/** The packed furniture layout for a scene width. Pure and memoized on
    its inputs (called per anchor per tick by the travel math). */
export function packFurnitureLayout(sceneW: number, compact: boolean): readonly PackedSpot[] {
  const key = `${Math.round(sceneW)}|${compact}`
  if (key === packCacheKey) return packCacheValue
  packCacheValue = [
    ...packLane(BACK_SLOTS, BACK_DROPPABLE, 'back', sceneW, compact),
    ...packLane(FRONT_SLOTS, FRONT_DROPPABLE, 'front', sceneW, compact),
  ]
  packCacheKey = key
  return packCacheValue
}

export function packedSpotFor(
  name: PlaygroundFurnitureName,
  sceneW: number,
  compact: boolean,
): PackedSpot | null {
  return packFurnitureLayout(sceneW, compact).find((s) => s.name === name) ?? null
}

// === Anchors =================================================================

export type AnchorTier = 'floor' | 'mid' | 'high'

export type SceneAnchor = {
  id: string
  tier: AnchorTier
  lane: PlaygroundLane
  /** The furniture the anchor lives on — geometry derives from its
      packed rect so cat and prop can never drift apart. */
  furniture: PlaygroundFurnitureName
  /** Cat-center position within the furniture rect, 0..1 of its width. */
  fracX: number
  /** Cat-feet elevation within the furniture rect, 0..1 of its rendered
      height (0 = standing on the floor beside/inside it). */
  elevFrac: number
  /** All playground anchors hold exactly one cat. */
  capacity: 1
  /** Transition played on arrival (perches hop up via jump_post). */
  entrySequence: CatAnimSequenceName | null
  /** Anchor ids a floor-bound cat traverses IN ORDER before this
      one — the tree is the on/off ramp to the shelf superhighway. */
  approach: readonly string[]
}

const anchor = (
  id: string,
  tier: AnchorTier,
  lane: PlaygroundLane,
  furniture: PlaygroundFurnitureName,
  fracX: number,
  elevFrac: number,
  entrySequence: CatAnimSequenceName | null = null,
  approach: readonly string[] = [],
): SceneAnchor => ({
  id,
  tier,
  lane,
  furniture,
  fracX,
  elevFrac,
  capacity: 1,
  entrySequence,
  approach,
})

export const SCENE_ANCHORS: readonly SceneAnchor[] = [
  // --- floor tier -----------------------------------------------------------
  anchor('rug', 'floor', 'front', 'rug', 0.5, 0), // Mushu's open-floor home (Beach Dweller)
  anchor('food_bowl', 'floor', 'front', 'food_bowl', 0.5, 0),
  anchor('water_bowl', 'floor', 'front', 'water_bowl', 0.5, 0),
  anchor('tunnel_nook', 'floor', 'front', 'tunnel', 0.82, 0), // Coco's semi-concealed home (Bush Dweller)
  anchor('tunnel_inside', 'floor', 'front', 'tunnel', 0.5, 0), // the hidden dive
  anchor('litter_box', 'floor', 'front', 'litter_box', 0.5, 0),
  anchor('scratch_post', 'floor', 'front', 'scratching_post', 0.5, 0),
  // --- mid tier -------------------------------------------------------------
  anchor('tree_mid', 'mid', 'front', 'cat_tree_deluxe', 0.28, 0.46, 'jump_post'),
  anchor('hammock', 'mid', 'front', 'hammock', 0.5, 0.5, 'jump_post'),
  // --- high tier ------------------------------------------------------------
  anchor('tree_top', 'high', 'front', 'cat_tree_deluxe', 0.6, 0.8, 'jump_post', ['tree_mid']), // Panther's home (Tree Dweller)
  anchor('shelf_1', 'high', 'back', 'wall_shelf_set', 0.2, 0.2, 'jump_post', ['tree_mid', 'tree_top']),
  anchor('shelf_2', 'high', 'back', 'wall_shelf_set', 0.52, 0.5, 'jump_post', ['tree_mid', 'tree_top']),
  anchor('shelf_3', 'high', 'back', 'wall_shelf_set', 0.82, 0.8, 'jump_post', ['tree_mid', 'tree_top']),
  anchor('window_perch', 'high', 'back', 'window_perch', 0.5, 0.5, 'jump_post', ['tree_mid']), // Cat TV
]

const ANCHOR_BY_ID: ReadonlyMap<string, SceneAnchor> = new Map(
  SCENE_ANCHORS.map((a) => [a.id, a]),
)

export function anchorById(id: string): SceneAnchor {
  const found = ANCHOR_BY_ID.get(id)
  if (!found) throw new Error(`unknown playground anchor: ${id}`)
  return found
}

/** Anchors available under the current layout: an anchor exists only
    while its furniture survived the packing (compact and very narrow
    layouts drop the shelf superhighway, plant, post, and hammock). */
export function anchorsForLayout(sceneW: number, compact: boolean): readonly SceneAnchor[] {
  return SCENE_ANCHORS.filter(
    (a) => packedSpotFor(a.furniture, sceneW, compact) !== null,
  )
}

/** Personality home zones (design doc dweller taxonomy). */
export const HOME_ANCHOR = {
  panther: 'tree_top',
  mushu: 'rug',
  coco: 'tunnel_nook',
} as const

// === Geometry ================================================================

/** Bottom offset (px from scene bottom) of a lane's floor line. */
export function laneFloorY(lane: PlaygroundLane, sceneH: number): number {
  const floorPct = lane === 'front' ? FRONT_LANE_FLOOR_PCT : BACK_LANE_FLOOR_PCT
  return Math.round((1 - floorPct) * sceneH)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Clamp a cat's left-edge x inside the scene walls. */
export function clampCatX(x: number, sceneW: number): number {
  return clampNumber(x, SCENE_MARGIN_PX, sceneW - CAT_WIDTH_PX - SCENE_MARGIN_PX)
}

/** A dropped prop's stand-in rect (a cat can be en route to an anchor
    when a resize drops its furniture): mid-scene on the floor, so the
    cat strolls somewhere sane and re-rolls. */
function fallbackRect(sceneW: number): PackedSpot {
  return {
    name: 'rug',
    lane: 'front',
    left: Math.round(sceneW / 2 - CAT_WIDTH_PX),
    width: CAT_WIDTH_PX * 2,
    height: 0,
    elevPct: 0,
  }
}

function anchorRect(a: SceneAnchor, sceneW: number, compact: boolean): PackedSpot {
  return packedSpotFor(a.furniture, sceneW, compact) ?? fallbackRect(sceneW)
}

/** The cat's target left-edge x for an anchor: its fractional spot on
    the packed furniture rect, re-clamped to the walls. */
export function anchorCatX(
  anchorOrId: SceneAnchor | string,
  sceneW: number,
  compact = false,
): number {
  const a = typeof anchorOrId === 'string' ? anchorById(anchorOrId) : anchorOrId
  const rect = anchorRect(a, sceneW, compact)
  return clampCatX(rect.left + rect.width * a.fracX - CAT_WIDTH_PX / 2, sceneW)
}

/** The cat's target bottom-offset y for an anchor: the lane floor plus
    the furniture's wall elevation plus the anchor's spot on the art
    (fraction of the prop's RENDERED height, so cats stay on their
    platforms at every render scale). */
export function anchorCatY(
  anchorOrId: SceneAnchor | string,
  sceneW: number,
  sceneH: number,
  compact = false,
): number {
  const a = typeof anchorOrId === 'string' ? anchorById(anchorOrId) : anchorOrId
  const rect = anchorRect(a, sceneW, compact)
  return (
    laneFloorY(a.lane, sceneH) +
    Math.round(rect.elevPct * sceneH) +
    Math.round(a.elevFrac * rect.height)
  )
}

/** Full travel route to an anchor: its approach waypoints then the
    anchor itself (floor → tree → shelf). Floor anchors route direct. */
export function routeTo(anchorId: string): readonly string[] {
  const a = anchorById(anchorId)
  return [...a.approach, a.id]
}

// === Occupancy ===============================================================

/** The structural slice of PlayCat that occupancy math needs — kept
    minimal so this module never imports the state shape. */
export type AnchorOccupant = {
  id: string
  anchorId: string | null
  targetAnchor: string | null
}

/** Who holds an anchor: the cat sitting AT it, or the cat EN ROUTE to
    it (targetAnchor doubles as a reservation so two cats never race
    for the same capacity-1 spot). Waypoints along a route are not
    reserved — cats may pass through the tree while another rests up top. */
export function occupantOf<C extends AnchorOccupant>(
  cats: readonly C[],
  anchorId: string,
): C | null {
  return (
    cats.find((c) => c.anchorId === anchorId || c.targetAnchor === anchorId) ?? null
  )
}

export function isAnchorFree(
  cats: readonly AnchorOccupant[],
  anchorId: string,
  selfId?: string,
): boolean {
  const holder = occupantOf(cats, anchorId)
  return holder === null || holder.id === selfId
}

/** Where an ambient bird perches: the packed feeder's tray. */
export function feederPerchPoint(
  sceneW: number,
  sceneH: number,
  compact = false,
): { x: number; y: number } {
  const feeder = packedSpotFor('bird_feeder', sceneW, compact)
  if (!feeder) {
    return { x: sceneW * 0.3, y: laneFloorY('back', sceneH) + Math.round(0.16 * sceneH) }
  }
  return {
    x: feeder.left + feeder.width / 2,
    y:
      laneFloorY('back', sceneH) +
      Math.round(feeder.elevPct * sceneH) +
      Math.round(feeder.height * 0.55),
  }
}
