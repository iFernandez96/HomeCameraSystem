import {
  CAT_ANIM_SEQUENCES,
  catAnimFrameUrl,
  type CatAnimFrame,
  type CatAnimSequenceName,
} from '../components/catAnimSequences'
import {
  POSE_TRANSITIONS,
  animationPlanFor,
  type AnimActivityMaps,
  type AnimationPlan,
  type PoseGroup,
  type SequenceTable,
} from '../components/catEngineCore'
import {
  PLAYGROUND_CAT_FRAME_NAMES,
  playgroundCatFrameUrl,
  type PlaygroundCatFrameName,
  type PlaygroundCatId,
} from './playgroundAssets'
import { PLAYGROUND_SEQUENCES, type PlaygroundAnimStep } from './playgroundSequences'
import {
  HOME_ANCHOR,
  anchorById,
  anchorCatX,
  anchorCatY,
} from './sceneModel'
import type {
  AmbientEntity,
  CatFocus,
  PlaygroundLane,
  ToyState,
} from './playgroundTypes'
import { INITIAL_TOY_STATE } from './toyLayer'

// Playground Slice B — the yard's state shape, its initial builder,
// and the activity → sprite-engine bindings (the Playground analogue
// of CatLayer's Activity maps). Pure data + pure helpers; no React.

// === Activities ==============================================================

export type PlayActivity =
  // locomotion
  | 'walk'
  | 'run'
  // calm holds
  | 'sit'
  | 'judge'
  | 'loaf'
  | 'sleep'
  | 'stretch'
  // anchor beats
  | 'perch' // seated on tree platform / shelf / window perch
  | 'hammock' // hammock nap
  | 'tunnel' // hidden inside the tunnel (renders nothing; tunnel rustles)
  | 'watch' // window bird-watching (Cat TV)
  | 'pooped' // litter visit — reuses the existing silly beat
  | 'scratch' // scratching bout at the post (reuses bat frames)
  | 'eat' // eat/drink bout at bowls or a treat
  // stimulus responses
  | 'bat' // toy bat bout
  | 'purr' // petting hold
  | 'pounce' // ambient pursuit pounce (always misses)
  // cat-cat interactions (ported pools)
  | 'groom'
  | 'snuggle'
  | 'hiss'
  | 'scared'
  | 'chase'
  | 'flee'
  | 'play'

export type PlayCat = {
  id: PlaygroundCatId
  /** Left-edge x in scene px. */
  x: number
  /** Bottom offset in scene px (lane floor + elevation). */
  y: number
  lane: PlaygroundLane
  direction: 'L' | 'R'
  activity: PlayActivity
  previousActivity: PlayActivity
  activityStartedAt: number
  activityUntil: number
  /** Frozen while no sprite timeline runs (CatLayer bail-out idiom). */
  phaseTime: number
  mood: string | null
  moodSecondary: string | null
  moodUntil: number
  focus: CatFocus
  /** Anchor currently being traveled to (doubles as the en-route
      reservation — see sceneModel.occupantOf). */
  targetAnchor: string | null
  /** Remaining route waypoints (targetAnchor is route[0]). */
  route: readonly string[]
  /** Anchor currently occupied (null while roaming/traveling). */
  anchorId: string | null
  /** Beat to start once the final route anchor is reached. */
  arrival: { activity: PlayActivity; durationMs: number } | null
  /** Point travel (toy chase / ambient pursuit) — scene px. */
  targetX: number | null
  targetY: number | null
  petStartedAt: number | null
  /** Anti-repeat memory for the beat brain. */
  lastBeatId: string | null
  lastInteractedWith: PlaygroundCatId | null
  lastInteractedAt: number
  // Seated-idle sub-system (ported from CatLayer)
  idleSequence: CatAnimSequenceName | null
  idleSequenceStartedAt: number
  nextIdleLifeAt: number
  lastIdleLifeWasSpecial: boolean
}

export type PlaygroundState = {
  cats: PlayCat[]
  toys: ToyState
  ambient: AmbientEntity[]
  /** Next ambient spawn time (butterfly loop / bird on feeder). */
  ambientNextAt: number
  ambientNextId: number
  /** Global cat-cat interaction cooldown stamp. */
  lastInteractionAt: number
}

// === Helpers (setActivity / setMood analogues) ===============================

export const ACTIVITY_JITTER_MIN = 0.78
export const ACTIVITY_JITTER_MAX = 1.32

