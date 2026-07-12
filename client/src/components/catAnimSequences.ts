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
  'run_ab',
  'run_b',
  'run_ba',
  'side_stand',
  'turn',
  'turn_2',
  'stand',
  'sit_0a',
  'sit_a',
  'sit_ab',
  'sit_b',
  'sit_b1',
  'seated',
  'tailflick',
  'groom_a',
  'groom_ab',
  'groom_b',
  'yawn_0',
  'yawn',
  'sleep_a',
  'sleep_a2',
  'sleep_mid',
  'sleep_b',
  'sleep',
  'crouch_a',
  'crouch_a2',
  'crouch_mid',
  'crouch_b',
  'crouch_b2',
  'crouch',
  'poop_squat_a',
  'squat_ab',
  'poop_squat_b',
  'pounce_launch',
  'pounce_l2',
  'pounce_air',
  'pounce_a2',
  'pounce_land',
  'jump_post',
  'hiss_windup',
] as const

export type CatAnimFrame =
  | (typeof SHARED_FRAMES)[number]
  | 'blink'
  | 'sleep_b2'

/** The checked-in asset manifest. Coco deliberately has no blink.
    sleep_b2 (Coco) is the 2026-07-11 tween insert fixing the v3
    sleep-endpoint snap. The tween-wave-2 in-betweens (run_ab/ba,
    sit_0a/ab/b1, turn_2, yawn_0, groom_ab, squat_ab, pounce_l2/a2)
    are shared across all three cats — and crouch_a2/b2, once
    Panther-only, are now shared too, so the crouch asymmetry is gone. */
export const CAT_ANIM_MANIFEST: Record<CatAnimId, readonly CatAnimFrame[]> = {
  panther: [...SHARED_FRAMES, 'blink'],
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

// Tween wave 2 (2026-07-11): all three cats now carry crouch_a2/b2,
// so the once-Panther-only 6-frame chain (the v3 crouch-snap fix) is
// simply THE crouch chain. Mushu/Coco inherit Panther's calibrated
// timing rather than compressing it — the extra ~280ms is the smooth
// settle the tweens exist to buy.
const crouchDown: readonly CatAnimStep[] = [
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
  // Tween wave 2: 4-frame gallop (a → ab → b → ba) at the SAME 150ms
  // cycle — per-step ms halves as the frame count doubles, so
  // STRIDE_PX_PER_CYCLE and the foot-slide calibration are untouched.
  run: allCats([
    { frame: 'run_a', ms: 38 },
    { frame: 'run_ab', ms: 37 },
    { frame: 'run_b', ms: 38 },
    { frame: 'run_ba', ms: 37 },
  ]),
  walk_to_front: allCats([
    { frame: 'side_stand', ms: 260 },
    { frame: 'turn', ms: 80 },
    { frame: 'turn_2', ms: 80 },
    { frame: 'stand', ms: 420 },
  ]),
  front_to_walk: allCats([
    { frame: 'stand', ms: 420 },
    { frame: 'turn_2', ms: 80 },
    { frame: 'turn', ms: 80 },
    { frame: 'side_stand', ms: 260 },
  ]),
  stand_to_seated: allCats([
    { frame: 'stand', ms: 1 },
    { frame: 'sit_0a', ms: 56 },
    { frame: 'sit_a', ms: 56 },
    { frame: 'sit_ab', ms: 56 },
    { frame: 'sit_b', ms: 56 },
    { frame: 'sit_b1', ms: 56 },
    { frame: 'seated', ms: 1 },
  ]),
  seated_to_stand: allCats([
    { frame: 'seated', ms: 1 },
    { frame: 'sit_b1', ms: 56 },
    { frame: 'sit_b', ms: 56 },
    { frame: 'sit_ab', ms: 56 },
    { frame: 'sit_a', ms: 56 },
    { frame: 'sit_0a', ms: 56 },
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
  crouch_down: allCats(crouchDown),
  crouch_up: allCats([...crouchDown].reverse().concat({ frame: 'seated', ms: 1 })),
  // The 'pooped' activity bout. Loops while the activity is active;
  // comedic quickening — each strain a touch shorter than the last.
  // Tween wave 2: squat_ab rides every a↔b flank (including the loop
  // wrap b→a), each donor step split in half so the 2200ms bout and
  // its quickening cadence (700→500→600→400 pairs) are preserved.
  poop_squat: allCats([
    { frame: 'poop_squat_a', ms: 350 },
    { frame: 'squat_ab', ms: 350 },
    { frame: 'poop_squat_b', ms: 250 },
    { frame: 'squat_ab', ms: 250 },
    { frame: 'poop_squat_a', ms: 300 },
    { frame: 'squat_ab', ms: 300 },
    { frame: 'poop_squat_b', ms: 200 },
    { frame: 'squat_ab', ms: 200 },
  ]),
  pounce: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'pounce_launch', ms: 50 },
    { frame: 'pounce_l2', ms: 50 },
    { frame: 'pounce_air', ms: 65 },
    { frame: 'pounce_a2', ms: 65 },
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
  // groom_ab is the symmetric midpoint — the same in-between serves
  // a→b and b→a licks. Donor steps split in half; the final groom_b
  // keeps its full 480ms so the 1801ms bout total is exact.
  groom_bout: allCats([
    { frame: 'groom_a', ms: 210 },
    { frame: 'groom_ab', ms: 210 },
    { frame: 'groom_b', ms: 240 },
    { frame: 'groom_ab', ms: 240 },
    { frame: 'groom_a', ms: 210 },
    { frame: 'groom_ab', ms: 210 },
    { frame: 'groom_b', ms: 480 },
    { frame: 'seated', ms: 1 },
  ]),
  // yawn_0 is the seated→gape lead-in; it borrows from the hold so
  // the 901ms total stands.
  yawn: allCats([
    { frame: 'yawn_0', ms: 150 },
    { frame: 'yawn', ms: 750 },
    { frame: 'seated', ms: 1 },
  ]),
} as const satisfies Record<string, PerCatSequence>

export type CatAnimSequenceName = keyof typeof CAT_ANIM_SEQUENCES

export const CYCLE_DURATION_MS = {
  walk: 12 * 95,
  run: 38 + 37 + 38 + 37, // 150 — same cycle, 4 gallop frames
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
  return `/cats/anim/${catId}/${frame}.png`
}
