import { describe, expect, it } from 'vitest'
import {
  CAT_WIDTH_PX,
  FURNITURE_GAP_PX,
  HOME_ANCHOR,
  SCENE_ANCHORS,
  TREE_MID_ELEV_FRAC,
  TREE_MID_FRAC_X,
  TREE_TOP_ELEV_FRAC,
  TREE_TOP_FRAC_X,
  WINDOW_PERCH_ELEV_FRAC,
  WINDOW_PERCH_FRAC_X,
  anchorById,
  anchorCatX,
  anchorCatY,
  anchorsForLayout,
  clampCatX,
  isAnchorFree,
  laneFloorY,
  occupantOf,
  packFurnitureLayout,
  packedSpotFor,
  routeTo,
  type AnchorOccupant,
  type PackedSpot,
} from './sceneModel'
import { SCENE_MARGIN_PX } from './playgroundTypes'

const W = 800
const H = 400

function occupant(id: string, anchorId: string | null, targetAnchor: string | null = null): AnchorOccupant {
  return { id, anchorId, targetAnchor }
}

describe('sceneModel occupancy', () => {
  it('Given a cat sitting AT an anchor, When occupancy is checked, Then the anchor is held and not free for others', () => {
    // arrange
    const cats = [occupant('panther', 'tree_top')]

    // act + assert
    expect(occupantOf(cats, 'tree_top')?.id).toBe('panther')
    expect(isAnchorFree(cats, 'tree_top')).toBe(false)
    expect(isAnchorFree(cats, 'tree_top', 'mushu')).toBe(false)
  })

  it('Given a cat EN ROUTE to an anchor, When occupancy is checked, Then targetAnchor doubles as a reservation', () => {
    // arrange — traveling, not yet seated
    const cats = [occupant('coco', null, 'hammock')]

    // act + assert
    expect(occupantOf(cats, 'hammock')?.id).toBe('coco')
    expect(isAnchorFree(cats, 'hammock', 'mushu')).toBe(false)
  })

  it('Given the holder asks about its own anchor, When checked with selfId, Then the anchor reads free (re-rolls never self-block)', () => {
    // arrange
    const cats = [occupant('panther', 'tree_top')]

    // act + assert
    expect(isAnchorFree(cats, 'tree_top', 'panther')).toBe(true)
  })

  it('Given nobody at an anchor, When occupancy is checked, Then it is free', () => {
    // arrange
    const cats = [occupant('panther', 'tree_top'), occupant('mushu', 'rug')]

    // act + assert
    expect(occupantOf(cats, 'hammock')).toBeNull()
    expect(isAnchorFree(cats, 'hammock')).toBe(true)
  })
})

describe('sceneModel reachability (the shelf superhighway)', () => {
  it('Given a high shelf, When the route is built, Then a floor cat climbs floor -> tree_mid -> tree_top -> shelf instead of levitating', () => {
    // act
    const route = routeTo('shelf_2')

    // assert
    expect(route).toEqual(['tree_mid', 'tree_top', 'shelf_2'])
  })

  it('Given a floor anchor, When the route is built, Then travel is direct', () => {
    // act + assert
    expect(routeTo('rug')).toEqual(['rug'])
    expect(routeTo('litter_box')).toEqual(['litter_box'])
  })

  it('Given the window perch (Cat TV), When the route is built, Then the tree is its on-ramp', () => {
    // act + assert
    expect(routeTo('window_perch')).toEqual(['tree_mid', 'window_perch'])
  })

  it('Given every anchor with approach waypoints, When each waypoint is resolved, Then it exists (no dangling route ids)', () => {
    // arrange + act + assert — anchorById throws on an unknown id
    for (const anchor of SCENE_ANCHORS) {
      for (const waypoint of anchor.approach) {
        expect(anchorById(waypoint).id).toBe(waypoint)
      }
    }
  })
})