/** Duration-jittered activity switch (same 0.78–1.32× spread as
    CatLayer's setActivity — no bout ever lasts its nominal length
    twice). Random source injected for deterministic tests. */
export function setPlayActivity(
  cat: PlayCat,
  activity: PlayActivity,
  durationMs: number,
  now: number,
  random: () => number = Math.random,
): PlayCat {
  const jitter = ACTIVITY_JITTER_MIN + random() * (ACTIVITY_JITTER_MAX - ACTIVITY_JITTER_MIN)
  return {
    ...cat,
    previousActivity: cat.activity,
    activity,
    activityStartedAt: now,
    activityUntil: now + durationMs * jitter,
    phaseTime: now,
    idleSequence: null,
    idleSequenceStartedAt: 0,
    nextIdleLifeAt: now + 3000 + random() * 4000,
    lastIdleLifeWasSpecial: false,
  }
}

export function setPlayMood(
  cat: PlayCat,
  mood: string,
  durationMs: number,
  now: number,
  secondary?: string,
): PlayCat {
  return { ...cat, mood, moodSecondary: secondary ?? null, moodUntil: now + durationMs }
}

// === Initial state ===========================================================

const HOME_POSE: Record<PlaygroundCatId, { activity: PlayActivity; durationMs: number }> = {
  panther: { activity: 'perch', durationMs: 14000 }, // Tree Dweller — judges from altitude
  mushu: { activity: 'sit', durationMs: 5000 }, // Beach Dweller — open floor, first responder
  coco: { activity: 'loaf', durationMs: 12000 }, // Bush Dweller — naps at her tunnel nook
}

export function buildHomeCat(
  id: PlaygroundCatId,
  now: number,
  sceneW: number,
  sceneH: number,
  random: () => number = Math.random,
): PlayCat {
  const homeId = HOME_ANCHOR[id]
  const home = anchorById(homeId)
  const pose = HOME_POSE[id]
  const base: PlayCat = {
    id,
    x: anchorCatX(home, sceneW),
    y: anchorCatY(home, sceneH),
    lane: home.lane,
    direction: 'L', // shared PNGs face left by default
    activity: pose.activity,
    previousActivity: pose.activity,
    activityStartedAt: now,
    activityUntil: now,
    phaseTime: now,
    mood: null,
    moodSecondary: null,
    moodUntil: 0,
    focus: { type: 'anchor', anchorId: homeId },
    targetAnchor: null,
    route: [],
    anchorId: homeId,
    arrival: null,
    targetX: null,
    targetY: null,
    petStartedAt: null,
    lastBeatId: null,
    lastInteractedWith: null,
    lastInteractedAt: 0,
    idleSequence: null,
    idleSequenceStartedAt: 0,
    nextIdleLifeAt: now + 3000 + random() * 4000,
    lastIdleLifeWasSpecial: false,
  }
  return setPlayActivity(base, pose.activity, pose.durationMs, now, random)
}

export function initialPlaygroundState(
  now: number,
  sceneW: number,
  sceneH: number,
  random: () => number = Math.random,
): PlaygroundState {
  return {
    cats: (['panther', 'mushu', 'coco'] as const).map((id) =>
      buildHomeCat(id, now, sceneW, sceneH, random),
    ),
    toys: INITIAL_TOY_STATE,
    ambient: [],
    ambientNextAt: now + 20000 + random() * 25000,
    ambientNextId: 1,
    lastInteractionAt: 0,
  }
}

// === Activity → sprite-engine bindings ======================================
// The Playground binds catEngineCore's activity-agnostic plan builder
// to its OWN activity union, exactly as CatLayer binds its maps.
// CONTRACT FRICTION NOTE: catEngineCore's SequenceTable / frame types
// are closed over the base CatAnim unions, so the playground-only
// sequences (bat_bout / eat_bout / purr_hold, whose steps use the
// widened PlaygroundAnimFrame) enter via localized casts below. The
// runtime shapes are identical ({ frame, ms } steps per cat).

const perCat = (steps: readonly PlaygroundAnimStep[]) => ({
  panther: steps,
  mushu: steps,
  coco: steps,
})

export const PLAYGROUND_SEQUENCE_TABLE: SequenceTable = {
  ...CAT_ANIM_SEQUENCES,
  bat_bout: perCat(PLAYGROUND_SEQUENCES.bat_bout),
  eat_bout: perCat(PLAYGROUND_SEQUENCES.eat_bout),
  purr_hold: perCat(PLAYGROUND_SEQUENCES.purr_hold),
} as unknown as SequenceTable

