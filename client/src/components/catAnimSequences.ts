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
  // Frames-30 wave 1 (2026-07-11): level-1 walk midpoints (m12 wraps 12→1)
  'walk_m01',
  'walk_m02',
  'walk_m03',
  'walk_m04',
  'walk_m05',
  'walk_m06',
  'walk_m07',
  'walk_m08',
  'walk_m09',
  'walk_m10',
  'walk_m11',
  'walk_m12',
  // ...and level-2 midpoints between each odd original and its m-frame
  'walk_n01',
  'walk_n03',
  'walk_n05',
  'walk_n07',
  'walk_n09',
  'walk_n11',
  'run_a',
  'run_ab',
  'run_b',
  'run_ba',
  // Frames-30 wave 1: run-ring midpoints (a↔ab, ab↔b, b↔ba, ba↔a)
  'run_m1',
  'run_m2',
  'run_m3',
  'run_m4',
  'side_stand',
  'turn',
  'turn_2',
  // Frames-30 wave 1: turn-ladder midpoints (side↔turn, turn↔turn_2, turn_2↔stand)
  'turn_0a',
  'turn_1b',
  'turn_2c',
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

// Frames-30 wave 1: the walk cycle is a 30-frame explicit list — original
// walk_XX every half-step, level-1 midpoints (walk_mXX) between originals,
// level-2 midpoints (walk_nXX) splitting each ODD original's first half.
// 30 × 38ms = 1140ms, EXACTLY the old 12 × 95ms cycle, so the stride
// calibration (STRIDE_PX_PER_CYCLE) and ground speed are untouched.
// walkFrame is derived from the step INDEX (0..29), not the filename —
// midpoint names don't parse as numbers.
export const WALK_STEP_ORDER = [
  'walk_01', 'walk_n01', 'walk_m01',
  'walk_02', 'walk_m02',
  'walk_03', 'walk_n03', 'walk_m03',
  'walk_04', 'walk_m04',
  'walk_05', 'walk_n05', 'walk_m05',
  'walk_06', 'walk_m06',
  'walk_07', 'walk_n07', 'walk_m07',
  'walk_08', 'walk_m08',
  'walk_09', 'walk_n09', 'walk_m09',
  'walk_10', 'walk_m10',
  'walk_11', 'walk_n11', 'walk_m11',
  'walk_12', 'walk_m12',
] as const satisfies readonly CatAnimFrame[]

const walk = WALK_STEP_ORDER.map((frame): CatAnimStep => ({ frame, ms: 38 }))

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
  // Frames-30 wave 1: 8-frame gallop (ring midpoints interleaved) at the
  // SAME 150ms cycle — STRIDE_PX_PER_CYCLE and the foot-slide calibration
  // are untouched. 19×6 + 18×2 = 150 exactly.
  run: allCats([
    { frame: 'run_a', ms: 19 },
    { frame: 'run_m1', ms: 19 },
    { frame: 'run_ab', ms: 19 },
    { frame: 'run_m2', ms: 18 },
    { frame: 'run_b', ms: 19 },
    { frame: 'run_m3', ms: 19 },
    { frame: 'run_ba', ms: 19 },
    { frame: 'run_m4', ms: 18 },
  ]),
  // Frames-30 wave 1: turn-ladder midpoints interleaved; totals stay 840ms
  // each (260+80+80+420 pre-wave), holds shortened to pay for the mids.
  walk_to_front: allCats([
    { frame: 'side_stand', ms: 220 },
    { frame: 'turn_0a', ms: 40 },
    { frame: 'turn', ms: 55 },
    { frame: 'turn_1b', ms: 50 },
    { frame: 'turn_2', ms: 55 },
    { frame: 'turn_2c', ms: 40 },
    { frame: 'stand', ms: 380 },
  ]),
  front_to_walk: allCats([
    { frame: 'stand', ms: 380 },
    { frame: 'turn_2c', ms: 40 },
    { frame: 'turn_2', ms: 55 },
    { frame: 'turn_1b', ms: 50 },
    { frame: 'turn', ms: 55 },
    { frame: 'turn_0a', ms: 40 },
    { frame: 'side_stand', ms: 220 },
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
  // Turn-around pivot (2026-07-11, "cats turn around soo slowly"):
  // replaces the 220ms CSS scaleX mirror-morph for walking direction
  // reversals. Classic sprite pivot — rotate side→front on the OLD
  // facing, mirror-flip exactly at the symmetric frontal `stand` frame
  // (the seam is invisible there), rotate front→side on the NEW facing.
  // The render layer flips facing at duration/2, which by construction
  // lands inside the centered `stand` step — keep `stand` centered.
  // Frames-30 wave 1: the ladder gained its midpoints (turn_0a/1b/2c),
  // 11 steps at the SAME totals (330ms / 205ms) so pivot feel is
  // unchanged — just twice the rotation resolution.
  turn_around: allCats([
    { frame: 'turn_0a', ms: 30 },
    { frame: 'turn', ms: 30 },
    { frame: 'turn_1b', ms: 30 },
    { frame: 'turn_2', ms: 30 },
    { frame: 'turn_2c', ms: 30 },
    { frame: 'stand', ms: 30 },
    { frame: 'turn_2c', ms: 30 },
    { frame: 'turn_2', ms: 30 },
    { frame: 'turn_1b', ms: 30 },
    { frame: 'turn', ms: 30 },
    { frame: 'turn_0a', ms: 30 },
  ]),
  // Sprint variant for chase/flee wall bounces — same pivot at whip
  // speed so a mid-chase reversal keeps its energy. 205ms exact; the
  // first five steps sum to 94 and stand ends at 113, so the flip at
  // 102.5 stays inside the frontal frame.
  turn_around_fast: allCats([
    { frame: 'turn_0a', ms: 19 },
    { frame: 'turn', ms: 19 },
    { frame: 'turn_1b', ms: 19 },
    { frame: 'turn_2', ms: 18 },
    { frame: 'turn_2c', ms: 19 },
    { frame: 'stand', ms: 19 },
    { frame: 'turn_2c', ms: 18 },
    { frame: 'turn_2', ms: 19 },
    { frame: 'turn_1b', ms: 18 },
    { frame: 'turn', ms: 19 },
    { frame: 'turn_0a', ms: 18 },
  ]),
} as const satisfies Record<string, PerCatSequence>

export type CatAnimSequenceName = keyof typeof CAT_ANIM_SEQUENCES

export const CYCLE_DURATION_MS = {
  walk: 30 * 38, // 1140 — same cycle as the old 12 × 95, 30 frames deep
  run: 19 * 6 + 18 * 2, // 150 — same cycle, 8 gallop frames
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
