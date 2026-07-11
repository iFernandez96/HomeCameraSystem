import {
  CAT_ANIM_SEQUENCES,
  catAnimFrameUrl,
  type CatAnimFrame,
  type CatAnimSequenceName,
} from '../components/catAnimSequences'
import {
  POSE_TRANSITIONS,
  animationPlanFor,
  frameFromSteps,
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
import type { GroundPoopSpawn } from '../components/GroundPoop'
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
  | 'scratch' // scratching bout at the post (dedicated standing-stretch frames)
  | 'eat' // eat bout at the food bowl or a treat
  | 'drink' // lapping bout at the water bowl
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
  /** Rendered depth cross-fade, 0 = front lane scale, 1 = back lane
      scale. Chases `lane` at a fixed rate in stepPlayground so a lane
      switch never pops the sprite's size in a single frame. */
  laneBlend: number
  /** Horizontal travel may not begin before this stamp: the pose
      transition into the walk plays out first (plus a small jittered
      "look before you go" hold for autonomous beats), then the gait
      eases in — never 0-to-full-stride while still standing up. */
  moveRampAt: number
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
  /** True while the CURRENT travel involves a vertical mount/dismount
      (an elevated origin or destination anchor) — the render layer
      swaps the walk gait for the climb loop wherever the leg still has
      vertical distance to cover. Reset by every activity switch. */
  climbTravel: boolean
  /** Live per-tick render flag: this frame the cat is actually lerping
      up/down a climbTravel leg, so PlaygroundCat plays climb_a/b. */
  climbing: boolean
  /** When the cat acquired its current anchor (continuous-stay clock —
      in-place beats on the same anchor do NOT reset it). */
  anchorSince: number
  /** RESIDUAL B (2026-07-11, Panther glued to the tree): hard deadline
      for a single continuous stay on an elevated anchor, jittered
      12–20s at acquisition. Expiring past it forces a dismount stroll. */
  perchDwellDeadline: number
  /** No-repeat window after dismounting an elevated anchor: this
      anchor reads as occupied to the cat's own beat rolls until the
      stamp passes, so she does something else before re-perching. */
  anchorCooldownId: string | null
  anchorCooldownUntil: number
  petStartedAt: number | null
  /** Ground poop lifecycle (2026-07-11): spawned when a floor squat
      COMPLETES (litter-box squats stay hidden in the box), anchored in
      scene coordinates so it stays put while the cat walks away, then
      fades. One per cat — anti-repeat means no double squat inside a
      lifecycle window. */
  poop: (GroundPoopSpawn & { y: number; lane: PlaygroundLane }) | null
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

// RESIDUAL B constants — a single perch stay is capped (jittered) and a
// dismounted anchor is off the menu for a short window.
export const PERCH_DWELL_MIN_MS = 12000
export const PERCH_DWELL_RANGE_MS = 8000
export const PERCH_NO_REPEAT_MS = 20000

/** Jittered continuous-stay deadline for an elevated anchor acquired at
    `now` (~12–20s). */
export function perchDwellDeadlineFor(now: number, random: () => number): number {
  return now + PERCH_DWELL_MIN_MS + random() * PERCH_DWELL_RANGE_MS
}

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
    // Every activity switch closes any climb leg; travel starters that
    // mount/dismount re-arm climbTravel explicitly after this call.
    climbTravel: false,
    climbing: false,
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
  compact = false,
): PlayCat {
  const homeId = HOME_ANCHOR[id]
  const home = anchorById(homeId)
  const pose = HOME_POSE[id]
  const base: PlayCat = {
    id,
    x: anchorCatX(home, sceneW, compact),
    y: anchorCatY(home, sceneW, sceneH, compact),
    lane: home.lane,
    laneBlend: home.lane === 'back' ? 1 : 0,
    moveRampAt: 0,
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
    climbTravel: false,
    climbing: false,
    anchorSince: now,
    perchDwellDeadline: perchDwellDeadlineFor(now, random),
    anchorCooldownId: null,
    anchorCooldownUntil: 0,
    petStartedAt: null,
    poop: null,
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
  compact = false,
): PlaygroundState {
  return {
    cats: (['panther', 'mushu', 'coco'] as const).map((id) =>
      buildHomeCat(id, now, sceneW, sceneH, random, compact),
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
  scratch_bout: perCat(PLAYGROUND_SEQUENCES.scratch_bout),
  drink_bout: perCat(PLAYGROUND_SEQUENCES.drink_bout),
  climb: perCat(PLAYGROUND_SEQUENCES.climb),
  hammock_hold: perCat(PLAYGROUND_SEQUENCES.hammock_hold),
  window_hold: perCat(PLAYGROUND_SEQUENCES.window_hold),
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
  // The scratch frames are a standing full-body stretch at the post
  // (160-tall canvases), so the pose chain stands the cat up rather
  // than crouching it down.
  scratch: 'standing',
  bat: 'crouched',
  eat: 'crouched',
  drink: 'crouched',
  tunnel: 'crouched',
  hiss: 'standing',
  scared: 'standing',
}

// Interaction wave 2026-07-11: the jump_post arrival pop is RETIRED for
// the vertical mounts (perch / hammock / watch) — the climb loop now
// covers the ascent while the cat actually lerps up (see PlayCat.
// climbTravel), which reads far better than teleport-then-pop. Nothing
// currently re-enters here; low floor-level hops (litter box, tunnel)
// never had an entry pop and read fine without one (the tunnel cat is
// hidden anyway). Keep this map as the slot for future arrival flair.
const PLAY_ENTRY_SEQUENCES: Partial<Record<PlayActivity, readonly CatAnimSequenceName[]>> = {}

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
  scratch: seq('scratch_bout'), // dedicated standing-stretch strokes
  bat: seq('bat_bout'),
  eat: seq('eat_bout'),
  drink: seq('drink_bout'),
}

export const PLAY_HOLD_FRAME: Partial<Record<PlayActivity, CatAnimFrame>> = {
  sit: 'seated',
  judge: 'seated',
  loaf: 'seated',
  // Cat TV: the BACK-VIEW seated hold sells "watching out the window";
  // the tailflick micro-life briefly interrupts it (that composes).
  watch: frame('window_watch'),
  perch: 'seated',
  snuggle: 'seated',
  sleep: 'sleep',
  // Draped side-lie for the hammock nap (breathe pulse on the render).
  hammock: frame('hammock_lie'),
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

// The climb loop is travel-phase state, not an activity: while a mount/
// dismount leg still has vertical distance, the cling frames override
// the walk gait (stepPlayground maintains cat.climbing per tick).
const CLIMB_STEPS = PLAYGROUND_SEQUENCES.climb as unknown as readonly {
  frame: CatAnimFrame
  ms: number
}[]

export function playgroundAnimationPlanFor(cat: PlayCat, now: number): AnimationPlan {
  if (cat.climbing) {
    return {
      frame: frameFromSteps(CLIMB_STEPS, Math.max(0, now - cat.activityStartedAt), true),
      framesToPreload: CLIMB_STEPS.map((step) => step.frame),
      walkFrame: undefined,
    }
  }
  return animationPlanFor(cat, now, PLAYGROUND_ANIM_MAPS)
}

/** Total duration of the pose-transition chain from one activity into
    another (wake_up / stand-up / turn frames). Travel starters gate
    horizontal motion on this so a cat finishes getting up before its
    paws start moving — no more sliding sleepers. */
export function playTransitionDurationMs(
  catId: PlaygroundCatId,
  from: PlayActivity,
  to: PlayActivity,
): number {
  return playTransitionNamesFor(from, to).reduce(
    (total, name) => total + sequenceDurationMsOf(name, catId),
    0,
  )
}

function sequenceDurationMsOf(name: CatAnimSequenceName, catId: PlaygroundCatId): number {
  const steps = CAT_ANIM_SEQUENCES[name]?.[catId] ?? []
  return steps.reduce((total, step) => total + step.ms, 0)
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
