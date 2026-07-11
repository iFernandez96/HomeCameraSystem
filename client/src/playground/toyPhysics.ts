import type {
  LaserToy,
  PlaygroundLane,
  TreatToy,
  WandToy,
  YarnToy,
} from './playgroundTypes'
import {
  BACK_LANE_FLOOR_PCT,
  FRONT_LANE_FLOOR_PCT,
  SCENE_MARGIN_PX,
} from './playgroundTypes'

// Playground Slice C — pure toy physics. No React, no randomness, no
// side effects: every function takes plain data and returns plain data
// (the SAME reference when nothing moved, so the toy layer can keep
// CatLayer's bail-out discipline for free).
//
// Swink game-feel rule (docs/playground_design.md #5): the toy layer is
// INSTANT and DETERMINISTIC — all randomness lives in catBrain.verbs'
// decisions, never here.
//
// dt handling: all tuning constants are expressed per 60fps frame; the
// steppers substep in whole-frame chunks (plus a fractional remainder)
// so a 33ms tick at 30fps integrates the same trajectory as two 16.7ms
// ticks at 60fps to within a small tolerance.

/** One 60fps frame, in ms. */
export const FRAME_MS = 1000 / 60

/** Yarn horizontal damping per frame (rolling + air drag). */
export const FRICTION_PER_FRAME = 0.985
/** Downward acceleration while airborne, px per frame^2. */
export const GRAVITY_PER_FRAME = 0.55
/** Floor bounce keeps 45% of vertical speed (sign flipped). */
export const FLOOR_RESTITUTION = 0.45
/** Wall bounce keeps 80% of horizontal speed (sign flipped). */
export const WALL_RESTITUTION = 0.8
/** Yarn spin advance in radians per px of horizontal travel. */
export const SPIN_PER_PX = 0.06
/** Below this speed (px/frame) a floored yarn is considered resting. */
export const REST_SPEED_EPS = 0.05
/** Vertical bounce speeds below this collapse to a dead stop. */
export const BOUNCE_KILL_EPS = 0.8
/** A resting yarn despawns after this long. */
export const YARN_DESPAWN_MS = 30_000
/** Laser dot easing factor toward its target, per 60fps frame. */
export const LASER_EASE_PER_FRAME = 0.35
/** Laser dot snaps to target below this distance (px). */
export const LASER_SNAP_EPS = 0.25
/** Wand-tip spring stiffness per frame^2 (critically damped). */
export const WAND_SPRING_K = 0.09
/** Wand tip settles (snaps to handle) below this offset/speed. */
export const WAND_SNAP_EPS = 0.3

/** Scene-space y of a lane's floor line. */
export function laneFloorY(lane: PlaygroundLane, sceneH: number): number {
  return sceneH * (lane === 'back' ? BACK_LANE_FLOOR_PCT : FRONT_LANE_FLOOR_PCT)
}

/** Which lane a scene-space y most plausibly belongs to (midpoint split
    between the two floor lines). */
export function laneForY(y: number, sceneH: number): PlaygroundLane {
  const split = sceneH * ((BACK_LANE_FLOOR_PCT + FRONT_LANE_FLOOR_PCT) / 2)
  return y <= split ? 'back' : 'front'
}

/** dt in ms -> number of 60fps frames (fractional). */
export function dtFrames(dtMs: number): number {
  return dtMs / FRAME_MS
}

/** Substep helper: walks `frames` in <=1-frame chunks. */
function substep(frames: number, step: (chunk: number) => void): void {
  let left = frames
  while (left > 1e-9) {
    const chunk = Math.min(1, left)
    step(chunk)
    left -= chunk
  }
}

/** Semi-implicit Euler yarn integrator. Returns the SAME reference when
    the yarn is already resting (despawn is the caller's job via
    yarnExpired). */
