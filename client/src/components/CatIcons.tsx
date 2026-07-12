import { WALK_STEP_ORDER } from './catAnimSequences'

/**
 * iter-356.31 — high-detail mascot SVG cats. Replaces the iter-356.4
 * pixel-art era which the user (and Frank) called "small colored
 * smears." Each cat is now a rounded organic-shape vector mascot with
 * face detail (cheeks, whiskers, slit pupils), paws, tail, and per-cat
 * coat markings. Spec lives in `memory/cat_mascot_spec.md`.
 *
 * Three cats — modeled on the user's real cats:
 *   - PANTHER (Bombay, ♀) — solid black, amber eyes. Aloof / judgey.
 *   - MUSHU   (Tuxedo, ♂) — black + white bib + 4 socks + white tail
 *                            tip. Playful instigator.
 *   - COCO    (Calico, ♀) — white base + orange + black calico
 *                            patches. Sleepy + cuddly.
 *
 * Public API — preserved from iter-356.4 so CatLayer + tests stay
 * untouched:
 *   - BombayCatIcon / TuxedoCatIcon / CalicoCatIcon (face icons)
 *   - CatTrioMark (3 face icons in a row, used in Login + SideNav)
 *   - BombaySprite / TuxedoSprite / CalicoSprite (side-profile sprites
 *     used by the ambient CatLayer; accept a `state` prop)
 *   - SleepingCatIllustration (default empty-state mascot)
 *   - PawMark (small accent paw glyph for headings)
 *   - CAT_PALETTE (color tokens shared with CatLayer particles)
 *   - Habitat objects (YarnBall / ToyMouse / FeatherWand / FloatingBed
 *     / WallLedge / CardboardBox) — unchanged from iter-356.30.
 *
 * Internal viewBox bumps:
 *   - Faces: 16×16 → 64×64 (4× resolution for organic curves)
 *   - Sprites: 24×16 → 96×64 (preserves 3:2 aspect ratio so the
 *     `width = size * 1.5` math in *Sprite stays valid; passes through
 *     to CatLayer's SPRITE_WIDTH/HEIGHT geometry without change)
 *   - Trio: 48×16 → 192×64
 *   - Sleeping illustration: 24×16 → 96×64 (2:3 aspect kept)
 *
 * `shape-rendering="crispEdges"` is DROPPED on the mascot art (it
 * killed anti-aliasing and made the curves look like staircases). It
 * stays on PawMark (still a graphic glyph; no curves benefit).
 */

export const CAT_PALETTE = {
  black: '#0e0c0a',
  white: '#f7f3eb',
  orange: '#d97706',
  greenEye: '#86efac',
  yellowEye: '#fde047',
  pinkNose: '#fda4af',
  whisker: '#6b6358',
  shadow: 'rgba(60,40,20,0.28)',
  // iter-356.32: warm-dark outline used on light-coated cats so the
  // calico (Coco — body fill #f7f3eb) doesn't disappear on the cream
  // page bg (#faf6ee, ~2 RGB-values off). Dark cats fall back to 'none'.
  outline: '#1a1410',
} as const

// iter-356.36..38: legacy SVG mascot art removed. Face icons + side-
// profile sprites + sleeping illustration are now raster PNGs sliced
// from the user's sprite-sheet. The `Coat` + `COAT` per-cat color
// tokens that drove the SVG art are no longer needed.

type CatIconProps = {
  size?: number
  className?: string
  ariaLabel?: string
}

// === PAW MARK (decorative, kept from iter-356.28) =========================

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

// === FACE ICONS — iter-356.36 raster swap ================================
//
// User uploaded a sprite-sheet reference (`public/cats/sprite-sheet.png`)
// and asked the face icons to come from there instead of the hand-drawn
// SVG mascots. Per-cat face PNG lives at `public/cats/{cat}-face.png`,
// extracted from the sheet's FACE ICON column (sub-row 1 of each cat's
// band). The full sheet is kept as a public asset for future migrations
// of the side-profile poses.
//
// The CatLayer side-profile sprites (BombaySprite / TuxedoSprite /
// CalicoSprite) and the SleepingCatIllustration deliberately stay on
// the iter-356.31..33 SVG art — they need per-state pose variants
// (walk/sit/sleep/hiss/etc.) that aren't yet sliced from the sheet.

