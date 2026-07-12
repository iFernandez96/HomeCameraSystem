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
  // Frames-30 burst 3: sit-chain midpoints (stand↔0a, 0a↔a, a↔ab, ab↔b,
  // b↔b1, b1↔seated)
  'sit_m0',
  'sit_m1',
  'sit_m2',
  'sit_m3',
  'sit_m4',
  'sit_m5',
  'seated',
  'tailflick',
  'groom_a',
  'groom_ab',
  'groom_b',
  'yawn_0',
  'yawn_1',
  'yawn',
  'sleep_a',
  'sleep_a2',
  'sleep_mid',
  'sleep_b',
  'sleep',
  // Frames-30 burst 3: sleep-chain midpoints (a↔a2, a2↔mid, mid↔b, b↔sleep)
  'sleep_m1',
  'sleep_m2',
  'sleep_m3',
  'sleep_m4',
  'crouch_a',
  'crouch_a2',
  'crouch_mid',
  'crouch_b',
  'crouch_b2',
  'crouch',
  // Frames-30 burst 3: crouch-chain midpoints (a↔a2, mid↔b)
  'crouch_m1',
  'crouch_m2',
  'poop_squat_a',
  'squat_ab',
  'poop_squat_b',
  'pounce_launch',
  'pounce_l2',
  'pounce_air',
  'pounce_a2',
  // Frames-30 wave 2: pounce arc second-level midpoints
  'pounce_n1',
  'pounce_n2',
  'pounce_n3',
  'pounce_n4',
  'pounce_land',
  'jump_post',
  'hiss_windup',
  // Frames-30 wave 2b/2c: groom variants (chest + hind-leg), pounce
  // windup shimmy, missed-pounce tumble, comic poop-strain faces, the
  // dirt-kick exit, and the post-yawn blep.
  'gchest_a',
  'gchest_ab',
  'gchest_b',
  'gleg_a',
  'gleg_ab',
  'gleg_b',
  'wiggle_a',
  'wiggle_ab',
  'wiggle_b',
  'tumble_a',
  'tumble_ab',
  'tumble_b',
  'strain_a',
  'strain_b',
  'kick_0',
  'kick_a',
  'blep',
  // Frames-30 burst 4/5: variant sets shared by ALL three cats — bounding
  // gallop, tail-wrap settle, slump-into-loaf, sleep breathing + dream
  // twitch, wake stretch, and the look-back glance base (lookback_0/a).
  'bound_a',
  'bound_ab',
  'bound_b',
  'tailwrap_a',
  'tailwrap_ab',
  'tailwrap_b',
  'slump_a',
  'slump_ab',
  'slump_b',
  'wakestretch_a',
  'wakestretch_ab',
  'wakestretch_b',
  'breath_a',
  'breath_b',
  'dream_a',
  'dream_b',
  'lookback_0',
  'lookback_a',
  // Frames-30 wave 3: character/comedy — Halloween-arch hiss escalation,
  // scared retreat + shake-off recovery, happy-hop and tail-chase play
  // variants, and the pawraise/earflick micro-idles.
  'arch_a',
  'arch_ab',
  'arch_b',
  'retreat_a',
  'retreat_ab',
  'retreat_b',
  'shake_a',
  'shake_ab',
  'shake_b',
  'hop_a',
  'hop_ab',
  'hop_b',
  'pawraise_a',
  'tailhunt_a',
  'tailhunt_ab',
  'tailhunt_b',
  'earflick_a',
  // Frames-30 wave 4: seated micro-life — weight shift, look-around head
  // pans (look_0a/b are the seated↔lookaround mids), seated paw stretch.
  'weightshift_a',
  'lookaround_a',
  'lookaround_b',
  'look_0a',
  'look_0b',
  'stretch_paws_a',
] as const

// Frames-30 burst 4/5 per-cat drops (codex deformed twice → dropped, same
// policy as coco's climb_ab): mushu has NO lope frames; coco has NO
// lookback_ab (her glance is a 2-step: lookback_0 → lookback_a).
const LOPE_FRAMES = ['lope_a', 'lope_ab', 'lope_b'] as const

