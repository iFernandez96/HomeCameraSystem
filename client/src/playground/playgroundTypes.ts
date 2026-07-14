import type { CatAnimId } from '../components/catAnimSequences'

// Shared contract between the yard engine (Slice B: sceneModel/
// stepPlayground/catBrain.beats) and the toy+verb layer (Slice C:
// toyPhysics/toyLayer/catBrain.verbs). OWNED BY THE INTEGRATOR —
// slices import types from here and must not edit this file; contract
// changes go through the main session.

export type PlaygroundLane = 'front' | 'back'

export type PlaygroundVerb = 'laser' | 'yarn' | 'treat' | 'wand'

/** Pointer/verb input snapshot. Written by the scene's pointer handlers
    into a ref (never React state); read once per rAF tick. */
export type PlaygroundInput = {
  /** Current pointer position in scene coordinates, null when up/out. */
  pointer: { x: number; y: number; down: boolean } | null
  /** Selected verb-toolbar mode; null = no tool (petting needs no mode). */
  activeVerb: PlaygroundVerb | null
  /** Cat under a press-and-hold (set by cat overlay pointerdown, cleared
      on pointerup/cancel). Petting preempts other stimuli. */
  petTarget: CatAnimId | null
  /** One-shot flick gesture (yarn throw): scene coords + velocity px/ms.
      Consumed (set back to null) by the toy layer when spawned. */
  flick: { x: number; y: number; vx: number; vy: number } | null
  /** One-shot tap while treat verb active. Consumed by the toy layer. */
  treatTap: { x: number; y: number; lane: PlaygroundLane } | null
}

export type YarnToy = {
  kind: 'yarn'
  id: number
  x: number
  y: number
  vx: number
  vy: number
  lane: PlaygroundLane
  spinPhase: number
  restingSince: number | null
}

export type TreatToy = {
  kind: 'treat'
  id: number
  x: number
  y: number
  vy: number
  lane: PlaygroundLane
  state: 'falling' | 'landed' | 'claimed'
  claimedBy: CatAnimId | null
}

export type LaserToy = {
  kind: 'laser'
  on: boolean
  x: number
  y: number
  tx: number
  ty: number
}

export type WandToy = {
  kind: 'wand'
  held: boolean
  hx: number
  hy: number
  tipX: number
  tipY: number
  tipVx: number
  tipVy: number
}

export type ToyState = {
  yarn: YarnToy | null
  treats: TreatToy[]
  laser: LaserToy
  wand: WandToy
}

export type AmbientEntity = {
  kind: 'butterfly' | 'bird'
  id: number
  x: number
  y: number
  t: number
  frame: 'a' | 'b'
}

/** What a cat is currently committed to. Petting always preempts. */
export type CatFocus =
  | { type: 'anchor'; anchorId: string }
  | { type: 'toy'; toy: 'laser' | 'yarn' | 'wand'; }
  | { type: 'treat'; treatId: number }
  | { type: 'ambient'; ambientId: number }
  | { type: 'pet' }
  | null

/** The stimulus digest the verb brain (Slice C) produces each tick for
    the yard engine (Slice B) to act on. Keeps catBrain.beats and
    catBrain.verbs decoupled: verbs propose, beats/stepPlayground apply. */
export type VerbStimulus = {
  catId: CatAnimId
  /** Requested focus switch, or 'release' to clear a toy focus. */
  request:
    | { type: 'chase'; targetX: number; targetY: number; lane: PlaygroundLane; gait: 'walk' | 'run' }
    | { type: 'bat' }
    | { type: 'eat'; treatId: number }
    | { type: 'purr' }
    | { type: 'grump' }
    | { type: 'release' }
}

export const SCENE_MARGIN_PX = 8
export const BACK_LANE_FLOOR_PCT = 0.62
export const FRONT_LANE_FLOOR_PCT = 0.88
export const BACK_LANE_SCALE = 0.85