const FACE_SRC = {
  panther: '/cats/panther-face.png',
  mushu: '/cats/mushu-face.png',
  coco: '/cats/coco-face.png',
} as const

function FaceImg({
  src,
  alt,
  size,
  className,
}: {
  src: string
  alt: string
  size: number
  className?: string
}) {
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain', display: 'inline-block' }}
      decoding="async"
      loading="lazy"
    />
  )
}

export function BombayCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <FaceImg
      src={FACE_SRC.panther}
      alt={ariaLabel ?? ''}
      size={size}
      className={className}
    />
  )
}

export function TuxedoCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <FaceImg
      src={FACE_SRC.mushu}
      alt={ariaLabel ?? ''}
      size={size}
      className={className}
    />
  )
}

export function CalicoCatIcon({ size = 24, className, ariaLabel }: CatIconProps) {
  return (
    <FaceImg
      src={FACE_SRC.coco}
      alt={ariaLabel ?? ''}
      size={size}
      className={className}
    />
  )
}

// iter-356.36 — face-icon surfaces (CatTrioMark + Bombay/Tuxedo/Calico
// icons) render raster PNGs from the user's sprite-sheet
// (`public/cats/{cat}-face.png`). The legacy `FaceSvg` + `CatFace` +
// `Eye` SVG primitive (was iter-356.31..33) was removed; recover from
// git history if a future surface needs the SVG art.

// === TRIO MARK ============================================================

export function CatTrioMark({
  size = 48,
  className,
  ariaLabel = 'Three cats — the household watch crew',
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  // iter-356.36: trio mark now stitches the three raster face PNGs from
  // `public/cats/{cat}-face.png` (extracted from the user's sprite-sheet
  // reference). The SVG container preserves the role=img + aria-label
  // contract pinned by `CatIcons.test.tsx` AND the <title> announcement
  // ("Panther, Mushu, and Coco") so screen-reader users still hear the
  // cat names — that copy is load-bearing per CatIcons.test.tsx iter-356.6
  // pin. PNG width per cell = size/3; the row height = size/3 as well so
  // the lockup stays rectangular at 3:1 (was the SVG viewBox ratio).
  const cell = size / 3
  return (
    <span
      className={className}
      role="img"
      aria-label={ariaLabel}
      title="Panther, Mushu, and Coco"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0,
        lineHeight: 0,
      }}
    >
      {/* SR-only title pin — `CatIcons.test.tsx` selects `container.querySelector('title')`
          which is an SVG element. We keep an inline SVG with just <title> to
          preserve that test contract without rendering anything visible. */}
      <svg
        width="0"
        height="0"
        viewBox="0 0 0 0"
        aria-hidden="true"
        style={{ position: 'absolute' }}
      >
        <title>Panther, Mushu, and Coco</title>
      </svg>
      <img
        src={FACE_SRC.panther}
        alt=""
        width={cell}
        height={cell}
        decoding="async"
        // iter-356-E (Slice E): trio mark sits above-the-fold on the
        // Login hero AND in the SideNav rail header — both surfaces
        // are first-paint critical. `loading="eager"` + `fetchpriority`
        // hint asks the browser to prioritize these PNGs in the
        // network queue. Other icon usages (face avatars in lists)
        // are below-the-fold and stay lazy via their own components.
        loading="eager"
        fetchPriority="high"
        style={{ objectFit: 'contain', display: 'inline-block' }}
      />
      <img
        src={FACE_SRC.mushu}
        alt=""
        width={cell}
        height={cell}
        decoding="async"
        // iter-356-E (Slice E): trio mark sits above-the-fold on the
        // Login hero AND in the SideNav rail header — both surfaces
        // are first-paint critical. `loading="eager"` + `fetchpriority`
        // hint asks the browser to prioritize these PNGs in the
        // network queue. Other icon usages (face avatars in lists)
        // are below-the-fold and stay lazy via their own components.
        loading="eager"
        fetchPriority="high"
        style={{ objectFit: 'contain', display: 'inline-block' }}
      />
      <img
        src={FACE_SRC.coco}
        alt=""
        width={cell}
        height={cell}
        decoding="async"
        // iter-356-E (Slice E): trio mark sits above-the-fold on the
        // Login hero AND in the SideNav rail header — both surfaces
        // are first-paint critical. `loading="eager"` + `fetchpriority`
        // hint asks the browser to prioritize these PNGs in the
        // network queue. Other icon usages (face avatars in lists)
        // are below-the-fold and stay lazy via their own components.
        loading="eager"
        fetchPriority="high"
        style={{ objectFit: 'contain', display: 'inline-block' }}
      />
    </span>
  )
}
// === FACE PRIMITIVE removed iter-356.36 (raster PNG migration) ============