export type CatAnimFrame =
  | (typeof SHARED_FRAMES)[number]
  | 'blink'
  | 'sleep_b2'
  | (typeof LOPE_FRAMES)[number]
  | 'lookback_ab'

/** The checked-in asset manifest. Coco deliberately has no blink.
    sleep_b2 (Coco) is the 2026-07-11 tween insert fixing the v3
    sleep-endpoint snap. The tween-wave-2 in-betweens (run_ab/ba,
    sit_0a/ab/b1, turn_2, yawn_0, groom_ab, squat_ab, pounce_l2/a2)
    are shared across all three cats — and crouch_a2/b2, once
    Panther-only, are now shared too, so the crouch asymmetry is gone.
    Frames-30 variants: lope is panther+coco, lookback_ab panther+mushu
    (each dropped for the third cat after two deformed generations). */
export const CAT_ANIM_MANIFEST: Record<CatAnimId, readonly CatAnimFrame[]> = {
  panther: [...SHARED_FRAMES, 'blink', ...LOPE_FRAMES, 'lookback_ab'],
  mushu: [...SHARED_FRAMES, 'blink', 'lookback_ab'],
  coco: [...SHARED_FRAMES, 'sleep_b2', ...LOPE_FRAMES],
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
// Frames-30 burst 3: crouch_m1/m2 split the a→a2 and mid→b strides —
// donor ms halves, so the chain total stays exactly 701ms.
const crouchDown: readonly CatAnimStep[] = [
  { frame: 'crouch_a', ms: 65 },
  { frame: 'crouch_m1', ms: 65 },
  { frame: 'crouch_a2', ms: 140 },
  { frame: 'crouch_mid', ms: 70 },
  { frame: 'crouch_m2', ms: 70 },
  { frame: 'crouch_b', ms: 150 },
  { frame: 'crouch_b2', ms: 140 },
  { frame: 'crouch', ms: 1 },
]

// Frames-30 burst 3: every sleep stride splits with its midpoint — donor
// ms halves (300→150+150, 190→95+95, 170→85+85, 160→80+80); 821ms exact.
const sleepDownShared: readonly CatAnimStep[] = [
  { frame: 'sleep_a', ms: 150 },
  { frame: 'sleep_m1', ms: 150 },
  { frame: 'sleep_a2', ms: 95 },
  { frame: 'sleep_m2', ms: 95 },
  { frame: 'sleep_mid', ms: 85 },
  { frame: 'sleep_m3', ms: 85 },
  { frame: 'sleep_b', ms: 80 },
  { frame: 'sleep_m4', ms: 80 },
  { frame: 'sleep', ms: 1 },
]

const wakeUpShared: readonly CatAnimStep[] = [
  { frame: 'sleep', ms: 80 },
  { frame: 'sleep_m4', ms: 80 },
  { frame: 'sleep_b', ms: 80 },
  { frame: 'sleep_m3', ms: 80 },
  { frame: 'sleep_mid', ms: 80 },
  { frame: 'sleep_m2', ms: 80 },
  { frame: 'sleep_a2', ms: 80 },
  { frame: 'sleep_m1', ms: 80 },
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
  // Frames-30 burst 3: sit_m0..m5 interleave the whole chain → 13 steps.
  // Interior ms [25,26]×alternating sums exactly 280, so with the two 1ms
  // endpoint holds the total stays the calibrated 282ms.
  stand_to_seated: allCats([
    { frame: 'stand', ms: 1 },
    { frame: 'sit_m0', ms: 25 },
    { frame: 'sit_0a', ms: 26 },
    { frame: 'sit_m1', ms: 25 },
    { frame: 'sit_a', ms: 26 },
    { frame: 'sit_m2', ms: 25 },
    { frame: 'sit_ab', ms: 26 },
    { frame: 'sit_m3', ms: 25 },
    { frame: 'sit_b', ms: 26 },
    { frame: 'sit_m4', ms: 25 },
    { frame: 'sit_b1', ms: 26 },
    { frame: 'sit_m5', ms: 25 },
    { frame: 'seated', ms: 1 },
  ]),
  seated_to_stand: allCats([
    { frame: 'seated', ms: 1 },
    { frame: 'sit_m5', ms: 25 },
    { frame: 'sit_b1', ms: 26 },
    { frame: 'sit_m4', ms: 25 },
    { frame: 'sit_b', ms: 26 },
    { frame: 'sit_m3', ms: 25 },
    { frame: 'sit_ab', ms: 26 },
    { frame: 'sit_m2', ms: 25 },
    { frame: 'sit_a', ms: 26 },
    { frame: 'sit_m1', ms: 25 },
    { frame: 'sit_0a', ms: 26 },
    { frame: 'sit_m0', ms: 25 },
    { frame: 'stand', ms: 1 },
  ]),
  sleep_down: {
    panther: sleepDownShared,
    mushu: sleepDownShared,
    // Coco gets the sleep_b2 tween before the endpoint — her sleep_b →
    // sleep contraction was the v3 blocker. sleep_m4 (the b↔sleep 50%
    // midpoint) is SKIPPED for her: b2 already occupies that stretch and
    // interleaving an independently-generated 50% pose next to it risks a
    // non-monotonic wobble. Total stays 971ms.
    coco: [
      { frame: 'sleep_a', ms: 150 },
      { frame: 'sleep_m1', ms: 150 },
      { frame: 'sleep_a2', ms: 95 },
      { frame: 'sleep_m2', ms: 95 },
      { frame: 'sleep_mid', ms: 85 },
      { frame: 'sleep_m3', ms: 85 },
      { frame: 'sleep_b', ms: 160 },
      { frame: 'sleep_b2', ms: 150 },
      { frame: 'sleep', ms: 1 },
    ],
  },
  wake_up: {
    panther: wakeUpShared,
    mushu: wakeUpShared,
    // Reverse interleave, same m4-skip judgment; total stays 951ms.
    coco: [
      { frame: 'sleep', ms: 160 },
      { frame: 'sleep_b2', ms: 150 },
      { frame: 'sleep_b', ms: 80 },
      { frame: 'sleep_m3', ms: 80 },
      { frame: 'sleep_mid', ms: 80 },
      { frame: 'sleep_m2', ms: 80 },
      { frame: 'sleep_a2', ms: 80 },
      { frame: 'sleep_m1', ms: 80 },
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
  // Frames-30 wave 2: the strained variant — same 8-slot quickening shape
  // and EXACT 2200ms, but the back half swaps in the comic strain faces as
  // the effort escalates. Rolled 50/50 with the plain bout per visit.
  poop_squat_strained: allCats([
    { frame: 'poop_squat_a', ms: 350 },
    { frame: 'squat_ab', ms: 350 },
    { frame: 'poop_squat_b', ms: 250 },
    { frame: 'squat_ab', ms: 250 },
    { frame: 'strain_a', ms: 300 },
    { frame: 'squat_ab', ms: 300 },
    { frame: 'strain_b', ms: 200 },
    { frame: 'squat_ab', ms: 200 },
  ]),
  // Frames-30 wave 2: second-level arc midpoints (pounce_n1..n4) — each
  // original step splits in half; the 200ms landing hit-pause and the
  // 432ms total stay exact.
  // Frames-30 wave 2: butt-wiggle anticipation (441ms shimmy) leads every
  // leap — the classic pre-pounce tell. Windup + the 11-step arc = 872ms;
  // the 200ms landing hit-pause survives unchanged.
  pounce: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'wiggle_a', ms: 110 },
    { frame: 'wiggle_ab', ms: 55 },
    { frame: 'wiggle_b', ms: 110 },
    { frame: 'wiggle_ab', ms: 55 },
    { frame: 'wiggle_a', ms: 110 },
    { frame: 'pounce_launch', ms: 25 },
    { frame: 'pounce_n1', ms: 25 },
    { frame: 'pounce_l2', ms: 25 },
    { frame: 'pounce_n2', ms: 25 },
    { frame: 'pounce_air', ms: 33 },
    { frame: 'pounce_n3', ms: 32 },
    { frame: 'pounce_a2', ms: 33 },
    { frame: 'pounce_n4', ms: 32 },
    { frame: 'pounce_land', ms: 200 },
    { frame: 'crouch', ms: 1 },
  ]),
  // The ~20% comedic MISS: same windup + arc, but the landing becomes a
  // roll-onto-back tumble (200/180/500) before the cat recovers to the
  // crouch pretending nothing happened. 1552ms total.
  pounce_tumble: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'wiggle_a', ms: 110 },
    { frame: 'wiggle_ab', ms: 55 },
    { frame: 'wiggle_b', ms: 110 },
    { frame: 'wiggle_ab', ms: 55 },
    { frame: 'wiggle_a', ms: 110 },
    { frame: 'pounce_launch', ms: 25 },
    { frame: 'pounce_n1', ms: 25 },
    { frame: 'pounce_l2', ms: 25 },
    { frame: 'pounce_n2', ms: 25 },
    { frame: 'pounce_air', ms: 33 },
    { frame: 'pounce_n3', ms: 32 },
    { frame: 'pounce_a2', ms: 33 },
    { frame: 'pounce_n4', ms: 32 },
    { frame: 'tumble_a', ms: 200 },
    { frame: 'tumble_ab', ms: 180 },
    { frame: 'tumble_b', ms: 500 },
    { frame: 'crouch', ms: 1 },
  ]),
  jump_post: allCats([
    { frame: 'crouch', ms: 1 },
    { frame: 'jump_post', ms: 150 },
  ]),
  hiss_windup: allCats([{ frame: 'hiss_windup', ms: 240 }]),
  // Frames-30 wave 3: the hiss is a full Halloween-arch escalation now —
  // windup, bristle up through the arch midpoint, then HOLD the peak arch.
  // 1200ms total; the hiss bout (1800ms nominal, jitter floor ~1404ms)
  // always outlasts it, holding arch_b via HOLD_FRAME_BY_ACTIVITY.
  hiss_arch: allCats([
    { frame: 'hiss_windup', ms: 240 },
    { frame: 'arch_a', ms: 260 },
    { frame: 'arch_ab', ms: 200 },
    { frame: 'arch_b', ms: 500 },
  ]),
  // Scared entry: back away low (661ms), then hold retreat_b until the
  // bout expires into the shake_off recovery.
  retreat: allCats([
    { frame: 'retreat_a', ms: 180 },
    { frame: 'retreat_ab', ms: 160 },
    { frame: 'retreat_b', ms: 320 },
    { frame: 'retreat_b', ms: 1 },
  ]),
  // Post-scare recovery: a quick head/fur shake, then compose yourself.
  shake_off: allCats([
    { frame: 'shake_a', ms: 140 },
    { frame: 'shake_ab', ms: 120 },
    { frame: 'shake_b', ms: 140 },
    { frame: 'shake_a', ms: 140 },
    { frame: 'side_stand', ms: 1 },
  ]),
  // Play bout variants (rotate with the pounce loop via boutVariant):
  // a bouncing hop loop and the tail-chase spin (ping-pong through the
  // C-shape midpoint so it reads as circling).
  hop_bounce: allCats([
    { frame: 'hop_a', ms: 120 },
    { frame: 'hop_ab', ms: 90 },
    { frame: 'hop_b', ms: 150 },
    { frame: 'hop_ab', ms: 90 },
  ]),
  tailhunt: allCats([
    { frame: 'tailhunt_a', ms: 260 },
    { frame: 'tailhunt_ab', ms: 200 },
    { frame: 'tailhunt_b', ms: 220 },
    { frame: 'tailhunt_ab', ms: 200 },
  ]),
  // Seated micro-idle: a playful single-paw wave.
  pawraise_wave: allCats([
    { frame: 'pawraise_a', ms: 400 },
    { frame: 'seated', ms: 1 },
  ]),
  // Standing micro-idle — defined for the playground's regard-holds
  // (the home engine has no standing-idle scheduler; see wave-3 notes).
  earflick: allCats([
    { frame: 'earflick_a', ms: 180 },
    { frame: 'side_stand', ms: 1 },
  ]),
  // Frames-30 wave 4: seated micro-life. Small, frequent beats that keep
  // a long sit alive without stealing attention — a weight shift, a head
  // pan to either side (through the look_0 mids), a little paw stretch.
  weight_shift: allCats([
    { frame: 'weightshift_a', ms: 260 },
    { frame: 'seated', ms: 1 },
  ]),
  look_around_l: allCats([
    { frame: 'look_0a', ms: 140 },
    { frame: 'lookaround_a', ms: 600 },
    { frame: 'look_0a', ms: 140 },
    { frame: 'seated', ms: 1 },
  ]),
  look_around_r: allCats([
    { frame: 'look_0b', ms: 140 },
    { frame: 'lookaround_b', ms: 600 },
    { frame: 'look_0b', ms: 140 },
    { frame: 'seated', ms: 1 },
  ]),
  seated_stretch: allCats([
    { frame: 'stretch_paws_a', ms: 700 },
    { frame: 'seated', ms: 1 },
  ]),
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
  // Frames-30 wave 2: groom target variants — same 8-step lick shape and
  // EXACT 1801ms as groom_bout so the bout scheduler can swap them freely.
  groom_chest_bout: allCats([
    { frame: 'gchest_a', ms: 210 },
    { frame: 'gchest_ab', ms: 210 },
    { frame: 'gchest_b', ms: 240 },
    { frame: 'gchest_ab', ms: 240 },
    { frame: 'gchest_a', ms: 210 },
    { frame: 'gchest_ab', ms: 210 },
    { frame: 'gchest_b', ms: 480 },
    { frame: 'seated', ms: 1 },
  ]),
  groom_leg_bout: allCats([
    { frame: 'gleg_a', ms: 210 },
    { frame: 'gleg_ab', ms: 210 },
    { frame: 'gleg_b', ms: 240 },
    { frame: 'gleg_ab', ms: 240 },
    { frame: 'gleg_a', ms: 210 },
    { frame: 'gleg_ab', ms: 210 },
    { frame: 'gleg_b', ms: 480 },
    { frame: 'seated', ms: 1 },
  ]),
  // yawn_0 is the seated→gape lead-in; wave 2 splits it with yawn_1 so
  // the mouth opens through a midpoint — the 901ms total stands.
  yawn: allCats([
    { frame: 'yawn_0', ms: 75 },
    { frame: 'yawn_1', ms: 75 },
    { frame: 'yawn', ms: 750 },
    { frame: 'seated', ms: 1 },
  ]),
  // Frames-30 wave 2: ~25% of yawns end in a blep — the tongue just...
  // stays out for a beat. 1801ms; the plain yawn keeps its 901ms.
  yawn_blep: allCats([
    { frame: 'yawn_0', ms: 75 },
    { frame: 'yawn_1', ms: 75 },
    { frame: 'yawn', ms: 750 },
    { frame: 'blep', ms: 900 },
    { frame: 'seated', ms: 1 },
  ]),
  // Frames-30 wave 2: the dirt-kick poop exit — two deliberate back-leg
  // kicks over the spot before strolling off. 721ms.
  kick_dirt: allCats([
    { frame: 'kick_0', ms: 140 },
    { frame: 'kick_a', ms: 220 },
    { frame: 'kick_0', ms: 140 },
    { frame: 'kick_a', ms: 220 },
    { frame: 'side_stand', ms: 1 },
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
  // Frames-30 variant gaits: alternate gallops rolled per chase/flee bout
  // (CatLayer's gaitVariant rotation). Both run the SAME 150ms cycle as
  // `run`, so gaitVelocityPxPerMs('run', …) stays correct whichever
  // variant renders — ground speed never depends on the roll.
  // Mushu's lope pair was dropped (deformed twice) → empty, and the
  // rotation pool simply never offers it to him (same idiom as coco's
  // empty blink).
  run_lope: {
    panther: [
      { frame: 'lope_a', ms: 38 },
      { frame: 'lope_ab', ms: 37 },
      { frame: 'lope_b', ms: 38 },
      { frame: 'lope_ab', ms: 37 },
    ],
    mushu: [],
    coco: [
      { frame: 'lope_a', ms: 38 },
      { frame: 'lope_ab', ms: 37 },
      { frame: 'lope_b', ms: 38 },
      { frame: 'lope_ab', ms: 37 },
    ],
  },
  run_bound: allCats([
    { frame: 'bound_a', ms: 38 },
    { frame: 'bound_ab', ms: 37 },
    { frame: 'bound_b', ms: 38 },
    { frame: 'bound_ab', ms: 37 },
  ]),
  // Seated idle bout: the tail sweeps around and settles over the paws.
  tailwrap_settle: allCats([
    { frame: 'tailwrap_a', ms: 220 },
    { frame: 'tailwrap_ab', ms: 220 },
    { frame: 'tailwrap_b', ms: 360 },
    { frame: 'seated', ms: 1 },
  ]),
  // Standing glance over the shoulder. Coco lacks lookback_ab (dropped),
  // so her glance is the 2-step ladder with slightly longer holds —
  // both shapes read as "heard something behind me". Not yet rolled by
  // any idle pool (the idle system is seated-only); wired for the
  // playground's look-before-go pass and future standing surfaces.
  look_back: {
    panther: [
      { frame: 'lookback_0', ms: 140 },
      { frame: 'lookback_ab', ms: 140 },
      { frame: 'lookback_a', ms: 700 },
      { frame: 'lookback_ab', ms: 140 },
      { frame: 'lookback_0', ms: 140 },
    ],
    mushu: [
      { frame: 'lookback_0', ms: 140 },
      { frame: 'lookback_ab', ms: 140 },
      { frame: 'lookback_a', ms: 700 },
      { frame: 'lookback_ab', ms: 140 },
      { frame: 'lookback_0', ms: 140 },
    ],
    coco: [
      { frame: 'lookback_0', ms: 180 },
      { frame: 'lookback_a', ms: 760 },
      { frame: 'lookback_0', ms: 180 },
    ],
  },
  // The dignity-loss slide from sitting tall into a loaf. Entry chain for
  // the loaf activity; the final 1ms slump_b is the hold pose (loaf's
  // hold frame is slump_b now — it used to fake it with `seated`).
  slump_to_loaf: allCats([
    { frame: 'slump_a', ms: 250 },
    { frame: 'slump_ab', ms: 240 },
    { frame: 'slump_b', ms: 1 },
  ]),
  // Ongoing loop while sleeping — the curl visibly breathes instead of
  // freezing. sleep_down ends on the near-identical `sleep` curl so the
  // loop start doesn't pop; both frames export at the 0.85 curl scale.
  sleep_breathe: allCats([
    { frame: 'breath_a', ms: 1400 },
    { frame: 'breath_b', ms: 1400 },
  ]),
  // Rare mid-sleep idle bout: a paw twitch and a nose scrunch, then back
  // to the breathing loop.
  dream_twitch: allCats([
    { frame: 'dream_a', ms: 320 },
    { frame: 'dream_b', ms: 320 },
    { frame: 'dream_a', ms: 260 },
    { frame: 'sleep', ms: 1 },
  ]),
  // Wake-up stretch chain (downward-dog then rear-leg follow-through).
  // Frames shipped and typed; sequence reserved for the wake choreography
  // pass — appending it to wake_up changes that chain's calibrated total,
  // which is a deliberate follow-up, not a drive-by.
  wake_stretch: allCats([
    { frame: 'wakestretch_a', ms: 480 },
    { frame: 'wakestretch_ab', ms: 300 },
    { frame: 'wakestretch_b', ms: 480 },
    { frame: 'seated', ms: 1 },
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
