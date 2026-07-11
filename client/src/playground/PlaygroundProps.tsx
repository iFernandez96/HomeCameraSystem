import { memo } from 'react'
import type { SyntheticEvent } from 'react'
import {
  PLAYGROUND_AMBIENT_URLS,
  PLAYGROUND_FURNITURE_URLS,
  PLAYGROUND_TOY_URLS,
} from './playgroundAssets'
import { packFurnitureLayout } from './sceneModel'
import {
  BACK_LANE_FLOOR_PCT,
  FRONT_LANE_FLOOR_PCT,
  type AmbientEntity,
  type PlaygroundLane,
  type ToyState,
} from './playgroundTypes'

// Playground Slice B — the non-cat renderers: furniture (from the
// sceneModel layout, moved out of pages/Playground.tsx), toys (driven
// PURELY by ToyState — no local physics, no local randomness), and
// ambient critters. All memoized: stepPlayground's ref-stable bail-outs
// mean an unchanged toys/ambient slice skips its whole subtree even
// while the cats re-render every frame.
//
// Coordinate contract (mirrors stepPlayground's ctx seam):
// - furniture + ambient position in BOTTOM-offset space (lane floors),
// - toys position in TOP-origin scene px (pointer space).
//
// Every <img> hides itself onError — the art set may still be
// generating, and a missing PNG must degrade to an emptier room.
//
// z-stack: furniture 0 → back-lane cats 1 → front cats 2 → litter-box
// front lip 3 (the "cat stands IN the box" trick) → toys 4 (the laser
// dot paints over everything — it is light).

const LANE_BOTTOM_PCT: Record<PlaygroundLane, number> = {
  back: Math.round((1 - BACK_LANE_FLOOR_PCT) * 100),
  front: Math.round((1 - FRONT_LANE_FLOOR_PCT) * 100),
}

function hideOnError(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = 'none'
}

// === Furniture ===============================================================

export type PlaygroundFurnitureProps = {
  compact: boolean
  /** Live scene width in px — the packed layout is computed from it
      (sceneModel.packFurnitureLayout), so props NEVER overlap at any
      width and cats land exactly on their furniture. */
  sceneW: number
  /** A cat is hiding inside the tunnel — the tunnel rustles (the
      hidden beat's discovery payoff; the cat itself renders nothing). */
  tunnelRustling: boolean
}

