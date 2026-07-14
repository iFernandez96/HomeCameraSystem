import type { SyntheticEvent } from 'react'

// Ground poop with a lifecycle (user directive 2026-07-11: "Poop
// shouldn't be an emoji that flys upward. It should be on the ground
// for a bit and disappear seconds later with smell fumes coming from
// the top."). Shared by CatLayer (ambient cats) and the Playground:
// when a poop_squat bout COMPLETES, the prop appears on the ground at
// the cat's trailing edge, outlives the activity (the cat walks away
// and the poop stays put in scene coordinates), then fades out.
//
// Animation discipline (the entrance-fill trap, Panther-mirror bug
// 2026-07-11): a filled CSS animation overrides inline `transform` on
// its own element FOREVER. The outer positioned container therefore
// carries OPACITY-ONLY animations (appear + delayed fade) and no
// transform keyframes; the fume drift's translateY lives on a nested
// wrapper that carries no inline transform of its own.

export const POOP_SIZE_FRAC = 0.42
/** Fade-out duration once the visible window elapses. */
export const POOP_FADE_MS = 600
/** Visible window: 6–8 s, jittered per poop. */
export const POOP_VISIBLE_MIN_MS = 6000
export const POOP_VISIBLE_JITTER_MS = 2000

const FUME_FLICKER_MS = 220

export type GroundPoopSpawn = {
  /** Scene left-edge x of the prop (px). */
  x: number
  spawnedAt: number
  /** Fade start stamp; the poop leaves state at fadeAt + POOP_FADE_MS. */
  fadeAt: number
}

/** Where and how long a fresh poop lives: at the cat's TRAILING edge
    (direction-aware — behind the cat, opposite its facing), visible
    6–8 s jittered, then a 600ms fade. Pure; random injected. */
export function spawnGroundPoop(
  catX: number,
  direction: 'L' | 'R',
  catWidth: number,
  now: number,
  random: () => number = Math.random,
): GroundPoopSpawn {
  const size = Math.round(catWidth * POOP_SIZE_FRAC)
  const x =
    direction === 'L'
      ? catX + catWidth - size * 0.45 // facing left — poop trails right
      : catX - size * 0.55 // facing right — poop trails left
  return {
    x: Math.round(x),
    spawnedAt: now,
    fadeAt: now + POOP_VISIBLE_MIN_MS + random() * POOP_VISIBLE_JITTER_MS,
  }
}

/** True once the poop's whole lifecycle (visible window + fade) has
    played out and it should leave state. */
export function groundPoopExpired(poop: GroundPoopSpawn, now: number): boolean {
  return now > poop.fadeAt + POOP_FADE_MS
}

function hideOnError(event: SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = 'none'
}

export type GroundPoopProps = {
  /** Scene left-edge x in px. */
  x: number
  /** Bottom offset in px (the ground line the cat stood on). */
  bottom: number
  /** Render size in px (cat width × POOP_SIZE_FRAC, lane-scaled). */
  size: number
  /** Visible window before the fade starts (fadeAt - spawnedAt). */
  visibleMs: number
  zIndex?: number
}

/** The prop + its stink fumes: two thin wavy wisp sprites alternating
    a/b every ~220ms inside a slowly drifting-and-dimming wrapper. The
    whole container fades via a delayed opacity animation, so no
    re-render is needed between spawn and removal. */
export function GroundPoop({ x, bottom, size, visibleMs, zIndex = 0 }: GroundPoopProps) {
  const fumeW = Math.round(size * 0.75)
  const fumeH = Math.round(fumeW * (76 / 24)) // fume_a/b natural 24×76
  return (
    <div
      data-testid="ground-poop"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: x,
        bottom,
        width: size,
        height: size,
        pointerEvents: 'none',
        zIndex,
        // Opacity-only, both filled: appear once, then fade after the
        // visible window. Safe — no transform keyframes on this element.
        animation: `ground-poop-appear 400ms ease-out both, ground-poop-fade ${POOP_FADE_MS}ms ease-in ${Math.max(0, Math.round(visibleMs))}ms both`,
      }}
    >
      <style>{`
        @keyframes ground-poop-appear {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes ground-poop-fade {
          0%   { opacity: 1; }
          100% { opacity: 0; }
        }
        /* The drift wrapper has NO inline transform, so a transform
           keyframe animation is safe there. */
        @keyframes ground-poop-fume-drift {
          0%   { transform: translateY(2px); opacity: 0.5; }
          55%  { transform: translateY(-3px); opacity: 0.95; }
          100% { transform: translateY(-6px); opacity: 0.35; }
        }
        @keyframes ground-poop-fume-a {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0; }
        }
        @keyframes ground-poop-fume-b {
          0%, 100% { opacity: 0; }
          50%      { opacity: 1; }
        }
      `}</style>
      <img
        src="/cats/props/poop.png"
        alt=""
        data-testid="ground-poop-prop"
        width={size}
        height={size}
        decoding="async"
        style={{ display: 'block', width: size, height: size }}
        onError={hideOnError}
      />
      <div
        data-testid="ground-poop-fumes"
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '78%',
          width: fumeW,
          height: fumeH,
          marginLeft: -Math.round(fumeW / 2),
          animation: `ground-poop-fume-drift 1600ms ease-in-out infinite`,
        }}
      >
        <img
          src="/cats/props/fume_a.png"
          alt=""
          width={fumeW}
          height={fumeH}
          decoding="async"
          style={{
            position: 'absolute',
            inset: 0,
            width: fumeW,
            height: fumeH,
            animation: `ground-poop-fume-a ${FUME_FLICKER_MS * 2}ms steps(1) infinite`,
          }}
          onError={hideOnError}
        />
        <img
          src="/cats/props/fume_b.png"
          alt=""
          width={fumeW}
          height={fumeH}
          decoding="async"
          style={{
            position: 'absolute',
            inset: 0,
            width: fumeW,
            height: fumeH,
            animation: `ground-poop-fume-b ${FUME_FLICKER_MS * 2}ms steps(1) infinite`,
          }}
          onError={hideOnError}
        />
      </div>
    </div>
  )
}
