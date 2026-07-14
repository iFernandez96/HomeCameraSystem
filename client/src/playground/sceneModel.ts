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
// Everything here is side-effect-free and stdlib-only (engineering
// principle #2): geometry fns take scene dimensions as arguments.

export const CAT_WIDTH_PX = 44
export const CAT_HEIGHT_PX = Math.round(CAT_WIDTH_PX * 1.2)

export type AnchorTier = 'floor' | 'mid' | 'high'

export type SceneAnchor = {
  id: string
  tier: AnchorTier
  lane: PlaygroundLane
  /** Percent-of-width anchor for the spot's left edge (matches the
      furniture layout's clamp grammar so cats land ON their prop). */
  xPct: number
  /** Footprint width in px — feeds the same right-edge clamp the
      furniture uses, so cat and prop clamp identically on narrow
      screens. */
  widthPx: number
  /** Elevation above the lane's floor line, as a fraction of scene
      height. 0 = standing on the floor. */
  elevPct: number
  /** All playground anchors hold exactly one cat. */
  capacity: 1
  /** Transition played on arrival (perches hop up via jump_post). */
  entrySequence: CatAnimSequenceName | null
  /** Anchor ids a floor-bound cat traverses IN ORDER before this
      one — the tree is the on/off ramp to the shelf superhighway. */
  approach: readonly string[]
  /** Dropped from the beat pool under the sub-480px compact layout
      (the furniture it sits on is hidden there). */
  compactHidden?: boolean
}

const anchor = (
  id: string,
  tier: AnchorTier,
  lane: PlaygroundLane,
  xPct: number,
  widthPx: number,
  elevPct: number,
  entrySequence: CatAnimSequenceName | null = null,
  approach: readonly string[] = [],
  compactHidden = false,
): SceneAnchor => ({
  id,
  tier,
  lane,
  xPct,
  widthPx,
  elevPct,
  capacity: 1,
  entrySequence,
  approach,
  compactHidden,
})

export const SCENE_ANCHORS: readonly SceneAnchor[] = [
  // --- floor tier -----------------------------------------------------------
  anchor('rug', 'floor', 'front', 50, 120, 0), // Mushu's open-floor home (Beach Dweller)
  anchor('food_bowl', 'floor', 'front', 80, 36, 0),
  anchor('water_bowl', 'floor', 'front', 87, 36, 0),
  anchor('tunnel_nook', 'floor', 'front', 42, 100, 0), // Coco's semi-concealed home (Bush Dweller)
  anchor('tunnel_inside', 'floor', 'front', 34, 100, 0), // the hidden dive
  anchor('litter_box', 'floor', 'front', 93, 64, 0),
  anchor('scratch_post', 'floor', 'front', 22, 52, 0),
  // --- mid tier -------------------------------------------------------------
  anchor('tree_mid', 'mid', 'front', 4, 120, 0.14, 'jump_post'),
  anchor('hammock', 'mid', 'front', 66, 88, 0.08, 'jump_post'),
  // --- high tier ------------------------------------------------------------
  anchor('tree_top', 'high', 'front', 4, 120, 0.28, 'jump_post', ['tree_mid']), // Panther's home (Tree Dweller)
  anchor('shelf_1', 'high', 'back', 44, 40, 0.34, 'jump_post', ['tree_mid', 'tree_top'], true),
  anchor('shelf_2', 'high', 'back', 49, 40, 0.34, 'jump_post', ['tree_mid', 'tree_top'], true),
  anchor('shelf_3', 'high', 'back', 54, 40, 0.34, 'jump_post', ['tree_mid', 'tree_top'], true),
  anchor('window_perch', 'high', 'back', 8, 96, 0.24, 'jump_post', ['tree_mid']), // Cat TV
]

const ANCHOR_BY_ID: ReadonlyMap<string, SceneAnchor> = new Map(
  SCENE_ANCHORS.map((a) => [a.id, a]),
)

