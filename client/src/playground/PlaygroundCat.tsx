import { memo, useState } from 'react'
import { CatParticles } from '../components/CatParticles'
import { catAnimFrameUrl } from '../components/catAnimSequences'
import { moodBadgeParts } from '../components/catMoodBadges'
import {
  playFrameUrl,
  playgroundAnimationPlanFor,
  type PlayCat,
} from './playgroundState'
import { CAT_HEIGHT_PX, CAT_WIDTH_PX } from './sceneModel'
import { BACK_LANE_SCALE } from './playgroundTypes'
import type { PlaygroundCatId } from './playgroundAssets'

// Playground Slice B — the per-cat renderer. The nested wrapper DOM
// copies CatLayer's structure VERBATIM in spirit; the separation is
// LOAD-BEARING (the Panther-mirror bug, 2026-07-11):
//   positioned container (inline translate — NEVER CSS-transitioned)
//     → entrance wrapper (filled CSS animations live here and ONLY
//       here; a filled animation overrides inline transform forever)
//       → direction-flip div (scaleX with its own 220ms transition —
//         safe because this div carries no translate)
//         → bob div (per-activity walk-bob / breathe keyframes)
//           → sprite img

export type PlaygroundCatProps = {
  cat: PlayCat
  /** Press-and-hold petting reporters — PlaygroundScene wires these to
      input.petTarget. */
  onPetStart: (catId: PlaygroundCatId) => void
  onPetEnd: (catId: PlaygroundCatId) => void
}

export const PlaygroundCat = memo(PlaygroundCatImpl)

// RESIDUAL A (2026-07-11 live burst audit: wide poses shrank the cat).
// Sprites render at a FIXED BODY-SCALE height with width:auto instead
// of contain-fitting into the 44×53 box — a wide canvas (eat_a is
// 165×128) no longer scales the whole cat down to fit its width. The
// 160-tall canvases (scratch/climb standing poses) keep the same
// px-per-canvas ratio, so their extra height is real pose height.
const SPRITE_CANVAS_BASE_PX = 128
const SPRITE_CANVAS_TALL_PX = 160
const TALL_CANVAS_FRAMES: ReadonlySet<string> = new Set([
  'scratch_a',
  'scratch_b',
  'climb_a',
  'climb_b',
])

/** Rendered sprite height for a frame: CAT_HEIGHT_PX for the standard
    128-tall canvas, proportionally more for the 160-tall poses. */
export function spriteRenderHeightPx(frame: string): number {
  const canvas = TALL_CANVAS_FRAMES.has(frame) ? SPRITE_CANVAS_TALL_PX : SPRITE_CANVAS_BASE_PX
  return Math.round((CAT_HEIGHT_PX * canvas) / SPRITE_CANVAS_BASE_PX)
}