const seq = (name: string) => name as CatAnimSequenceName
const frame = (name: string) => name as CatAnimFrame

export const POSE_GROUP_BY_PLAY_ACTIVITY: Record<PlayActivity, PoseGroup> = {
  walk: 'walking',
  run: 'walking',
  chase: 'walking',
  flee: 'walking',
  sit: 'seated',
  judge: 'seated',
  loaf: 'seated',
  watch: 'seated',
  perch: 'seated',
  purr: 'seated',
  groom: 'seated',
  snuggle: 'seated',
  sleep: 'sleeping',
  hammock: 'sleeping',
  stretch: 'crouched',
  pooped: 'crouched',
  pounce: 'crouched',
  play: 'crouched',
  scratch: 'crouched',
  bat: 'crouched',
  eat: 'crouched',
  tunnel: 'crouched',
  hiss: 'standing',
  scared: 'standing',
}

const PLAY_ENTRY_SEQUENCES: Partial<Record<PlayActivity, readonly CatAnimSequenceName[]>> = {
  perch: ['jump_post'],
  hammock: ['jump_post'],
  watch: ['jump_post'],
}

export function playTransitionNamesFor(
  from: PlayActivity,
  to: PlayActivity,
): readonly CatAnimSequenceName[] {
  const fromGroup = POSE_GROUP_BY_PLAY_ACTIVITY[from]
  const toGroup = POSE_GROUP_BY_PLAY_ACTIVITY[to]
  if (to === 'scared') return []
  if (to === 'hiss') {
    return fromGroup === 'walking' ? ['walk_to_front', 'hiss_windup'] : ['hiss_windup']
  }
  return [
    ...POSE_TRANSITIONS[fromGroup][toGroup],
    ...(PLAY_ENTRY_SEQUENCES[to] ?? []),
  ]
}

export const PLAY_ONGOING_SEQUENCE: Partial<Record<PlayActivity, CatAnimSequenceName>> = {
  walk: 'walk',
  run: 'run',
  chase: 'run',
  flee: 'run',
  groom: 'groom_bout',
  play: 'pounce',
  pounce: 'pounce',
  pooped: 'poop_squat',
  scratch: seq('bat_bout'), // scratching reuses the bat paw-swipe frames
  bat: seq('bat_bout'),
  eat: seq('eat_bout'),
}

export const PLAY_HOLD_FRAME: Partial<Record<PlayActivity, CatAnimFrame>> = {
  sit: 'seated',
  judge: 'seated',
  loaf: 'seated',
  watch: 'seated',
  perch: 'seated',
  snuggle: 'seated',
  sleep: 'sleep',
  hammock: 'sleep',
  stretch: 'crouch',
  purr: frame('purr'),
  // 'tunnel' has no hold frame — a hidden cat renders nothing.
}

export const PLAYGROUND_ANIM_MAPS: AnimActivityMaps<PlayActivity> = {
  transitionNamesFor: playTransitionNamesFor,
  ongoingSequenceByActivity: PLAY_ONGOING_SEQUENCE,
  holdFrameByActivity: PLAY_HOLD_FRAME,
  sequences: PLAYGROUND_SEQUENCE_TABLE,
}

export function playgroundAnimationPlanFor(cat: PlayCat, now: number): AnimationPlan {
  return animationPlanFor(cat, now, PLAYGROUND_ANIM_MAPS)
}

/** Frame → URL router: playground-only frames (bat/eat/purr) come from
    the /cats/playground/ set; everything else from the shared
    /cats/anim/ set. */
export function playFrameUrl(catId: PlaygroundCatId, frameName: string): string {
  if ((PLAYGROUND_CAT_FRAME_NAMES as readonly string[]).includes(frameName)) {
    return playgroundCatFrameUrl(catId, frameName as PlaygroundCatFrameName)
  }
  return catAnimFrameUrl(catId, frameName as CatAnimFrame)
}

/** Activities whose seated hold runs the CatLayer seated-idle
    sub-system (blink / tailflick / groom / yawn micro-beats). */
export const SEATED_IDLE_PLAY_ACTIVITIES: ReadonlySet<PlayActivity> = new Set([
  'sit',
  'judge',
  'loaf',
  'snuggle',
  'perch',
  'watch',
])
