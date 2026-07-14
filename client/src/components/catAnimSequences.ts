export const CAT_IDS = ['panther', 'mushu', 'coco'] as const

export type CatAnimId = (typeof CAT_IDS)[number]

const SHARED_FRAMES = [
  'walk_01',
  'walk_02',
  'walk_03',
  'walk_04',
  'walk_05',
  'walk_06',
  'walk_07',
  'walk_08',
  'walk_09',
  'walk_10',
  'walk_11',
  'walk_12',
  'run_a',
  'run_b',
  'side_stand',
  'turn',
  'stand',
  'sit_a',
  'sit_b',
  'seated',
  'tailflick',
  'groom_a',
  'groom_b',
  'yawn',
  'sleep_a',
  'sleep_a2',
  'sleep_mid',
  'sleep_b',
  'sleep',
  'crouch_a',
  'crouch_mid',
  'crouch_b',
  'crouch',
  'poop_squat_a',
  'poop_squat_b',
  'pounce_launch',
  'pounce_air',
  'pounce_land',
  'jump_post',
  'hiss_windup',
] as const

export type CatAnimFrame =
  | (typeof SHARED_FRAMES)[number]
  | 'blink'
  | 'crouch_a2'
  | 'crouch_b2'
  | 'sleep_b2'

/** The checked-in asset manifest. Coco deliberately has no blink.
    crouch_b2 (Panther) and sleep_b2 (Coco) are the 2026-07-11 tween
    inserts fixing the two v3 triple-check blockers (crouch snap /
    sleep-endpoint snap). */
export const CAT_ANIM_MANIFEST: Record<CatAnimId, readonly CatAnimFrame[]> = {
  panther: [...SHARED_FRAMES, 'blink', 'crouch_a2', 'crouch_b2'],
  mushu: [...SHARED_FRAMES, 'blink'],
  coco: [...SHARED_FRAMES, 'sleep_b2'],
}

export type CatAnimStep = Readonly<{
  frame: CatAnimFrame
  ms: number
}>

type PerCatSequence = Readonly<Record<CatAnimId, readonly CatAnimStep[]>>

const allCats = (steps: readonly CatAnimStep[]): PerCatSequence => ({
  panther: steps,
  mushu: steps,
  coco: steps,
})

const walk = Array.from({ length: 12 }, (_, index): CatAnimStep => ({
  frame: `walk_${String(index + 1).padStart(2, '0')}` as CatAnimFrame,
  ms: 95,
}))

const crouchShared: readonly CatAnimStep[] = [
  { frame: 'crouch_a', ms: 130 },
  { frame: 'crouch_mid', ms: 140 },
  { frame: 'crouch_b', ms: 150 },
  { frame: 'crouch', ms: 1 },
]

const crouchPanther: readonly CatAnimStep[] = [
  { frame: 'crouch_a', ms: 130 },
  { frame: 'crouch_a2', ms: 140 },
  { frame: 'crouch_mid', ms: 140 },
  { frame: 'crouch_b', ms: 150 },
  { frame: 'crouch_b2', ms: 140 },
  { frame: 'crouch', ms: 1 },
]

const sleepDownShared: readonly CatAnimStep[] = [
  { frame: 'sleep_a', ms: 300 },
  { frame: 'sleep_a2', ms: 190 },
  { frame: 'sleep_mid', ms: 170 },
  { frame: 'sleep_b', ms: 160 },
  { frame: 'sleep', ms: 1 },
]

const wakeUpShared: readonly CatAnimStep[] = [
  { frame: 'sleep', ms: 160 },
  { frame: 'sleep_b', ms: 160 },
  { frame: 'sleep_mid', ms: 160 },
  { frame: 'sleep_a2', ms: 160 },
  { frame: 'sleep_a', ms: 160 },
  { frame: 'seated', ms: 1 },
]

/**
 * Declarative choreography. The final 1ms step in a transition is its hold
 * pose; callers clamp there instead of looping unless the sequence is a gait
 * or an explicitly repeating bout.
 */