describe('sceneModel compact layout', () => {
  it('Given the sub-480px compact layout, When anchors are listed, Then the anchors of dropped furniture (shelves, plant, post, hammock) leave the pool', () => {
    // act
    const compactIds = anchorsForLayout(390, true).map((a) => a.id)
    const fullIds = anchorsForLayout(W, false).map((a) => a.id)

    // assert
    expect(fullIds).toContain('shelf_1')
    expect(fullIds).toContain('hammock')
    expect(compactIds).not.toContain('shelf_1')
    expect(compactIds).not.toContain('shelf_2')
    expect(compactIds).not.toContain('shelf_3')
    expect(compactIds).not.toContain('hammock')
    expect(compactIds).not.toContain('scratch_post')
  })

  it('Given the dweller taxonomy homes, When looked up, Then every home anchor survives the compact layout at 360px', () => {
    // arrange
    const compactIds = anchorsForLayout(360, true).map((a) => a.id)

    // act + assert — Panther tree, Mushu rug, Coco tunnel nook
    expect(HOME_ANCHOR).toEqual({ panther: 'tree_top', mushu: 'rug', coco: 'tunnel_nook' })
    for (const home of Object.values(HOME_ANCHOR)) {
      expect(compactIds).toContain(home)
    }
  })
})

describe('sceneModel furniture packing (the overlap pin, iter Slice D)', () => {
  // The live 390px screenshot showed the tree, post, tunnel, rug,
  // hammock, and litter box all piled center-left. Placement is now a
  // packing problem: for every pair of same-lane props the rects must
  // NEVER intersect, at every supported width. No exemptions — the only
  // deliberate layering (the litter-box front lip and cats ON props)
  // happens outside this layout.
  const CASES: ReadonlyArray<{ width: number; compact: boolean }> = [
    { width: 360, compact: true },
    { width: 390, compact: true },
    { width: 480, compact: false },
    { width: 640, compact: false },
    { width: 800, compact: false },
  ]

  function horizontalOverlap(a: PackedSpot, b: PackedSpot): number {
    return Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  }

  it.each(CASES)(
    'Given a $width px scene (compact=$compact), When the layout packs, Then no two same-lane furniture rects intersect and every prop stays inside the walls',
    ({ width, compact }) => {
      // act
      const spots = packFurnitureLayout(width, compact)

      // assert — pairwise zero intersection per lane
      for (const lane of ['front', 'back'] as const) {
        const laneSpots = spots.filter((s) => s.lane === lane)
        for (let i = 0; i < laneSpots.length; i++) {
          for (let j = i + 1; j < laneSpots.length; j++) {
            const overlap = horizontalOverlap(laneSpots[i], laneSpots[j])
            expect(
              overlap,
              `${laneSpots[i].name} vs ${laneSpots[j].name} @${width}px overlap ${overlap}px`,
            ).toBeLessThanOrEqual(0)
          }
        }
      }
      // walls
      for (const spot of spots) {
        expect(spot.left, `${spot.name} left wall`).toBeGreaterThanOrEqual(SCENE_MARGIN_PX - 1)
        expect(
          spot.left + spot.width,
          `${spot.name} right wall`,
        ).toBeLessThanOrEqual(width - SCENE_MARGIN_PX + 1)
      }
    },
  )

  it('Given any supported width, When the front floor packs, Then the room composition holds: tree anchors the left end, bowls cluster as a feeding corner, litter tucks at the far edge', () => {
    for (const { width, compact } of CASES) {
      const front = packFurnitureLayout(width, compact).filter((s) => s.lane === 'front')
      const names = front.map((s) => s.name)
      // deliberate left→right order (dropped props may be absent)
      expect(names[0]).toBe('cat_tree_deluxe')
      expect(names[names.length - 1]).toBe('litter_box')
      const food = front.find((s) => s.name === 'food_bowl')
      const water = front.find((s) => s.name === 'water_bowl')
      if (!food || !water) throw new Error('bowls missing from layout')
      // the bowls stay a tight pair (feeding corner), even at 800px
      const bowlGap = water.left - (food.left + food.width)
      expect(bowlGap, `bowl gap @${width}px`).toBeLessThanOrEqual(FURNITURE_GAP_PX * 4)
    }
  })

  it('Given the phone-width compact layouts, When the front lane packs, Then the climbable cat tree keeps its full 120px slot width (no dollhouse tree under a full-size cat)', () => {
    // arrange — the live 390px burst audit showed the tree scaled down
    // while cats stayed 44px, so a perched cat dwarfed its platform.
    const widths = [360, 390]

    // act + assert — CLIMBABLE furniture is exempt from the fit scale
    for (const w of widths) {
      const tree = packedSpotFor('cat_tree_deluxe', w, true)
      expect(tree, `tree missing at ${w}px`).not.toBeNull()
      expect(tree?.width, `tree width @${w}px compact`).toBeGreaterThanOrEqual(120)
    }
  })

  it('Given the full layout, When the back wall packs, Then window, feeder, and shelves hang in the upper third (elevated), using the vertical space', () => {
    // act
    const back = packFurnitureLayout(800, false).filter((s) => s.lane === 'back')

    // assert — wall-mounted props carry a render elevation
    expect(back.find((s) => s.name === 'window_perch')?.elevPct).toBeGreaterThan(0)
    expect(back.find((s) => s.name === 'bird_feeder')?.elevPct).toBeGreaterThan(0)
    expect(back.find((s) => s.name === 'wall_shelf_set')?.elevPct).toBeGreaterThan(0.15)
    // the floor plant stands on the floor
    expect(back.find((s) => s.name === 'plant')?.elevPct).toBe(0)
  })
})