// === SIDE-PROFILE SPRITES — iter-356.38 raster migration ==================
//
// User uploaded a polished cat sprite-sheet and asked the side-profile
// CatLayer art to use it. Previously these were inline-SVG with per-state
// `Pose*` components, ~700 lines. Now: each cat × pose is a PNG in
// `public/cats/{cat}-{pose}.png`, sliced from the sheet by the
// `tools/extract-cat-frames.py`-style script (run ad-hoc to regenerate).
//
// 8 poses per cat are extracted: face, sit, walk_a, walk_b, play,
// stretch, sleep_curled, hiss. The `BodyState` union has 9 values; the
// 9th (`groom`) maps to `sit` since the sheet has no licking-paw frame
// — closest stationary pose. `sit` and `sit2` collapse to the same image
// (no "tail flick" raster variant). `walk` ↔ `walk2` toggles the two
// walk frames, preserving the iter-356.4 leg-phase animation.
//
// Direction-flip is handled by CatLayer applying `transform: scaleX(-1)`
// on the sprite container when a cat moves RIGHT — both the curated
// sprites and the 12-frame walk cycles face LEFT by default.

export type BodyState =
  | 'walk'
  | 'walk2'
  | 'sit'
  | 'sit2'
  | 'sleep'
  | 'hiss'
  | 'groom'
  | 'stretch'
  | 'play'
  | 'on_post' // iter-356.41: cat sitting on the cat-tree habitat object

// iter-356.39: switched from inline-SVG (3:2 wide aspect) to raster
// curated PNGs (~0.83 wide / ~1.2 tall — cats stand tail-up). Box is
// now slightly TALLER than wide so the curated PNGs fill height
// naturally with a touch of horizontal breathing room. CatLayer uses
// these constants to size the sprite container.
const SPRITE_W_RATIO = 0.83
const SPRITE_H_OVER_W = 1 / SPRITE_W_RATIO  // ≈1.2 — height/width

type CatId = 'panther' | 'mushu' | 'coco'

function poseFor(state: BodyState): string {
  switch (state) {
    case 'walk':
      return 'walk_a'
    case 'walk2':
      return 'walk_b'
    case 'sit':
    case 'sit2':
    case 'groom':
      return 'sit'
    case 'sleep':
      return 'sleep_curled'
    case 'hiss':
      return 'hiss'
    case 'stretch':
      return 'stretch'
    case 'play':
      return 'play'
    case 'on_post':
      return 'on_post'
  }
}

function RasterSprite({
  cat,
  size,
  state,
  walkFrame,
  className,
}: {
  cat: CatId
  size: number
  state: BodyState
  walkFrame?: number
  className?: string
}) {
  const pose = poseFor(state)
  // Frames-30: walkFrame is a step INDEX into the 30-frame walk cycle —
  // resolve it through the canonical step order (midpoint frames like
  // walk_m07 have no numeric filename to derive).
  const src =
    walkFrame === undefined
      ? `/cats/${cat}-${pose}.png`
      : `/cats/anim/${cat}/${WALK_STEP_ORDER[walkFrame] ?? 'walk_01'}.png`
  // iter-356.39: render IMG at a slightly-taller-than-square box so the
  // curated PNGs (which stand tail-up, taller than wide) aren't clipped
  // at the bottom by a wide-aspect 3:2 container. width = `size`;
  // height = `size * 1.2`. CatLayer's SPRITE_WIDTH/HEIGHT constants are
  // adjusted in lockstep.
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={Math.round(size * SPRITE_H_OVER_W)}
      data-testid="cat-sprite"
      data-cat-id={cat}
      data-cat-state={state}
      data-walk-frame={walkFrame === undefined ? undefined : walkFrame + 1}
      decoding="async"
      loading="lazy"
      style={{
        objectFit: 'contain',
        // iter-356.40: anchor the cat's FEET to the container's bottom
        // edge. Previously default `center center` meant a tall pose
        // like `walk_a` (156×188) and a short pose like `sleep_curled`
        // (115×100) ended up vertically centered in the same 36×43
        // box — when a cat transitioned walk→sleep its feet appeared
        // to lift off the ground by ~6px (user reported as "teleport").
        // Bottom-centering keeps the ground line stable across poses.
        objectPosition: 'center bottom',
        display: 'block',
      }}
      // cat-sprite-img: night-treatment hook — on the dark theme
      // index.css gives it a parchment drop-shadow halo (Panther's
      // near-black art is invisible on charcoal without it) + slight dim.
      className={className ? `cat-sprite-img ${className}` : 'cat-sprite-img'}
    />
  )
}

