import { describe, expect, it } from 'vitest'
import {
  CAT_WIDTH_PX,
  HOME_ANCHOR,
  SCENE_ANCHORS,
  anchorById,
  anchorCatX,
  anchorCatY,
  anchorsForLayout,
  clampCatX,
  isAnchorFree,
  laneFloorY,
  occupantOf,
  routeTo,
  type AnchorOccupant,
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
  it('Given the sub-480px compact layout, When anchors are listed, Then only the shelf superhighway drops (its furniture is hidden there)', () => {
    // act
    const compactIds = anchorsForLayout(true).map((a) => a.id)
    const fullIds = anchorsForLayout(false).map((a) => a.id)

    // assert
    expect(fullIds).toContain('shelf_1')
    expect(compactIds).not.toContain('shelf_1')
    expect(compactIds).not.toContain('shelf_2')
    expect(compactIds).not.toContain('shelf_3')
    expect(fullIds.filter((id) => !compactIds.includes(id))).toEqual([
      'shelf_1',
      'shelf_2',
      'shelf_3',
    ])
  })

  it('Given the dweller taxonomy homes, When looked up, Then every home anchor survives the compact layout', () => {
    // arrange
    const compactIds = anchorsForLayout(true).map((a) => a.id)

    // act + assert — Panther tree, Mushu rug, Coco tunnel nook
    expect(HOME_ANCHOR).toEqual({ panther: 'tree_top', mushu: 'rug', coco: 'tunnel_nook' })
    for (const home of Object.values(HOME_ANCHOR)) {
      expect(compactIds).toContain(home)
    }
  })
})

describe('sceneModel geometry', () => {
  it('Given an anchor, When the cat target is computed, Then x centers on the clamped footprint and y adds elevation above the lane floor', () => {
    // arrange
    const rug = anchorById('rug')
    const treeTop = anchorById('tree_top')

    // act
    const x = anchorCatX(rug, W)
    const yFloor = anchorCatY(rug, H)
    const yHigh = anchorCatY(treeTop, H)

    // assert — rug at 50% of 800 = left 400, center 460, minus half a cat
    expect(x).toBe(400 + rug.widthPx / 2 - CAT_WIDTH_PX / 2)
    expect(yFloor).toBe(laneFloorY('front', H))
    expect(yHigh).toBe(laneFloorY('front', H) + Math.round(treeTop.elevPct * H))
  })

  it('Given an out-of-bounds x, When clamped, Then the cat stays inside the scene walls', () => {
    // act + assert
    expect(clampCatX(-50, W)).toBe(SCENE_MARGIN_PX)
    expect(clampCatX(W + 50, W)).toBe(W - CAT_WIDTH_PX - SCENE_MARGIN_PX)
    expect(clampCatX(300, W)).toBe(300)
  })
})
