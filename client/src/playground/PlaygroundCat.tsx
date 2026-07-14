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

function PlaygroundCatImpl({ cat, onPetStart, onPetEnd }: PlaygroundCatProps) {
  const plan = playgroundAnimationPlanFor(cat, cat.phaseTime)
  // Playground art may still be generating: a 404ing rich frame falls
  // back to the shared seated pose before hiding entirely.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const hidden = cat.activity === 'tunnel'
  const frame = plan.frame ?? 'seated'
  let src = playFrameUrl(cat.id, frame)
  if (failedSrc === src) src = catAnimFrameUrl(cat.id, 'seated')
  const backLane = cat.lane === 'back'
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
        transform: `translateX(${cat.x}px)${backLane ? ` scale(${BACK_LANE_SCALE})` : ''}`,
        transformOrigin: 'bottom center',
        willChange: 'transform',
        zIndex: backLane ? 1 : 2,
        visibility: hidden ? 'hidden' : undefined,
      }}
    >
      <div data-testid="playground-cat-entrance-wrapper" style={{ width: '100%', height: '100%' }}>
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
              width={CAT_WIDTH_PX}
              height={CAT_HEIGHT_PX}
              data-testid="playground-cat-sprite"
              data-cat-id={cat.id}
              data-anim-frame={frame}
              decoding="async"
              loading="lazy"
              style={{ objectFit: 'contain', objectPosition: 'center bottom', display: 'block' }}
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
          the cat, not the scene (which owns verb gestures). */}
      <div
        data-testid={`playground-cat-hit-${cat.id}`}
        style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}
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