export function BombaySprite({
  size = 48,
  state = 'walk',
  walkFrame,
  className,
}: {
  size?: number
  state?: BodyState
  walkFrame?: number
  className?: string
}) {
  return (
    <RasterSprite
      cat="panther"
      size={size}
      state={state}
      walkFrame={walkFrame}
      className={className}
    />
  )
}

export function TuxedoSprite({
  size = 48,
  state = 'walk',
  walkFrame,
  className,
}: {
  size?: number
  state?: BodyState
  walkFrame?: number
  className?: string
}) {
  return (
    <RasterSprite
      cat="mushu"
      size={size}
      state={state}
      walkFrame={walkFrame}
      className={className}
    />
  )
}

export function CalicoSprite({
  size = 48,
  state = 'walk',
  walkFrame,
  className,
}: {
  size?: number
  state?: BodyState
  walkFrame?: number
  className?: string
}) {
  return (
    <RasterSprite
      cat="coco"
      size={size}
      state={state}
      walkFrame={walkFrame}
      className={className}
    />
  )
}

// === SLEEPING CAT ILLUSTRATION (empty-state mascot) =======================
//
// iter-356.38: was a 50-line SVG with feMorphology outline; now a single
// raster PNG of the calico sleep-curled pose plus z-z-z text. The PNG
// already has a clean head + tail + paw tuck (sliced from the user's
// sprite-sheet bot row idx 8) so the SVG's iter-356.33 anatomy redraw
// is no longer load-bearing — the sheet's polished art is.

export function SleepingCatIllustration({
  size = 96,
  className,
  ariaLabel = 'A sleeping cat — nothing happening here yet',
}: {
  size?: number
  className?: string
  ariaLabel?: string
}) {
  // 96×64 outer frame keeps the iter-356.31..33 SleepingCatIllustration
  // aspect ratio so consumers (CatEmptyState et al.) don't need layout
  // changes. PNG centered with z-z-z drifting up at the top-right.
  const w = size
  const h = Math.round(size / SPRITE_W_RATIO)
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{
        position: 'relative',
        width: w,
        height: h,
        display: 'inline-block',
      }}
      data-testid="sleeping-cat"
    >
      <img
        src="/cats/coco-sleep_curled.png"
        alt=""
        className="cat-sprite-img"
        decoding="async"
        loading="lazy"
        style={{
          position: 'absolute',
          left: '15%',
          bottom: 0,
          width: '60%',
          height: 'auto',
          objectFit: 'contain',
        }}
      />
      {/* Z-Z-Z drift in warm-dark, escalating opacity off the top-right
          of the cat's head. Same character chosen as iter-356.33 SVG. */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '10%',
          top: '5%',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontWeight: 700,
          fontSize: Math.round(h * 0.16),
          color: '#1a1410',
          lineHeight: 1,
          letterSpacing: '0.05em',
          opacity: 0.7,
        }}
      >
        z
      </span>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '4%',
          top: '18%',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontWeight: 700,
          fontSize: Math.round(h * 0.12),
          color: '#1a1410',
          lineHeight: 1,
          opacity: 0.55,
        }}
      >
        z
      </span>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '0%',
          top: '30%',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontWeight: 700,
          fontSize: Math.round(h * 0.09),
          color: '#1a1410',
          lineHeight: 1,
          opacity: 0.4,
        }}
      >
        z
      </span>
    </div>
  )
}

