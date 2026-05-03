/**
 * iter-356.4-cats — pixel-art cat illustrations modeled on the
 * three actual household cats. Drawn on a 16-px grid (each rect is
 * one pixel) so they read as 8-bit. `shape-rendering="crispEdges"`
 * disables anti-aliasing so the grid stays sharp at any size.
 *
 * Three cats:
 *   - BOMBAY ("Panther") — solid black, bright green eyes. Female.
 *     Personality: grumpy / aloof. Likes high perches.
 *   - TUXEDO ("Mushu") — black + white domino face, BLACK TAIL WITH
 *     WHITE TIP, pink nose, big whiskers. Male.
 *     Personality: playful instigator, bumps the others.
 *   - CALICO ("Coco") — white + orange + black tri-color, green eyes.
 *     Female. Personality: sleepy, often napping in baskets.
 *
 * Two view modes:
 *   - Face icons (16×16) for the wordmark trio mark.
 *   - Side-profile sprites (24×16) for the ambient CatLayer that walks
 *     along the bottom of the app + climbs to perches.
 *
 * Hand-drawn feel comes from intentional asymmetry (whisker angles
 * differ left vs right; ear pink offset by 1 px) — no SVG filters,
 * which would be GPU-expensive on the Nano-served PWA.
 */

export const CAT_PALETTE = {
  black: '#0a0a0a',
  white: '#f5f5f5',
  orange: '#f59e0b',
  greenEye: '#86efac',
  yellowEye: '#fde047',
  pinkNose: '#fda4af',
  whisker: '#a3a3a3',
} as const

type CatIconProps = {
  size?: number
  className?: string
  ariaLabel?: string
}

// === PAW MARK (decorative inline accent next to page headings) ============

/**
 * iter-356.28: small accent paw glyph used inline next to page-level
 * <h1>s. Pre-iter-356.28 the paw print only showed up on the active
 * SideNav row + active BottomNav tab — page headings were a bare
 * 2xl word ("Events", "People", …) with zero brand carry-through.
 * Browser-harness audit flagged it: the only chrome that says "this
 * app has a cat theme" beyond the nav rail was the ambient walking
 * strip at the bottom, which a logged-in user notices ~once.
 *
 * Renders a 20-px paw print in the accent color, vertically centered
 * with the adjacent text via inline-flex on the parent. Decorative
 * only (aria-hidden); the heading text is the accessible name.
 */
export function PawMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <circle cx="5" cy="10" r="2.5" />
      <circle cx="10" cy="6" r="2.5" />
      <circle cx="14" cy="6" r="2.5" />
      <circle cx="19" cy="10" r="2.5" />
      <path d="M6 18 c0-3 3-6 6-6 s6 3 6 6 c0 2-2 3-4 3 h-4 c-2 0-4-1-4-3z" />
    </svg>
  )
}

// === FACE ICONS (16×16) ===================================================

export function BombayCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <BombayFace />
    </svg>
  )
}

export function TuxedoCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <TuxedoFace />
    </svg>
  )
}

export function CalicoCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <CalicoFace />
    </svg>
  )
}

// === TRIO MARK (3 face icons in a row) ====================================