export const PlaygroundFurniture = memo(function PlaygroundFurniture({
  compact,
  sceneW,
  tunnelRustling,
}: PlaygroundFurnitureProps) {
  const spots = packFurnitureLayout(sceneW, compact)
  const litter = spots.find((spot) => spot.name === 'litter_box')
  return (
    <>
      {spots.map((spot) => (
        <img
          key={spot.name}
          src={PLAYGROUND_FURNITURE_URLS[spot.name]}
          alt=""
          data-testid={`playground-furniture-${spot.name}`}
          data-lane={spot.lane}
          width={spot.width}
          decoding="async"
          style={{
            position: 'absolute',
            // Wall-mounted back-wall props (window, feeder, shelves)
            // hang above their lane's floor line — the room reads as
            // three vertical tiers, not one crowded baseboard.
            bottom: `calc(${LANE_BOTTOM_PCT[spot.lane]}% + ${(spot.elevPct * 100).toFixed(1)}%)`,
            left: spot.left,
            width: spot.width,
            pointerEvents: 'none',
            zIndex: 0,
            // The tunnel rustle reuses the habitat box-rustle keyframes
            // (front lane, scale 1, so the animation's transform can
            // safely own the property). Reduced-motion collapses it via
            // the global index.css clamp — and the rAF loop is paused
            // there anyway, so no cat ever hides in static mode.
            animation:
              spot.name === 'tunnel' && tunnelRustling
                ? 'cat-box-rustle 700ms ease-in-out infinite'
                : undefined,
          }}
          onError={hideOnError}
        />
      ))}
      {litter && (
        // Front-lip z-order trick: a clipped duplicate of the litter box
        // painted ABOVE the cats so a visiting cat reads as standing IN
        // the box — only the sprite's bottom slice (the front wall)
        // repaints over the cat.
        <img
          src={PLAYGROUND_FURNITURE_URLS.litter_box}
          alt=""
          aria-hidden="true"
          data-testid="playground-furniture-litter_box-lip"
          width={litter.width}
          decoding="async"
          style={{
            position: 'absolute',
            bottom: `${LANE_BOTTOM_PCT[litter.lane]}%`,
            left: litter.left,
            width: litter.width,
            clipPath: 'inset(55% 0 0 0)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
          onError={hideOnError}
        />
      )}
    </>
  )
})

// === Toys ====================================================================

/** Yarn sprite router: rolling alternates roll_a/roll_b off spinPhase
    (advanced by the physics per px of travel — deterministic), resting
    settles on the idle ball. */
function yarnFrame(spinPhase: number, resting: boolean): 'yarn_idle' | 'yarn_roll_a' | 'yarn_roll_b' {
  if (resting) return 'yarn_idle'
  return Math.floor(spinPhase / 1.2) % 2 === 0 ? 'yarn_roll_a' : 'yarn_roll_b'
}

export const PlaygroundToys = memo(function PlaygroundToys({ toys }: { toys: ToyState }) {
  const { yarn, treats, laser, wand } = toys
  const wandAngle = wand.held
    ? Math.atan2(wand.tipY - wand.hy, wand.tipX - wand.hx)
    : 0
  const wandLength = wand.held
    ? Math.max(44, Math.hypot(wand.tipX - wand.hx, wand.tipY - wand.hy))
    : 0
  return (
    <>
      {treats.map((treat) => (
        <img
          key={treat.id}
          src={PLAYGROUND_TOY_URLS.treat}
          alt=""
          data-testid={`playground-toy-treat-${treat.id}`}
          data-state={treat.state}
          width={16}
          height={16}
          decoding="async"
          style={{
            position: 'absolute',
            left: treat.x,
            top: treat.y,
            width: 16,
            height: 16,
            // Sits ON its y (the floor contact point once landed).
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 4,
            opacity: treat.state === 'claimed' ? 0.55 : 1,
          }}
          onError={hideOnError}
        />
      ))}
      {yarn !== null && (
        <img
          src={PLAYGROUND_TOY_URLS[yarnFrame(yarn.spinPhase, yarn.restingSince !== null)]}
          alt=""
          data-testid="playground-toy-yarn"
          width={22}
          height={22}
          decoding="async"
          style={{
            position: 'absolute',
            left: yarn.x,
            top: yarn.y,
            width: 22,
            height: 22,
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 4,
          }}
          onError={hideOnError}
        />
      )}
      {wand.held && (
        // Feather wand: the img spans handle → tip, rotated to their
        // live angle. transformOrigin left-center keeps the handle
        // pinned under the finger while the spring tip trails.
        <img
          src={PLAYGROUND_TOY_URLS.feather_wand}
          alt=""
          data-testid="playground-toy-wand"
          decoding="async"
          style={{
            position: 'absolute',
            left: wand.hx,
            top: wand.hy,
            width: wandLength,
            height: 28,
            transform: `translateY(-50%) rotate(${wandAngle}rad)`,
            transformOrigin: 'left center',
            objectFit: 'contain',
            pointerEvents: 'none',
            zIndex: 4,
          }}
          onError={hideOnError}
        />
      )}
      {laser.on && (
        // The laser dot is pure CSS light — no asset to 404, zero
        // latency (Swink rule: the toy layer responds instantly).
        <div
          data-testid="playground-laser-dot"
          style={{
            position: 'absolute',
            left: laser.x,
            top: laser.y,
            width: 14,
            height: 14,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background:
              'radial-gradient(circle, rgba(255,86,72,0.95) 0%, rgba(255,52,40,0.5) 45%, rgba(255,52,40,0) 72%)',
            pointerEvents: 'none',
            zIndex: 4,
          }}
        />
      )}
    </>
  )
})

// === Ambient critters ========================================================

export const PlaygroundAmbient = memo(function PlaygroundAmbient({
  ambient,
}: {
  ambient: readonly AmbientEntity[]
}) {
  return (
    <>
      {ambient.map((critter) => (
        <img
          key={critter.id}
          // The a/b flap frames are toggled by stepPlayground's ambient
          // pass (~160ms butterfly flap / ~420ms bird hop) — this
          // renderer just routes the current frame to its URL.
          src={PLAYGROUND_AMBIENT_URLS[`${critter.kind}_${critter.frame}`]}
          alt=""
          data-testid={`playground-ambient-${critter.kind}`}
          data-frame={critter.frame}
          width={22}
          decoding="async"
          style={{
            position: 'absolute',
            left: critter.x,
            bottom: critter.y,
            width: 22,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
          onError={hideOnError}
        />
      ))}
    </>
  )
})