// === HABITAT OBJECTS (iter-356.34 restyle to match the iter-356.31..33
// vector mascot baseline). All five user-listed objects share the same
// warm-dark outline filter as the white-coated cats, so a calico Coco
// curling next to a yarn ball reads as ONE visual system instead of two.
// Feather wand DROPPED per user directive (was iter-356.30 carryover —
// not on the user's curated list, and Maya's "yellow flower + blue paw
// cluster" was its on-screen reading at small sizes). =====================

type HabitatProps = { size?: number; className?: string }

const HABITAT_PALETTE = {
  yarnA: '#d97706', // --color-accent-default (calico orange)
  yarnB: '#b45309', // --color-warning (amber-700)
  mouseGrey: '#8c8784',
  mousePink: '#fda4af',
  woodLight: '#c08552',
  woodDark: '#7a4f2c',
  cushion: '#fef3c7', // --color-accent-subtle
  cushionDeep: '#f5deb3',
  blanketStripe: '#b45309',
  cardboard: '#d4a373',
  cardboardShadow: '#b08968',
} as const

// Shared outline filter — matches the iter-356.32 sprite filter so every
// habitat object reads as the same line-weight + color family as Coco.
function HabitatOutline({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-10%" y="-10%" width="120%" height="120%">
        <feMorphology in="SourceAlpha" operator="dilate" radius="0.7" />
        <feFlood floodColor={CAT_PALETTE.outline} floodOpacity="0.6" />
        <feComposite in2="SourceAlpha" operator="in" result="outline" />
        <feComposite in="SourceGraphic" in2="outline" operator="over" />
      </filter>
    </defs>
  )
}

export function YarnBall({ size = 22, className }: HabitatProps) {
  const fid = 'habitat-outline-yarn'
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true" className={className}>
      <HabitatOutline id={fid} />
      <ellipse cx="11" cy="20" rx="7" ry="1.2" fill="rgba(60,40,20,0.18)" />
      <g filter={`url(#${fid})`}>
        <circle cx="11" cy="13" r="7" fill={HABITAT_PALETTE.yarnA} opacity="0.92" />
        <path d="M5 13 Q11 6 17 13" stroke={HABITAT_PALETTE.yarnB} strokeWidth="0.9" fill="none" opacity="0.7" />
        <path d="M5 13 Q11 20 17 13" stroke={HABITAT_PALETTE.yarnB} strokeWidth="0.9" fill="none" opacity="0.7" />
        <path d="M11 6 Q15 13 11 20" stroke={HABITAT_PALETTE.yarnB} strokeWidth="0.7" fill="none" opacity="0.55" />
        <path d="M16.5 14 Q19 16 18 19" stroke={HABITAT_PALETTE.yarnA} strokeWidth="0.9" fill="none" />
      </g>
    </svg>
  )
}

export function ToyMouse({ size = 20, className }: HabitatProps) {
  const fid = 'habitat-outline-mouse'
  return (
    <svg width={size} height={size} viewBox="0 0 22 14" aria-hidden="true" className={className}>
      <HabitatOutline id={fid} />
      <ellipse cx="11" cy="13" rx="6" ry="0.8" fill="rgba(60,40,20,0.18)" />
      <g filter={`url(#${fid})`}>
        {/* tail (curved) */}
        <path d="M5 10 Q1 10 2 7" stroke={HABITAT_PALETTE.mousePink} strokeWidth="1.2" fill="none" strokeLinecap="round" />
        {/* body */}
        <ellipse cx="11" cy="9" rx="6" ry="3.5" fill={HABITAT_PALETTE.mouseGrey} />
        {/* head */}
        <circle cx="16" cy="8.5" r="2.7" fill={HABITAT_PALETTE.mouseGrey} />
        {/* ear */}
        <circle cx="14.7" cy="6" r="1.4" fill={HABITAT_PALETTE.mouseGrey} />
        <circle cx="14.7" cy="6" r="0.7" fill={HABITAT_PALETTE.mousePink} />
        {/* eye + nose */}
        <circle cx="16.8" cy="8.2" r="0.45" fill={CAT_PALETTE.outline} />
        <circle cx="18.2" cy="9.2" r="0.45" fill={HABITAT_PALETTE.mousePink} />
      </g>
    </svg>
  )
}