function PlaygroundCatImpl({ cat, onPetStart, onPetEnd }: PlaygroundCatProps) {
  const plan = playgroundAnimationPlanFor(cat, cat.phaseTime)
  // Playground art may still be generating: a 404ing rich frame falls
  // back to the shared seated pose before hiding entirely.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const hidden = cat.activity === 'tunnel'
  const frame = plan.frame ?? 'seated'
  let src = playFrameUrl(cat.id, frame)
  let renderedFrame: string = frame
  if (failedSrc === src) {
    src = catAnimFrameUrl(cat.id, 'seated')
    renderedFrame = 'seated'
  }
  const spriteHeight = spriteRenderHeightPx(renderedFrame)
  const backLane = cat.lane === 'back'
  // Depth scale follows laneBlend (stepped toward the logical lane in
  // stepPlayground) so a lane switch cross-fades instead of popping.
  const depthScale = 1 - (1 - BACK_LANE_SCALE) * cat.laneBlend
  const bob = spriteAnim(cat.activity)
  return (
    <div
      data-testid={`playground-cat-${cat.id}`}
      data-activity={cat.activity}
      data-lane={cat.lane}
      style={{
        position: 'absolute',
        left: 0,
        bottom: cat.y,
        width: CAT_WIDTH_PX,
        height: CAT_HEIGHT_PX,
        // Horizontal motion on the compositor; back-lane cats shrink
        // to the shared depth scale and paint behind front cats.
        transform: `translateX(${cat.x}px)${depthScale !== 1 ? ` scale(${depthScale.toFixed(4)})` : ''}`,
        transformOrigin: 'bottom center',
        willChange: 'transform',
        zIndex: backLane ? 1 : 2,
        visibility: hidden ? 'hidden' : undefined,
      }}
    >
      {/* Ground shadow (CatLayer's cat-ground-shadow, live burst audit
          2026-07-11: shadowless back-lane cats read as walking on air).
          Sits INSIDE the positioned container but OUTSIDE the entrance
          wrapper, so it never inherits flip/bob transforms. Hidden
          while the cat hides in the tunnel. */}
      {!hidden && (
        <div
          data-testid="playcat-ground-shadow"
          style={{
            position: 'absolute',
            left: '12%',
            bottom: 1,
            width: '76%',
            height: 7,
            borderRadius: '50%',
            background: 'rgba(43,34,19,0.16)',
            filter: 'blur(1.5px)',
          }}
        />
      )}
      {/* Entrance choreography rides the SAME wrapper CatLayer uses:
          the filled arrive animation lives on its own element so it can
          never override the container's per-frame inline translate. */}
      <div
        data-testid="playground-cat-entrance-wrapper"
        className={`cat-entrance-${cat.id}`}
        style={{ width: '100%', height: '100%' }}
      >
        <div
          data-testid="playground-cat-direction-flip"
          style={{
            width: '100%',
            height: '100%',
            // Shared PNGs face LEFT by default; flip for 'R'. Safe to
            // transition here — this div carries no translate.
            transform: cat.direction === 'R' ? 'scaleX(-1)' : undefined,
            transformOrigin: 'center',
            transition: 'transform 220ms ease-in-out',
          }}
        >
          <div
            style={{
              width: '100%',
              height: '100%',
              transformOrigin: 'center',
              animation: bob,
            }}
          >
            <img
              src={src}
              alt=""
              data-testid="playground-cat-sprite"
              data-cat-id={cat.id}
              data-anim-frame={frame}
              decoding="async"
              loading="lazy"
              // Fixed body-scale render (RESIDUAL A): height pins the
              // cat's size, width follows each frame's natural aspect,
              // and the img hangs bottom-CENTERED on the cat's x — it
              // may overflow the 44px layout box horizontally, which is
              // fine (the container keeps the layout; the flip div
              // mirrors around this same center).
              style={{
                position: 'absolute',
                left: '50%',
                bottom: 0,
                transform: 'translateX(-50%)',
                height: spriteHeight,
                width: 'auto',
                maxWidth: 'none',
                display: 'block',
              }}
              onError={(event) => {
                const failing = event.currentTarget.getAttribute('src')
                if (failing && failing !== catAnimFrameUrl(cat.id, 'seated')) {
                  setFailedSrc(failing)
                } else {
                  event.currentTarget.style.display = 'none'
                }
              }}
            />
          </div>
        </div>
      </div>
      {cat.mood && !hidden && (
        <PlayCatMoodBubble
          key={`${cat.id}-${cat.moodUntil}`}
          catId={cat.id}
          mood={cat.mood}
          moodSecondary={cat.moodSecondary}
        />
      )}
      {cat.activity === 'purr' && !hidden && (
        <CatParticles
          key={`${cat.id}-purr-${cat.activityStartedAt}`}
          type="hearts"
          x={CAT_WIDTH_PX / 2}
          y={Math.round(CAT_HEIGHT_PX * 0.55)}
          count={6}
        />
      )}
      {/* Invisible petting hit-area: the only interactive surface per
          cat. pointer-events re-enabled just here so strokes land on
          the cat, not the scene (which owns verb gestures). Slightly
          OVERSIZED beyond the 44×53 layout box so it still covers the
          sprite when a wide pose overflows horizontally (drink_a is
          ~72px rendered) or a tall pose rises above the box. */}
      <div
        data-testid={`playground-cat-hit-${cat.id}`}
        style={{ position: 'absolute', left: -16, right: -16, top: -14, bottom: 0, pointerEvents: 'auto' }}
        onPointerDown={(event) => {
          event.stopPropagation()
          onPetStart(cat.id)
        }}
        onPointerUp={() => onPetEnd(cat.id)}
        onPointerLeave={() => onPetEnd(cat.id)}
        onPointerCancel={() => onPetEnd(cat.id)}
      />
    </div>
  )
}

// Mood bubble — minimal replication of CatLayer's CatMoodBubble (not
// exported there); same badge lookup + fallback chain + rise anim.
function PlayCatMoodBubble({
  catId,
  mood,
  moodSecondary,
}: {
  catId: PlaygroundCatId
  mood: string
  moodSecondary: string | null
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const parts = moodBadgeParts(catId, mood)
  const useBadge = parts.src !== null && !imgFailed
  return (
    <span
      data-testid="playground-cat-mood"
      style={{
        position: 'absolute',
        left: '50%',
        top: -10,
        fontSize: 18,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        animation: 'cat-mood-rise 2200ms ease-out forwards',
        pointerEvents: 'none',
        filter: 'drop-shadow(0 1px 2px rgba(43,34,19,0.35))',
      }}
    >
      {useBadge ? (
        <>
          <img
            src={parts.src ?? undefined}
            alt={parts.face ?? ''}
            width={20}
            height={20}
            decoding="async"
            data-testid="playground-cat-mood-badge"
            style={{ display: 'block' }}
            onError={() => setImgFailed(true)}
          />
          {parts.rest}
        </>
      ) : (
        mood
      )}
      {moodSecondary && <span style={{ marginLeft: 1 }}>{moodSecondary}</span>}
    </span>
  )
}

function spriteAnim(activity: PlayCat['activity']): string | undefined {
  switch (activity) {
    case 'walk':
      return 'cat-walk-bob 570ms steps(2) infinite'
    case 'run':
    case 'chase':
    case 'flee':
      return 'cat-walk-bob 150ms steps(2) infinite'
    case 'sleep':
    case 'hammock':
      return 'cat-breathe 2600ms ease-in-out infinite'
    default:
      return undefined
  }
}