describe('sceneModel geometry', () => {
  it('Given an anchor, When the cat target is computed, Then x sits at its fractional spot on the packed furniture and y tracks the art height above the lane floor', () => {
    // arrange
    const rug = anchorById('rug')
    const treeTop = anchorById('tree_top')
    const rugRect = packedSpotFor('rug', W, false)
    const treeRect = packedSpotFor('cat_tree_deluxe', W, false)
    if (!rugRect || !treeRect) throw new Error('missing packed rects')

    // act
    const x = anchorCatX(rug, W)
    const yFloor = anchorCatY(rug, W, H)
    const yHigh = anchorCatY(treeTop, W, H)

    // assert
    expect(x).toBe(rugRect.left + rugRect.width * rug.fracX - CAT_WIDTH_PX / 2)
    expect(yFloor).toBe(laneFloorY('front', H))
    expect(yHigh).toBe(
      laneFloorY('front', H) + Math.round(treeTop.elevFrac * treeRect.height),
    )
  })

  it('Given an out-of-bounds x, When clamped, Then the cat stays inside the scene walls', () => {
    // act + assert
    expect(clampCatX(-50, W)).toBe(SCENE_MARGIN_PX)
    expect(clampCatX(W + 50, W)).toBe(W - CAT_WIDTH_PX - SCENE_MARGIN_PX)
    expect(clampCatX(300, W)).toBe(300)
  })

  it('Given the full-height tree, When the back wall packs, Then every back-lane prop starts right of the tree (r3 audit: tree top vs window collision)', () => {
    // arrange — the tree keeps full width/height (CLIMBABLE), so its
    // canopy reaches the back wall band; back-lane props packed over it
    // read as the perched cat sitting on the window cushion.
    const widths = [360, 390, 480, 640, 800]

    // act + assert
    for (const w of widths) {
      const compact = w < 480
      const spots = packFurnitureLayout(w, compact)
      const tree = spots.find((s) => s.name === 'cat_tree_deluxe')
      if (!tree) continue
      for (const spot of spots.filter((s) => s.lane === 'back')) {
        expect(
          spot.left,
          `${spot.name} @${w}px starts left of the tree edge`,
        ).toBeGreaterThanOrEqual(tree.left + tree.width)
      }
    }
  })

  it('Given both tree perches occupied, When their cat positions are computed, Then two perched cats never merge into one blob (10Hz audit, 2026-07-11)', () => {
    // arrange — the failure mode: tree_mid and tree_top rendered within
    // one sprite of each other on compact-scaled art, so two perched
    // cats visually merged. Diagonal separation must exceed a sprite in
    // at least one axis at every supported width.
    const widths = [360, 390, 480, 640, 800]

    // act + assert
    for (const w of widths) {
      for (const compact of [true, false]) {
        const dx = Math.abs(
          anchorCatX('tree_top', w, compact) - anchorCatX('tree_mid', w, compact),
        )
        const dy = Math.abs(
          anchorCatY('tree_top', w, 600, compact) - anchorCatY('tree_mid', w, 600, compact),
        )
        expect(
          dx >= CAT_WIDTH_PX * 0.8 || dy >= 44,
          `perches too close at w=${w} compact=${compact}: dx=${dx} dy=${dy}`,
        ).toBe(true)
      }
    }
  })

  it('Given the measured platform surfaces, When the perch anchors are read, Then each carries EXACTLY the PIL-measured geometry (feet land ON the art surfaces)', () => {
    // arrange — measured 2026-07-11 by scanning the shipped PNGs for
    // flat opaque-top runs (cat_tree_deluxe.png 190×256: low-left disc
    // surface y≈127 cx≈0.11, top platform y≈2 cx≈0.50) and the cushion
    // color band (window_perch.png 157×170: cushion top row 108 cx≈0.50).
    const expected = {
      tree_mid: { fracX: TREE_MID_FRAC_X, elevFrac: TREE_MID_ELEV_FRAC },
      tree_top: { fracX: TREE_TOP_FRAC_X, elevFrac: TREE_TOP_ELEV_FRAC },
      window_perch: { fracX: WINDOW_PERCH_FRAC_X, elevFrac: WINDOW_PERCH_ELEV_FRAC },
    }

    // act + assert
    for (const [id, geo] of Object.entries(expected)) {
      const a = anchorById(id)
      expect(a.fracX, `${id} fracX`).toBe(geo.fracX)
      expect(a.elevFrac, `${id} elevFrac`).toBe(geo.elevFrac)
    }
    // The measured constants themselves pin the measurement session —
    // re-measure before changing these.
    expect(TREE_MID_FRAC_X).toBe(0.11)
    expect(TREE_MID_ELEV_FRAC).toBe(0.5)
    expect(TREE_TOP_FRAC_X).toBe(0.5)
    expect(TREE_TOP_ELEV_FRAC).toBe(0.99)
    expect(WINDOW_PERCH_FRAC_X).toBe(0.5)
    expect(WINDOW_PERCH_ELEV_FRAC).toBe(0.365)
  })

  it('Given the tunnel nook, When Coco rests there, Then she sits beside the tunnel mouth instead of clipped on top of the art', () => {
    // arrange
    const widths = [360, 390, 800]

    // act + assert — the nook's cat left-edge must start past ~90% of
    // the tunnel art (or be wall-clamped), so the sleeping sprite reads
    // as next to her nook, not draped over its mouth.
    for (const w of widths) {
      const spot = packedSpotFor('tunnel', w, w < 480)
      if (!spot) continue // tunnel dropped at this layout — nothing to overlap
      const catX = anchorCatX('tunnel_nook', w, w < 480)
      const clamped = catX === w - CAT_WIDTH_PX - SCENE_MARGIN_PX
      expect(
        clamped || catX >= spot.left + spot.width * 0.9 - CAT_WIDTH_PX / 2,
        `nook overlaps tunnel at w=${w}: catX=${catX} tunnel=[${spot.left},${spot.left + spot.width}]`,
      ).toBe(true)
    }
  })
})