export function CatTrioMark({
  size = 48,
  className,
  ariaLabel = 'Three cats — the household watch crew',
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  return (
    <svg
      width={size}
      height={Math.round(size / 3)}
      viewBox="0 0 48 16"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      {/* iter-356.6 (Frank #1): browser tooltip on hover + SR-readable
          name. Frank's wife was asking him "what are the cats called"
          and he had to read source code to answer. <title> is the
          one-line fix that solves both desktop hover ("hovers and
          sees the names") and SR ("Three cats... Panther, Mushu, and
          Coco" in NVDA/VoiceOver). The aria-label still wins for SR
          because it's on the parent <svg>, but <title> shows in the
          browser tooltip layer too. */}
      <title>Panther, Mushu, and Coco</title>
      <BombayFace />
      <g transform="translate(16 0)">
        <TuxedoFace />
      </g>
      <g transform="translate(32 0)">
        <CalicoFace />
      </g>
    </svg>
  )
}

// === SIDE-PROFILE SPRITES (24×16, walking) ================================
// Used by the iter-356.4-cats CatLayer. Each cat is drawn facing RIGHT;
// the layer flips horizontally via CSS scaleX(-1) when walking left.

export function BombaySprite({
  size = 48,
  state = 'walk',
  className,
}: {
  size?: number
  state?: BodyState
  className?: string
}) {
  return (
    <svg
      width={(size * 24) / 16}
      height={size}
      viewBox="0 0 24 16"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      <BombayBody state={state} />
    </svg>
  )
}

export function TuxedoSprite({
  size = 48,
  state = 'walk',
  className,
}: {
  size?: number
  state?: BodyState
  className?: string
}) {
  return (
    <svg
      width={(size * 24) / 16}
      height={size}
      viewBox="0 0 24 16"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      <TuxedoBody state={state} />
    </svg>
  )
}

export function CalicoSprite({
  size = 48,
  state = 'walk',
  className,
}: {
  size?: number
  state?: BodyState
  className?: string
}) {
  return (
    <svg
      width={(size * 24) / 16}
      height={size}
      viewBox="0 0 24 16"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
    >
      <CalicoBody state={state} />
    </svg>
  )
}

// === FACE PRIMITIVES (used by both icons + trio) ==========================

function BombayFace() {
  const c = CAT_PALETTE
  return (
    <>
      <rect x="3" y="3" width="2" height="2" fill={c.black} />
      <rect x="11" y="3" width="2" height="2" fill={c.black} />
      <rect x="3.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="11.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="3" y="5" width="10" height="8" fill={c.black} />
      <rect x="2" y="6" width="1" height="6" fill={c.black} />
      <rect x="13" y="6" width="1" height="6" fill={c.black} />
      <rect x="5" y="8" width="2" height="2" fill={c.greenEye} />
      <rect x="9" y="8" width="2" height="2" fill={c.greenEye} />
      <rect x="5.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="9.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="7.5" y="11" width="1" height="1" fill={c.pinkNose} />
    </>
  )
}

function TuxedoFace() {
  const c = CAT_PALETTE
  return (
    <>
      <rect x="3" y="3" width="2" height="2" fill={c.black} />
      <rect x="11" y="3" width="2" height="2" fill={c.black} />
      <rect x="3.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="11.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="3" y="5" width="10" height="3" fill={c.black} />
      <rect x="2" y="6" width="1" height="3" fill={c.black} />
      <rect x="13" y="6" width="1" height="3" fill={c.black} />
      <rect x="4" y="8" width="8" height="5" fill={c.white} />
      <rect x="3" y="9" width="1" height="3" fill={c.white} />
      <rect x="12" y="9" width="1" height="3" fill={c.white} />
      <rect x="4" y="8" width="3" height="2" fill={c.black} />
      <rect x="9" y="8" width="3" height="2" fill={c.black} />
      <rect x="5" y="8" width="2" height="2" fill={c.yellowEye} />
      <rect x="9" y="8" width="2" height="2" fill={c.yellowEye} />
      <rect x="5.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="9.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="7.5" y="11" width="1" height="1" fill={c.pinkNose} />
    </>
  )
}

function CalicoFace() {
  const c = CAT_PALETTE
  return (
    <>
      <rect x="3" y="3" width="2" height="2" fill={c.black} />
      <rect x="11" y="3" width="2" height="2" fill={c.orange} />
      <rect x="3.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="11.5" y="4" width="1" height="1" fill={c.pinkNose} opacity="0.6" />
      <rect x="3" y="5" width="10" height="8" fill={c.white} />
      <rect x="2" y="6" width="1" height="6" fill={c.white} />
      <rect x="13" y="6" width="1" height="6" fill={c.white} />
      <rect x="3" y="5" width="3" height="3" fill={c.orange} />
      <rect x="2" y="6" width="1" height="2" fill={c.orange} />
      <rect x="10" y="5" width="3" height="3" fill={c.black} />
      <rect x="13" y="6" width="1" height="2" fill={c.black} />
      <rect x="9" y="11" width="2" height="1" fill={c.orange} />
      <rect x="5" y="8" width="2" height="2" fill={c.greenEye} />
      <rect x="9" y="8" width="2" height="2" fill={c.greenEye} />
      <rect x="5.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="9.5" y="8" width="1" height="2" fill={c.black} />
      <rect x="7.5" y="11" width="1" height="1" fill={c.pinkNose} />
    </>
  )
}

// === SIDE-PROFILE BODY PRIMITIVES =========================================
// Side-view facing right. 24 wide × 16 tall. Includes head + body + tail.
// `state` switches body posture.

type BodyState =
  | 'walk'
  | 'walk2'
  | 'sit'
  | 'sit2'
  | 'sleep'
  | 'hiss'
  | 'groom'
  | 'stretch'
  | 'play'

function legsForState(state: BodyState, baseY: number, color: string) {
  if (state === 'sleep' || state === 'sit' || state === 'sit2') {
    return null // tucked under
  }
  if (state === 'walk2') {
    // iter-356.4-cats — frame B of the walk cycle. Front-right + back-left
    // are FORWARD (advanced 1px to the right + lifted 1px); front-left +
    // back-right are BACK (shifted 1px to the left + planted on the ground).
    // Alternation with walk frame A creates the believable 2-frame walk
    // cycle vscode-pets uses at ~15fps. baseY-1 raises the lifted legs;
    // baseY keeps the planted ones flush. Slight x shift sells the "swing."
    return (
      <>
        {/* back-right: forward + lifted */}
        <rect x="10" y={baseY - 1} width="1" height="2" fill={color} />
        {/* back-left: back + planted */}
        <rect x="11" y={baseY} width="1" height="2" fill={color} />
        {/* front-right: forward + lifted */}
        <rect x="17" y={baseY - 1} width="1" height="2" fill={color} />
        {/* front-left: back + planted */}
        <rect x="18" y={baseY} width="1" height="2" fill={color} />
      </>
    )
  }
  // Walking — 4 legs offset for a mid-stride pose (frame A)
  return (
    <>
      <rect x="9" y={baseY} width="1" height="2" fill={color} />
      <rect x="12" y={baseY} width="1" height="2" fill={color} />
      <rect x="16" y={baseY} width="1" height="2" fill={color} />
      <rect x="19" y={baseY} width="1" height="2" fill={color} />
    </>
  )
}

function BombayBody({ state }: { state: BodyState }) {
  const c = CAT_PALETTE
  if (state === 'sleep') {
    return (
      <>
        {/* Curled — flat oval body */}
        <rect x="6" y="11" width="14" height="3" fill={c.black} />
        <rect x="7" y="10" width="12" height="1" fill={c.black} />
        {/* Head tucked left */}
        <rect x="4" y="9" width="4" height="3" fill={c.black} />
        <rect x="3" y="8" width="2" height="2" fill={c.black} />
        {/* Closed eye */}
        <rect x="5" y="10" width="1" height="0.4" fill={c.greenEye} opacity="0.5" />
        {/* Tail wrapped over body */}
        <rect x="18" y="9" width="2" height="1" fill={c.black} />
        <rect x="20" y="9" width="1" height="2" fill={c.black} />
      </>
    )
  }
  if (state === 'hiss') {
    // Arched back, fur raised (jagged spine), puffed tail straight up
    return (
      <>
        {/* Puffed tail — vertical, fat */}
        <rect x="2" y="3" width="2" height="6" fill={c.black} />
        <rect x="1" y="4" width="1" height="2" fill={c.black} />
        <rect x="4" y="4" width="1" height="2" fill={c.black} />
        <rect x="2" y="2" width="2" height="1" fill={c.black} />
        {/* Arched body — peak in the middle */}
        <rect x="6" y="9" width="12" height="3" fill={c.black} />
        <rect x="7" y="8" width="10" height="1" fill={c.black} />
        <rect x="9" y="7" width="6" height="1" fill={c.black} />
        {/* Raised fur spikes along spine */}
        <rect x="9" y="6" width="1" height="1" fill={c.black} />
        <rect x="11" y="6" width="1" height="1" fill={c.black} />
        <rect x="13" y="6" width="1" height="1" fill={c.black} />
        {/* Hind hip raised */}
        <rect x="4" y="10" width="3" height="3" fill={c.black} />
        {/* Head low + forward */}
        <rect x="17" y="9" width="3" height="3" fill={c.black} />
        {/* Ears flat back */}
        <rect x="17" y="8" width="1" height="1" fill={c.black} />
        <rect x="19" y="8" width="1" height="1" fill={c.black} />
        {/* Angry eye */}
        <rect x="19" y="10" width="1" height="1" fill={c.greenEye} />
        {/* Open mouth (white teeth gap) */}
        <rect x="20" y="11" width="1" height="1" fill={c.white} />
        {/* Stiff legs */}
        <rect x="6" y="13" width="1" height="2" fill={c.black} />
        <rect x="9" y="13" width="1" height="2" fill={c.black} />
        <rect x="15" y="13" width="1" height="2" fill={c.black} />
        <rect x="18" y="13" width="1" height="2" fill={c.black} />
      </>
    )
  }
  if (state === 'groom') {
    // Sitting, head tilted down, paw raised to face
    return (
      <>
        {/* Tail curled at side */}
        <rect x="3" y="11" width="3" height="2" fill={c.black} />
        <rect x="2" y="10" width="1" height="2" fill={c.black} />
        {/* Sitting body — upright haunches */}
        <rect x="7" y="10" width="10" height="3" fill={c.black} />
        <rect x="8" y="9" width="8" height="1" fill={c.black} />
        {/* Hind */}
        <rect x="6" y="11" width="2" height="2" fill={c.black} />
        {/* Head tilted DOWN */}
        <rect x="16" y="9" width="3" height="3" fill={c.black} />
        {/* Ears */}
        <rect x="16" y="7" width="1" height="2" fill={c.black} />
        <rect x="18" y="7" width="1" height="2" fill={c.black} />
        {/* Eye — closed contented */}
        <rect x="18" y="10" width="1" height="0.4" fill={c.greenEye} opacity="0.6" />
        {/* Nose */}
        <rect x="19" y="11" width="1" height="1" fill={c.pinkNose} />
        {/* Raised paw at face */}
        <rect x="19" y="9" width="1" height="2" fill={c.black} />
        <rect x="20" y="10" width="1" height="1" fill={c.black} />
        {/* Front leg standing */}
        <rect x="14" y="13" width="1" height="2" fill={c.black} />
        <rect x="16" y="13" width="1" height="2" fill={c.black} />
      </>
    )
  }
  if (state === 'stretch') {
    // Long elongated body — low + wide, head tucked, butt up
    return (
      <>
        {/* Tail relaxed back, low */}
        <rect x="1" y="11" width="2" height="1" fill={c.black} />
        <rect x="3" y="10" width="1" height="2" fill={c.black} />
        {/* Butt UP */}
        <rect x="4" y="8" width="4" height="4" fill={c.black} />
        <rect x="5" y="7" width="3" height="1" fill={c.black} />
        {/* Long stretched body — slope down */}
        <rect x="8" y="11" width="10" height="2" fill={c.black} />
        <rect x="8" y="10" width="9" height="1" fill={c.black} />
        {/* Head LOW + tucked, paws stretched forward */}
        <rect x="18" y="11" width="3" height="2" fill={c.black} />
        {/* Ears flat */}
        <rect x="18" y="10" width="1" height="1" fill={c.black} />
        <rect x="20" y="10" width="1" height="1" fill={c.black} />
        {/* Eye half-closed */}
        <rect x="20" y="11" width="1" height="0.5" fill={c.greenEye} opacity="0.6" />
        {/* Stretched front paws extending right */}
        <rect x="21" y="12" width="2" height="1" fill={c.black} />
        {/* Back legs — angled, butt-up posture */}
        <rect x="5" y="12" width="1" height="3" fill={c.black} />
        <rect x="7" y="12" width="1" height="3" fill={c.black} />
        {/* Front legs */}
        <rect x="17" y="13" width="1" height="2" fill={c.black} />
        <rect x="19" y="13" width="1" height="2" fill={c.black} />
      </>
    )
  }
  if (state === 'play') {
    // Front paws up, mid-pounce, butt low
    return (
      <>
        {/* Tail wagged up */}
        <rect x="2" y="8" width="1" height="4" fill={c.black} />
        <rect x="1" y="6" width="1" height="3" fill={c.black} />
        <rect x="2" y="5" width="1" height="2" fill={c.black} />
        {/* Hindquarters low */}
        <rect x="3" y="10" width="6" height="3" fill={c.black} />
        <rect x="4" y="9" width="5" height="1" fill={c.black} />
        {/* Body sloping UP toward head */}
        <rect x="9" y="9" width="8" height="3" fill={c.black} />
        <rect x="10" y="8" width="7" height="1" fill={c.black} />
        {/* Head HIGH + alert */}
        <rect x="17" y="6" width="3" height="3" fill={c.black} />
        {/* Ears perked */}
        <rect x="17" y="4" width="1" height="2" fill={c.black} />
        <rect x="19" y="4" width="1" height="2" fill={c.black} />
        {/* Wide eye */}
        <rect x="19" y="7" width="1" height="1" fill={c.greenEye} />
        {/* Nose */}
        <rect x="20" y="8" width="1" height="1" fill={c.pinkNose} />
        {/* Front paws RAISED off ground */}
        <rect x="15" y="12" width="1" height="2" fill={c.black} />
        <rect x="17" y="12" width="1" height="2" fill={c.black} />
        {/* Back paws planted */}
        <rect x="4" y="13" width="1" height="2" fill={c.black} />
        <rect x="7" y="13" width="1" height="2" fill={c.black} />
      </>
    )
  }
  // walk + walk2 + sit + sit2 (sit2 flicks the tail tip up 1px)
  // iter-356.4-cats — sit2 is a micro-frame cycled with sit at ~600ms so a
  // sitting cat's tail subtly twitches; walk2 alternates leg positions for
  // a 2-frame walk cycle (handled in legsForState above).
  const tailTipY = state === 'sit2' ? 5 : 6
  return (
    <>
      {/* Tail (sweeping up) — tip rises 1px in sit2 for the flick */}
      <rect x="2" y="9" width="1" height="3" fill={c.black} />
      <rect x="1" y="7" width="1" height="3" fill={c.black} />
      <rect x="2" y={tailTipY} width="1" height="2" fill={c.black} />
      {/* Body */}
      <rect x="7" y="9" width="11" height="4" fill={c.black} />
      <rect x="8" y="8" width="9" height="1" fill={c.black} />
      {/* Hind hip */}
      <rect x="3" y="10" width="5" height="3" fill={c.black} />
      {/* Neck + head */}
      <rect x="17" y="7" width="3" height="3" fill={c.black} />
      {/* Ears */}
      <rect x="17" y="5" width="1" height="2" fill={c.black} />
      <rect x="19" y="5" width="1" height="2" fill={c.black} />
      {/* Eye — green */}
      <rect x="19" y="8" width="1" height="1" fill={c.greenEye} />
      {/* Nose */}
      <rect x="20" y="9" width="1" height="1" fill={c.pinkNose} />
      {/* Whisker hint */}
      <line x1="20" y1="9.5" x2="22" y2="9" stroke={c.whisker} strokeWidth="0.3" />
      {legsForState(state, 13, c.black)}
    </>
  )
}

function TuxedoBody({ state }: { state: BodyState }) {
  const c = CAT_PALETTE
  if (state === 'sleep') {
    return (
      <>
        <rect x="6" y="11" width="14" height="3" fill={c.black} />
        <rect x="7" y="10" width="12" height="1" fill={c.black} />
        {/* White belly */}
        <rect x="9" y="12" width="9" height="2" fill={c.white} />
        {/* Head tucked left */}
        <rect x="4" y="9" width="4" height="3" fill={c.black} />
        <rect x="3" y="8" width="2" height="2" fill={c.black} />
        <rect x="5" y="11" width="2" height="1" fill={c.white} />
        {/* Closed eye */}
        <rect x="5" y="10" width="1" height="0.4" fill={c.yellowEye} opacity="0.5" />
        {/* TAIL with WHITE TIP — user-correction iter-356.4-cats round 2 */}
        <rect x="18" y="9" width="2" height="1" fill={c.black} />
        <rect x="20" y="9" width="1" height="2" fill={c.black} />
        <rect x="20" y="11" width="1" height="1" fill={c.white} />
      </>
    )
  }
  if (state === 'hiss') {
    return (
      <>
        {/* Puffed tail straight up — black with WHITE TIP at top */}
        <rect x="2" y="3" width="2" height="6" fill={c.black} />
        <rect x="1" y="4" width="1" height="2" fill={c.black} />
        <rect x="4" y="4" width="1" height="2" fill={c.black} />
        <rect x="2" y="2" width="2" height="1" fill={c.white} />
        {/* Arched body */}
        <rect x="6" y="9" width="12" height="2" fill={c.black} />
        <rect x="7" y="8" width="10" height="1" fill={c.black} />
        <rect x="9" y="7" width="6" height="1" fill={c.black} />
        {/* White belly preserved */}
        <rect x="7" y="11" width="11" height="1" fill={c.white} />
        {/* Raised fur spikes */}
        <rect x="9" y="6" width="1" height="1" fill={c.black} />
        <rect x="11" y="6" width="1" height="1" fill={c.black} />
        <rect x="13" y="6" width="1" height="1" fill={c.black} />
        {/* Hind hip — tuxedo line */}
        <rect x="4" y="10" width="3" height="2" fill={c.black} />
        <rect x="4" y="12" width="3" height="1" fill={c.white} />
        {/* Head low + forward */}
        <rect x="17" y="9" width="3" height="3" fill={c.black} />
        <rect x="17" y="8" width="1" height="1" fill={c.black} />
        <rect x="19" y="8" width="1" height="1" fill={c.black} />
        {/* WHITE muzzle */}
        <rect x="19" y="11" width="2" height="1" fill={c.white} />
        {/* Eye + open mouth (white teeth) */}
        <rect x="19" y="10" width="1" height="1" fill={c.yellowEye} />
        <rect x="20" y="11" width="1" height="1" fill={c.white} />
        {/* Stiff legs + WHITE SOCKS */}
        <rect x="6" y="13" width="1" height="2" fill={c.black} />
        <rect x="9" y="13" width="1" height="2" fill={c.black} />
        <rect x="15" y="13" width="1" height="2" fill={c.black} />
        <rect x="18" y="13" width="1" height="2" fill={c.black} />
        <rect x="6" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="9" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="15" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="18" y="14" width="1" height="0.6" fill={c.white} />
      </>
    )
  }
  if (state === 'groom') {
    return (
      <>
        {/* Tail curled at side — WHITE TIP */}
        <rect x="3" y="11" width="3" height="2" fill={c.black} />
        <rect x="2" y="10" width="1" height="2" fill={c.black} />
        <rect x="2" y="9" width="1" height="1" fill={c.white} />
        {/* Sitting body */}
        <rect x="7" y="10" width="10" height="2" fill={c.black} />
        <rect x="8" y="9" width="8" height="1" fill={c.black} />
        {/* White belly preserved */}
        <rect x="7" y="12" width="10" height="1" fill={c.white} />
        {/* Hind */}
        <rect x="6" y="11" width="2" height="1" fill={c.black} />
        <rect x="6" y="12" width="2" height="1" fill={c.white} />
        {/* Head tilted DOWN */}
        <rect x="16" y="9" width="3" height="3" fill={c.black} />
        {/* Ears */}
        <rect x="16" y="7" width="1" height="2" fill={c.black} />
        <rect x="18" y="7" width="1" height="2" fill={c.black} />
        {/* WHITE muzzle */}
        <rect x="18" y="11" width="2" height="1" fill={c.white} />
        {/* Closed eye */}
        <rect x="18" y="10" width="1" height="0.4" fill={c.yellowEye} opacity="0.6" />
        {/* Pink nose */}
        <rect x="19" y="11" width="1" height="1" fill={c.pinkNose} />
        {/* Raised paw at face */}
        <rect x="19" y="9" width="1" height="2" fill={c.black} />
        <rect x="20" y="10" width="1" height="1" fill={c.black} />
        {/* Front legs with WHITE SOCKS */}
        <rect x="14" y="13" width="1" height="2" fill={c.black} />
        <rect x="16" y="13" width="1" height="2" fill={c.black} />
        <rect x="14" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="16" y="14" width="1" height="0.6" fill={c.white} />
      </>
    )
  }
  if (state === 'stretch') {
    return (
      <>
        {/* Tail relaxed back — WHITE TIP at the end */}
        <rect x="1" y="11" width="2" height="1" fill={c.black} />
        <rect x="3" y="10" width="1" height="2" fill={c.black} />
        <rect x="0" y="11" width="1" height="1" fill={c.white} />
        {/* Butt UP */}
        <rect x="4" y="8" width="4" height="4" fill={c.black} />
        <rect x="5" y="7" width="3" height="1" fill={c.black} />
        {/* Long stretched body */}
        <rect x="8" y="11" width="10" height="1" fill={c.black} />
        <rect x="8" y="10" width="9" height="1" fill={c.black} />
        {/* White belly preserved (long thin band) */}
        <rect x="8" y="12" width="10" height="1" fill={c.white} />
        {/* Head LOW + tucked */}
        <rect x="18" y="11" width="3" height="2" fill={c.black} />
        <rect x="18" y="10" width="1" height="1" fill={c.black} />
        <rect x="20" y="10" width="1" height="1" fill={c.black} />
        {/* WHITE muzzle */}
        <rect x="20" y="12" width="2" height="1" fill={c.white} />
        {/* Eye half-closed */}
        <rect x="20" y="11" width="1" height="0.5" fill={c.yellowEye} opacity="0.6" />
        {/* Stretched front paws */}
        <rect x="21" y="12" width="2" height="1" fill={c.white} />
        {/* Back legs */}
        <rect x="5" y="12" width="1" height="3" fill={c.black} />
        <rect x="7" y="12" width="1" height="3" fill={c.black} />
        {/* Front legs */}
        <rect x="17" y="13" width="1" height="2" fill={c.black} />
        <rect x="19" y="13" width="1" height="2" fill={c.black} />
        {/* WHITE SOCKS on all four */}
        <rect x="5" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="7" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="17" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="19" y="14" width="1" height="0.6" fill={c.white} />
      </>
    )
  }
  if (state === 'play') {
    return (
      <>
        {/* Tail wagged up — WHITE TIP */}
        <rect x="2" y="8" width="1" height="4" fill={c.black} />
        <rect x="1" y="6" width="1" height="3" fill={c.black} />
        <rect x="2" y="5" width="1" height="2" fill={c.black} />
        <rect x="2" y="4" width="1" height="1" fill={c.white} />
        {/* Hindquarters low */}
        <rect x="3" y="10" width="6" height="2" fill={c.black} />
        <rect x="4" y="9" width="5" height="1" fill={c.black} />
        <rect x="3" y="12" width="6" height="1" fill={c.white} />
        {/* Body sloping UP toward head */}
        <rect x="9" y="9" width="8" height="2" fill={c.black} />
        <rect x="10" y="8" width="7" height="1" fill={c.black} />
        {/* White belly band */}
        <rect x="9" y="11" width="8" height="1" fill={c.white} />
        {/* Head HIGH + alert */}
        <rect x="17" y="6" width="3" height="3" fill={c.black} />
        <rect x="17" y="4" width="1" height="2" fill={c.black} />
        <rect x="19" y="4" width="1" height="2" fill={c.black} />
        {/* WHITE muzzle */}
        <rect x="19" y="8" width="2" height="1" fill={c.white} />
        {/* Eye */}
        <rect x="19" y="7" width="1" height="1" fill={c.yellowEye} />
        {/* Nose */}
        <rect x="20" y="8" width="1" height="1" fill={c.pinkNose} />
        {/* Front paws RAISED off ground */}
        <rect x="15" y="12" width="1" height="2" fill={c.black} />
        <rect x="17" y="12" width="1" height="2" fill={c.black} />
        {/* Back paws planted */}
        <rect x="4" y="13" width="1" height="2" fill={c.black} />
        <rect x="7" y="13" width="1" height="2" fill={c.black} />
        {/* WHITE SOCKS on all four */}
        <rect x="4" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="7" y="14" width="1" height="0.6" fill={c.white} />
        <rect x="15" y="13.4" width="1" height="0.6" fill={c.white} />
        <rect x="17" y="13.4" width="1" height="0.6" fill={c.white} />
      </>
    )
  }
  // walk + walk2 + sit + sit2 (sit2 flicks the tail tip up 1px)
  // iter-356.4-cats — sit2 raises BOTH the upper tail segment and the
  // signature white tip by 1px so the tuxedo's tail flick stays cohesive.
  // walk2 alternates legs (handled in legsForState) AND the socks
  // condition fires for both walk + walk2 so the signature white socks
  // travel with the alternating frames.
  const isSit2 = state === 'sit2'
  const tailUpperY = isSit2 ? 5 : 6
  const tailWhiteTipY = isSit2 ? 4 : 5
  const isWalkFrame = state === 'walk' || state === 'walk2'
  return (
    <>
      {/* TAIL: black with WHITE TIP (tuxedo signature) — tip + upper rise 1px in sit2 */}
      <rect x="2" y="9" width="1" height="3" fill={c.black} />
      <rect x="1" y="7" width="1" height="3" fill={c.black} />
      <rect x="2" y={tailUpperY} width="1" height="2" fill={c.black} />
      <rect x="2" y={tailWhiteTipY} width="1" height="1" fill={c.white} />
      {/* Body — black top, white belly */}
      <rect x="7" y="9" width="11" height="3" fill={c.black} />
      <rect x="8" y="8" width="9" height="1" fill={c.black} />
      <rect x="7" y="12" width="11" height="1" fill={c.white} />
      {/* Hind hip — half black half white "tuxedo line" */}
      <rect x="3" y="10" width="5" height="2" fill={c.black} />
      <rect x="3" y="12" width="5" height="1" fill={c.white} />
      {/* Front white "shirt" patch */}
      <rect x="15" y="10" width="3" height="2" fill={c.white} />
      {/* Neck + head */}
      <rect x="17" y="7" width="3" height="3" fill={c.black} />
      <rect x="17" y="5" width="1" height="2" fill={c.black} />
      <rect x="19" y="5" width="1" height="2" fill={c.black} />
      {/* WHITE muzzle */}
      <rect x="19" y="9" width="2" height="1" fill={c.white} />
      {/* Eye — yellow */}
      <rect x="19" y="8" width="1" height="1" fill={c.yellowEye} />
      {/* Pink nose */}
      <rect x="20" y="9" width="1" height="1" fill={c.pinkNose} />
      {/* White socks — fires for both walk frames so the signature carries through */}
      {isWalkFrame && state === 'walk' && (
        <>
          <rect x="9" y="14" width="1" height="0.6" fill={c.white} />
          <rect x="12" y="14" width="1" height="0.6" fill={c.white} />
          <rect x="16" y="14" width="1" height="0.6" fill={c.white} />
          <rect x="19" y="14" width="1" height="0.6" fill={c.white} />
        </>
      )}
      {/* walk2 socks track the alternating leg positions (10/11/17/18 not 9/12/16/19) */}
      {isWalkFrame && state === 'walk2' && (
        <>
          <rect x="10" y="13" width="1" height="0.6" fill={c.white} />
          <rect x="11" y="14" width="1" height="0.6" fill={c.white} />
          <rect x="17" y="13" width="1" height="0.6" fill={c.white} />
          <rect x="18" y="14" width="1" height="0.6" fill={c.white} />
        </>
      )}
      {legsForState(state, 13, c.black)}
    </>
  )
}

function CalicoBody({ state }: { state: BodyState }) {
  const c = CAT_PALETTE
  if (state === 'sleep') {
    return (
      <>
        {/* Curled white base */}
        <rect x="6" y="11" width="14" height="3" fill={c.white} />
        <rect x="7" y="10" width="12" height="1" fill={c.white} />
        {/* Orange + black calico patches */}
        <rect x="8" y="11" width="3" height="2" fill={c.orange} />
        <rect x="13" y="11" width="3" height="2" fill={c.black} />
        <rect x="16" y="10" width="3" height="2" fill={c.orange} />
        {/* Head tucked left */}
        <rect x="4" y="9" width="4" height="3" fill={c.white} />
        <rect x="3" y="8" width="2" height="2" fill={c.orange} />
        {/* Closed eye */}
        <rect x="5" y="10" width="1" height="0.4" fill={c.black} />
        {/* Tail — orange */}
        <rect x="18" y="9" width="2" height="1" fill={c.orange} />
        <rect x="20" y="9" width="1" height="2" fill={c.orange} />
      </>
    )
  }
  if (state === 'hiss') {
    return (
      <>
        {/* Puffed orange tail straight up */}
        <rect x="2" y="3" width="2" height="6" fill={c.orange} />
        <rect x="1" y="4" width="1" height="2" fill={c.orange} />
        <rect x="4" y="4" width="1" height="2" fill={c.orange} />
        <rect x="2" y="2" width="2" height="1" fill={c.orange} />
        {/* Arched body — white base */}
        <rect x="6" y="9" width="12" height="3" fill={c.white} />
        <rect x="7" y="8" width="10" height="1" fill={c.white} />
        <rect x="9" y="7" width="6" height="1" fill={c.white} />
        {/* Calico patches preserved */}
        <rect x="7" y="9" width="3" height="2" fill={c.orange} />
        <rect x="13" y="9" width="3" height="2" fill={c.black} />
        <rect x="11" y="10" width="2" height="2" fill={c.orange} />
        {/* Raised fur spikes — alternating colors */}
        <rect x="9" y="6" width="1" height="1" fill={c.orange} />
        <rect x="11" y="6" width="1" height="1" fill={c.black} />
        <rect x="13" y="6" width="1" height="1" fill={c.orange} />
        {/* Hind hip */}
        <rect x="4" y="10" width="3" height="3" fill={c.white} />
        <rect x="4" y="11" width="2" height="1" fill={c.orange} />
        {/* Head low + forward */}
        <rect x="17" y="9" width="3" height="3" fill={c.white} />
        <rect x="17" y="8" width="1" height="1" fill={c.black} />
        <rect x="19" y="8" width="1" height="1" fill={c.orange} />
        {/* Eye + open mouth (white) */}
        <rect x="19" y="10" width="1" height="1" fill={c.greenEye} />
        <rect x="20" y="11" width="1" height="1" fill={c.pinkNose} />
        {/* Stiff legs */}
        <rect x="6" y="13" width="1" height="2" fill={c.white} />
        <rect x="9" y="13" width="1" height="2" fill={c.white} />
        <rect x="15" y="13" width="1" height="2" fill={c.white} />
        <rect x="18" y="13" width="1" height="2" fill={c.white} />
      </>
    )
  }
  if (state === 'groom') {
    return (
      <>
        {/* Tail curled at side — orange */}
        <rect x="3" y="11" width="3" height="2" fill={c.orange} />
        <rect x="2" y="10" width="1" height="2" fill={c.orange} />
        {/* Sitting body — white base */}
        <rect x="7" y="10" width="10" height="3" fill={c.white} />
        <rect x="8" y="9" width="8" height="1" fill={c.white} />
        {/* Calico patches preserved */}
        <rect x="8" y="10" width="3" height="2" fill={c.orange} />
        <rect x="13" y="10" width="3" height="2" fill={c.black} />
        {/* Hind */}
        <rect x="6" y="11" width="2" height="2" fill={c.white} />
        <rect x="6" y="11" width="1" height="1" fill={c.orange} />
        {/* Head tilted DOWN */}
        <rect x="16" y="9" width="3" height="3" fill={c.white} />
        {/* Ears — one orange one black */}
        <rect x="16" y="7" width="1" height="2" fill={c.black} />
        <rect x="18" y="7" width="1" height="2" fill={c.orange} />
        {/* Closed eye */}
        <rect x="18" y="10" width="1" height="0.4" fill={c.black} />
        {/* Pink nose */}
        <rect x="19" y="11" width="1" height="1" fill={c.pinkNose} />
        {/* Raised paw at face */}
        <rect x="19" y="9" width="1" height="2" fill={c.white} />
        <rect x="20" y="10" width="1" height="1" fill={c.white} />
        {/* Front legs */}
        <rect x="14" y="13" width="1" height="2" fill={c.white} />
        <rect x="16" y="13" width="1" height="2" fill={c.white} />
      </>
    )
  }
  if (state === 'stretch') {
    return (
      <>
        {/* Tail relaxed back — orange */}
        <rect x="1" y="11" width="2" height="1" fill={c.orange} />
        <rect x="3" y="10" width="1" height="2" fill={c.orange} />
        {/* Butt UP — white base */}
        <rect x="4" y="8" width="4" height="4" fill={c.white} />
        <rect x="5" y="7" width="3" height="1" fill={c.white} />
        {/* Orange patch on the butt */}
        <rect x="4" y="9" width="3" height="2" fill={c.orange} />
        {/* Long stretched body */}
        <rect x="8" y="11" width="10" height="2" fill={c.white} />
        <rect x="8" y="10" width="9" height="1" fill={c.white} />
        {/* Black patch mid-back */}
        <rect x="11" y="10" width="3" height="2" fill={c.black} />
        {/* Head LOW + tucked */}
        <rect x="18" y="11" width="3" height="2" fill={c.white} />
        {/* Ears */}
        <rect x="18" y="10" width="1" height="1" fill={c.black} />
        <rect x="20" y="10" width="1" height="1" fill={c.orange} />
        {/* Eye half-closed */}
        <rect x="20" y="11" width="1" height="0.5" fill={c.greenEye} opacity="0.6" />
        {/* Stretched front paws */}
        <rect x="21" y="12" width="2" height="1" fill={c.white} />
        {/* Back legs */}
        <rect x="5" y="12" width="1" height="3" fill={c.white} />
        <rect x="7" y="12" width="1" height="3" fill={c.white} />
        {/* Front legs */}
        <rect x="17" y="13" width="1" height="2" fill={c.white} />
        <rect x="19" y="13" width="1" height="2" fill={c.white} />
      </>
    )
  }
  if (state === 'play') {
    return (
      <>
        {/* Tail wagged up — orange */}
        <rect x="2" y="8" width="1" height="4" fill={c.orange} />
        <rect x="1" y="6" width="1" height="3" fill={c.orange} />
        <rect x="2" y="5" width="1" height="2" fill={c.orange} />
        {/* Hindquarters low — white */}
        <rect x="3" y="10" width="6" height="3" fill={c.white} />
        <rect x="4" y="9" width="5" height="1" fill={c.white} />
        {/* Orange patch on hind */}
        <rect x="3" y="11" width="3" height="1" fill={c.orange} />
        {/* Body sloping UP toward head — white */}
        <rect x="9" y="9" width="8" height="3" fill={c.white} />
        <rect x="10" y="8" width="7" height="1" fill={c.white} />
        {/* Black patch on side */}
        <rect x="12" y="9" width="3" height="2" fill={c.black} />
        {/* Head HIGH + alert */}
        <rect x="17" y="6" width="3" height="3" fill={c.white} />
        {/* Ears — black + orange */}
        <rect x="17" y="4" width="1" height="2" fill={c.black} />
        <rect x="19" y="4" width="1" height="2" fill={c.orange} />
        {/* Wide eye */}
        <rect x="19" y="7" width="1" height="1" fill={c.greenEye} />
        {/* Nose */}
        <rect x="20" y="8" width="1" height="1" fill={c.pinkNose} />
        {/* Front paws RAISED off ground */}
        <rect x="15" y="12" width="1" height="2" fill={c.white} />
        <rect x="17" y="12" width="1" height="2" fill={c.white} />
        {/* Back paws planted */}
        <rect x="4" y="13" width="1" height="2" fill={c.white} />
        <rect x="7" y="13" width="1" height="2" fill={c.white} />
      </>
    )
  }
  // walk + walk2 + sit + sit2 (sit2 flicks the tail tip up 1px)
  // iter-356.4-cats — sit2 raises the orange tail tip 1px for the flick.
  // walk2 alternation lives in legsForState; the calico patches stay
  // identical across frames since they're body markings not pose.
  const tailTipY = state === 'sit2' ? 5 : 6
  return (
    <>
      {/* Tail — orange (tip rises 1px in sit2) */}
      <rect x="2" y="9" width="1" height="3" fill={c.orange} />
      <rect x="1" y="7" width="1" height="3" fill={c.orange} />
      <rect x="2" y={tailTipY} width="1" height="2" fill={c.orange} />
      {/* Body — white base */}
      <rect x="7" y="9" width="11" height="4" fill={c.white} />
      <rect x="8" y="8" width="9" height="1" fill={c.white} />
      {/* Calico patches scattered */}
      <rect x="8" y="9" width="3" height="2" fill={c.orange} />
      <rect x="13" y="9" width="3" height="2" fill={c.black} />
      <rect x="11" y="11" width="2" height="2" fill={c.orange} />
      {/* Hind */}
      <rect x="3" y="10" width="5" height="3" fill={c.white} />
      <rect x="3" y="11" width="3" height="1" fill={c.orange} />
      {/* Head + ears */}
      <rect x="17" y="7" width="3" height="3" fill={c.white} />
      <rect x="17" y="5" width="1" height="2" fill={c.black} />
      <rect x="19" y="5" width="1" height="2" fill={c.orange} />
      {/* Eye — green */}
      <rect x="19" y="8" width="1" height="1" fill={c.greenEye} />
      {/* Pink nose */}
      <rect x="20" y="9" width="1" height="1" fill={c.pinkNose} />
      {legsForState(state, 13, c.white)}
    </>
  )
}

// === SLEEPING CAT ILLUSTRATION (legacy empty-state) =======================

export function SleepingCatIllustration({
  size = 96,
  className,
  ariaLabel = 'A sleeping cat — nothing happening here yet',
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  // Re-uses the calico sleep-profile, scaled up.
  return (
    <svg
      width={size}
      height={Math.round(size / 1.5)}
      viewBox="0 0 24 16"
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label={ariaLabel}
    >
      <CalicoBody state="sleep" />
      {/* Z Z Z above */}
      <text x="14" y="6" fontSize="3" fill={CAT_PALETTE.whisker} opacity="0.7">
        z
      </text>
      <text x="17" y="4" fontSize="3" fill={CAT_PALETTE.whisker} opacity="0.5">
        z
      </text>
      <text x="20" y="2.5" fontSize="2.5" fill={CAT_PALETTE.whisker} opacity="0.4">
        z
      </text>
    </svg>
  )
}