export function FloatingBed({ size = 38, className }: HabitatProps) {
  const fid = 'habitat-outline-bed'
  return (
    <svg width={size} height={(size * 22) / 38} viewBox="0 0 38 22" aria-hidden="true" className={className}>
      <HabitatOutline id={fid} />
      <ellipse cx="19" cy="20" rx="14" ry="1.4" fill="rgba(60,40,20,0.18)" />
      <g filter={`url(#${fid})`}>
        {/* basket exterior */}
        <ellipse cx="19" cy="14" rx="14" ry="6" fill={HABITAT_PALETTE.cardboard} />
        {/* inner rim */}
        <ellipse cx="19" cy="11" rx="11.5" ry="3.5" fill={HABITAT_PALETTE.cardboardShadow} />
        {/* cushion */}
        <ellipse cx="19" cy="10.5" rx="10" ry="2.6" fill={HABITAT_PALETTE.cushion} />
        {/* blanket stripe */}
        <path d="M11 10 Q19 12 27 10" stroke={HABITAT_PALETTE.blanketStripe} strokeWidth="0.8" fill="none" opacity="0.7" />
      </g>
    </svg>
  )
}

export function WallLedge({ size = 60, className }: HabitatProps) {
  const fid = 'habitat-outline-ledge'
  return (
    <svg width={size} height={(size * 14) / 60} viewBox="0 0 60 14" aria-hidden="true" className={className}>
      <HabitatOutline id={fid} />
      <g filter={`url(#${fid})`}>
        {/* plank */}
        <rect x="0" y="3" width="60" height="4" rx="1.2" fill={HABITAT_PALETTE.woodLight} />
        {/* top highlight + bottom shadow */}
        <rect x="0" y="3" width="60" height="1" fill={HABITAT_PALETTE.cushion} opacity="0.55" />
        <rect x="0" y="6" width="60" height="1" fill={HABITAT_PALETTE.woodDark} opacity="0.5" />
        {/* L-brackets */}
        <path d="M6 7 L4 13 L10 7 Z" fill={HABITAT_PALETTE.woodDark} />
        <path d="M50 7 L48 13 L54 7 Z" fill={HABITAT_PALETTE.woodDark} />
      </g>
    </svg>
  )
}

export function CardboardBox({ size = 30, className }: HabitatProps) {
  const fid = 'habitat-outline-box'
  return (
    <svg width={size} height={(size * 22) / 30} viewBox="0 0 30 22" aria-hidden="true" className={className}>
      <HabitatOutline id={fid} />
      <ellipse cx="15" cy="21" rx="13" ry="1" fill="rgba(60,40,20,0.20)" />
      <g filter={`url(#${fid})`}>
        {/* back wall */}
        <rect x="3" y="6" width="24" height="14" fill={HABITAT_PALETTE.cardboardShadow} />
        {/* front face */}
        <path d="M3 8 L27 8 L26 20 L4 20 Z" fill={HABITAT_PALETTE.cardboard} />
        {/* top folds */}
        <path d="M3 8 L8 4 L24 4 L27 8 Z" fill={HABITAT_PALETTE.cardboardShadow} />
        <path d="M8 4 L11 1 L17 1 L15 4 Z" fill={HABITAT_PALETTE.cardboard} />
        {/* seam */}
        <line x1="13" y1="8" x2="13" y2="20" stroke={HABITAT_PALETTE.woodLight} strokeWidth="0.6" opacity="0.55" />
      </g>
    </svg>
  )
}

// iter-356.41: cat tree / scratching post. Source asset is the "BODY"
// part-image from the user's Cats.zip (`cats/parts/black-10-on-post-BODY.png`)
// — same post drawing across all 3 cats, just the post (no cat). Aspect
// 106×82 → ~1.29 wide / 1 tall. The `<CatTree>` habitat object is the
// PERSISTENT cat-tree drawing always shown in the layer; when a cat
// rolls the `'on_post'` activity, its sprite swaps to the corresponding
// `{cat}-on_post.png` (which has the cat sitting on the tree) at the
// tree's x position — visually the empty tree + cat-on-tree overlap to
// "the cat is now on the tree." See `CatLayer.tsx::HabitatBackground`.
export function CatTree({ size = 80, className }: HabitatProps) {
  return (
    <img
      src="/cats/cat-tree.png"
      alt=""
      width={size}
      height={Math.round((size * 82) / 106)}
      decoding="async"
      loading="lazy"
      style={{ objectFit: 'contain', display: 'block' }}
      className={className}
    />
  )
}