export const CAT_ANIM_SEQUENCES = {
  walk: allCats(walk),
  run: allCats([
    { frame: 'run_a', ms: 75 },
    { frame: 'run_b', ms: 75 },
  ]),
  walk_to_front: allCats([
    { frame: 'side_stand', ms: 260 },
    { frame: 'turn', ms: 160 },
    { frame: 'stand', ms: 420 },
  ]),
  front_to_walk: allCats([
    { frame: 'stand', ms: 420 },
    { frame: 'turn', ms: 160 },
    { frame: 'side_stand', ms: 260 },
  ]),
  stand_to_seated: allCats([
    { frame: 'stand', ms: 1 },
    { frame: 'sit_a', ms: 130 },
    { frame: 'sit_b', ms: 150 },
    { frame: 'seated', ms: 1 },
  ]),
  seated_to_stand: allCats([
    { frame: 'seated', ms: 1 },
    { frame: 'sit_b', ms: 150 },
    { frame: 'sit_a', ms: 130 },
    { frame: 'stand', ms: 1 },
  ]),
  sleep_down: {
    panther: sleepDownShared,
    mushu: sleepDownShared,
    // Coco gets the sleep_b2 tween before the endpoint — her sleep_b →
    // sleep contraction was the v3 blocker.
    coco: [
      { frame: 'sleep_a', ms: 300 },
      { frame: 'sleep_a2', ms: 190 },
      { frame: 'sleep_mid', ms: 170 },
      { frame: 'sleep_b', ms: 160 },
      { frame: 'sleep_b2', ms: 150 },
      { frame: 'sleep', ms: 1 },
    ],
  },
  wake_up: {
    panther: wakeUpShared,
    mushu: wakeUpShared,
    coco: [
      { frame: 'sleep', ms: 160 },
      { frame: 'sleep_b2', ms: 150 },
      { frame: 'sleep_b', ms: 160 },
      { frame: 'sleep_mid', ms: 160 },
      { frame: 'sleep_a2', ms: 160 },
      { frame: 'sleep_a', ms: 160 },
      { frame: 'seated', ms: 1 },
    ],
  },
  crouch_down: {
    panther: crouchPanther,
    mushu: crouchShared,
    coco: crouchShared,
  },
  crouch_up: {
    panther: [...crouchPanther].reverse().concat({ frame: 'seated', ms: 1 }),
    mushu: [...crouchShared].reverse().concat({ frame: 'seated', ms: 1 }),
    coco: [...crouchShared].reverse().concat({ frame: 'seated', ms: 1 }),
  },
  // The 'pooped' activity bout. Loops while the activity is active;
  // comedic quickening — each strain a touch shorter than the last.
  poop_squat: allCats([
    { frame: 'poop_squat_a', ms: 700 },
    { frame: 'poop_squat_b', ms: 500 },
    { frame: 'poop_squat_a', ms: 600 },
    { frame: 'poop_squat_b', ms: 400 },
  ]),
  pounce: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'pounce_launch', ms: 100 },
    { frame: 'pounce_air', ms: 130 },
    { frame: 'pounce_land', ms: 200 },
    { frame: 'crouch', ms: 1 },
  ]),
  jump_post: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'jump_post', ms: 150 },
  ]),
  hiss_windup: allCats([{ frame: 'hiss_windup', ms: 240 }]),
  blink: {
    panther: [{ frame: 'blink', ms: 140 }],
    mushu: [{ frame: 'blink', ms: 140 }],
    coco: [],
  },
  tailflick: allCats([{ frame: 'tailflick', ms: 450 }]),
  groom_bout: allCats([
    { frame: 'groom_a', ms: 420 },
    { frame: 'groom_b', ms: 480 },
    { frame: 'groom_a', ms: 420 },
    { frame: 'groom_b', ms: 480 },
    { frame: 'seated', ms: 1 },
  ]),
  yawn: allCats([
    { frame: 'yawn', ms: 900 },
    { frame: 'seated', ms: 1 },
  ]),
} as const satisfies Record<string, PerCatSequence>

export type CatAnimSequenceName = keyof typeof CAT_ANIM_SEQUENCES

export const CYCLE_DURATION_MS = {
  walk: 12 * 95,
  run: 2 * 75,
} as const

/**
 * Paw-contact calibration expressed as rendered body widths per full cycle.
 * A walk cycle covers two half-cycles at 0.55 body-width each; the short run
 * cycle covers 0.38 body-width, which also keeps a dt-clamped 36px cat below
 * a 3px run step. Keeping this beside the frame timing makes
 * horizontal velocity impossible to tune independently and reintroduce slide.
 */
export const STRIDE_PX_PER_CYCLE = {
  walk: (bodyWidthPx: number) => bodyWidthPx * 1.1,
  run: (bodyWidthPx: number) => bodyWidthPx * 0.38,
} as const

export function gaitVelocityPxPerMs(
  gait: keyof typeof CYCLE_DURATION_MS,
  bodyWidthPx: number,
): number {
  return STRIDE_PX_PER_CYCLE[gait](bodyWidthPx) / CYCLE_DURATION_MS[gait]
}

export function sequenceDurationMs(steps: readonly CatAnimStep[]): number {
  return steps.reduce((total, step) => total + step.ms, 0)
}

export function catAnimFrameUrl(catId: CatAnimId, frame: CatAnimFrame): string {
  return `/cats/anim/${encodeURIComponent(catId)}/${encodeURIComponent(frame)}.png`
}