export function anchorById(id: string): SceneAnchor {
  const found = ANCHOR_BY_ID.get(id)
  if (!found) throw new Error(`unknown playground anchor: ${id}`)
  return found
}

/** Anchors available under the current layout (compact hides the
    wall-shelf superhighway alongside its furniture). */
export function anchorsForLayout(compact: boolean): readonly SceneAnchor[] {
  return compact ? SCENE_ANCHORS.filter((a) => !a.compactHidden) : SCENE_ANCHORS
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

/** The cat's target left-edge x for an anchor: the anchor's clamped
    footprint center, minus half a cat, re-clamped to the walls. Uses
    the same percent-with-px-clamps grammar as the furniture layout. */
export function anchorCatX(anchorOrId: SceneAnchor | string, sceneW: number): number {
  const a = typeof anchorOrId === 'string' ? anchorById(anchorOrId) : anchorOrId
  const left = clampNumber(
    (a.xPct / 100) * sceneW,
    SCENE_MARGIN_PX,
    sceneW - a.widthPx - SCENE_MARGIN_PX,
  )
  return clampCatX(left + a.widthPx / 2 - CAT_WIDTH_PX / 2, sceneW)
}

/** The cat's target bottom-offset y for an anchor (lane floor plus
    the anchor's elevation). */
export function anchorCatY(anchorOrId: SceneAnchor | string, sceneH: number): number {
  const a = typeof anchorOrId === 'string' ? anchorById(anchorOrId) : anchorOrId
  return laneFloorY(a.lane, sceneH) + Math.round(a.elevPct * sceneH)
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

// === Furniture layout (visual) ==============================================
// Moved here from pages/Playground.tsx (Slice A) so anchors and props
// derive from ONE source of truth; PlaygroundProps renders it.

export type FurnitureSpot = {
  name: PlaygroundFurnitureName
  lane: PlaygroundLane
  xPct: number
  widthPx: number
  compactHidden?: boolean
}

export const FURNITURE_LAYOUT: readonly FurnitureSpot[] = [
  { name: 'window_perch', lane: 'back', xPct: 8, widthPx: 96 },
  { name: 'bird_feeder', lane: 'back', xPct: 30, widthPx: 48 },
  { name: 'wall_shelf_set', lane: 'back', xPct: 46, widthPx: 120, compactHidden: true },
  { name: 'plant', lane: 'back', xPct: 78, widthPx: 56, compactHidden: true },
  { name: 'cat_tree_deluxe', lane: 'front', xPct: 4, widthPx: 120 },
  { name: 'scratching_post', lane: 'front', xPct: 22, widthPx: 52 },
  { name: 'tunnel', lane: 'front', xPct: 34, widthPx: 100 },
  { name: 'rug', lane: 'front', xPct: 50, widthPx: 120 },
  { name: 'hammock', lane: 'front', xPct: 66, widthPx: 88 },
  { name: 'food_bowl', lane: 'front', xPct: 80, widthPx: 36 },
  { name: 'water_bowl', lane: 'front', xPct: 87, widthPx: 36 },
  { name: 'litter_box', lane: 'front', xPct: 93, widthPx: 64 },
]

/** Where an ambient bird perches: the feeder's clamped center, a
    touch above the back-lane floor (the feeder hangs). */
export function feederPerchPoint(sceneW: number, sceneH: number): { x: number; y: number } {
  const feeder = FURNITURE_LAYOUT.find((f) => f.name === 'bird_feeder')
  const left = clampNumber(
    ((feeder?.xPct ?? 30) / 100) * sceneW,
    SCENE_MARGIN_PX,
    sceneW - (feeder?.widthPx ?? 48) - SCENE_MARGIN_PX,
  )
  return {
    x: left + (feeder?.widthPx ?? 48) / 2,
    y: laneFloorY('back', sceneH) + Math.round(0.16 * sceneH),
  }
}