export function stepYarn(
  yarn: YarnToy,
  dtMs: number,
  now: number,
  sceneW: number,
  sceneH: number,
): YarnToy {
  if (yarn.restingSince !== null) return yarn

  const floor = laneFloorY(yarn.lane, sceneH)
  let { x, y, vx, vy, spinPhase } = yarn
  let restingSince: number | null = null

  substep(dtFrames(dtMs), (n) => {
    // integrate velocity first (semi-implicit), then position
    const airborne = y < floor - 0.5
    if (airborne) vy += GRAVITY_PER_FRAME * n
    vx *= Math.pow(FRICTION_PER_FRAME, n)

    x += vx * n
    y += vy * n

    // wall bounce (deterministic sign flip, 80% retained)
    if (x < SCENE_MARGIN_PX) {
      x = SCENE_MARGIN_PX
      vx = -vx * WALL_RESTITUTION
    } else if (x > sceneW - SCENE_MARGIN_PX) {
      x = sceneW - SCENE_MARGIN_PX
      vx = -vx * WALL_RESTITUTION
    }

    // floor bounce (45% retained, dead-stop below the kill epsilon)
    if (y >= floor) {
      y = floor
      vy = -vy * FLOOR_RESTITUTION
      if (Math.abs(vy) < BOUNCE_KILL_EPS) vy = 0
    }

    spinPhase += Math.abs(vx) * SPIN_PER_PX * n
  })

  // resting: on the floor with negligible speed
  if (y >= floor - 0.5 && vy === 0 && Math.abs(vx) < REST_SPEED_EPS) {
    vx = 0
    restingSince = now
  }

  return { ...yarn, x, y, vx, vy, spinPhase, restingSince }
}

/** True once a resting yarn has sat still long enough to despawn. */
export function yarnExpired(yarn: YarnToy, now: number): boolean {
  return yarn.restingSince !== null && now - yarn.restingSince >= YARN_DESPAWN_MS
}

/** Treat gravity fall; lands (state 'landed', vy 0) at its lane floor.
    Returns the SAME reference once landed/claimed. */
export function stepTreat(treat: TreatToy, dtMs: number, sceneH: number): TreatToy {
  if (treat.state !== 'falling') return treat

  const floor = laneFloorY(treat.lane, sceneH)
  let { y, vy } = treat
  let state: TreatToy['state'] = treat.state

  substep(dtFrames(dtMs), (n) => {
    if (state !== 'falling') return
    vy += GRAVITY_PER_FRAME * n
    y += vy * n
    if (y >= floor) {
      y = floor
      vy = 0
      state = 'landed'
    }
  })

  return { ...treat, y, vy, state }
}

/** Laser dot exponential ease toward (tx, ty): x += (tx-x)*0.35 per
    60fps frame, dt-normalized. Returns the SAME reference when off or
    already converged. */
export function stepLaser(laser: LaserToy, dtMs: number): LaserToy {
  if (!laser.on) return laser

  const dx = laser.tx - laser.x
  const dy = laser.ty - laser.y
  if (Math.abs(dx) < LASER_SNAP_EPS && Math.abs(dy) < LASER_SNAP_EPS) {
    if (laser.x === laser.tx && laser.y === laser.ty) return laser
    return { ...laser, x: laser.tx, y: laser.ty }
  }

  // per-frame lerp factor 0.35, dt-normalized: after n frames the
  // remaining gap is (1 - 0.35)^n of the original
  const remain = Math.pow(1 - LASER_EASE_PER_FRAME, dtFrames(dtMs))
  return {
    ...laser,
    x: laser.tx - dx * remain,
    y: laser.ty - dy * remain,
  }
}

/** Critically-damped spring pulling the wand tip toward the handle
    (hx, hy). Returns the SAME reference when not held or fully settled. */
export function stepWand(wand: WandToy, dtMs: number): WandToy {
  if (!wand.held) return wand

  const settled =
    Math.abs(wand.hx - wand.tipX) < WAND_SNAP_EPS &&
    Math.abs(wand.hy - wand.tipY) < WAND_SNAP_EPS &&
    Math.abs(wand.tipVx) < WAND_SNAP_EPS &&
    Math.abs(wand.tipVy) < WAND_SNAP_EPS
  if (settled) {
    if (wand.tipX === wand.hx && wand.tipY === wand.hy) return wand
    return { ...wand, tipX: wand.hx, tipY: wand.hy, tipVx: 0, tipVy: 0 }
  }

  // critical damping: c = 2*sqrt(k) kills oscillation without overshoot
  const damping = 2 * Math.sqrt(WAND_SPRING_K)
  let { tipX, tipY, tipVx, tipVy } = wand

  substep(dtFrames(dtMs), (n) => {
    tipVx += (WAND_SPRING_K * (wand.hx - tipX) - damping * tipVx) * n
    tipVy += (WAND_SPRING_K * (wand.hy - tipY) - damping * tipVy) * n
    tipX += tipVx * n
    tipY += tipVy * n
  })

  return { ...wand, tipX, tipY, tipVx, tipVy }
}
