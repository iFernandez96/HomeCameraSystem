import { useEffect, useState } from 'react'

/**
 * iter-356.4-cats — particle-effect overlay for the ambient CatLayer.
 *
 * Each <CatParticles> instance spawns a short-lived field of small
 * absolutely-positioned spans that drift, pulse, or twinkle around a
 * cat's (x, y) origin. After ~2.4 s the component self-hides — caller
 * can either unmount or just leave it inert.
 *
 * Five visual variants:
 *   hearts   — 💕 floating up + sideways + fade (groom interaction)
 *   dust     — puffy clouds behind a chasing cat (text-tertiary token)
 *   sparkles — ✨ twinkle around a purring cat
 *   anger    — 💢 anger marks pulsing near a hissing cat
 *   zzz      — z's rising over a sleeping cat
 *
 * Constraints (mirrors CatLayer):
 *   - pointer-events: none on every particle
 *   - prefers-reduced-motion → render nothing
 *   - keyframes inline so the file is self-contained
 */

export type CatParticleType = 'hearts' | 'dust' | 'sparkles' | 'anger' | 'zzz'

type Props = {
  type: CatParticleType
  x: number
  y: number
  count: number
}

type Particle = {
  key: string
  glyph: string
  /** Horizontal offset from origin, px */
  dx: number
  /** Initial vertical offset from origin, px */
  dy: number
  /** Drift target x, px */
  driftX: number
  /** Drift target y, px (negative = up) */
  driftY: number
  /** Animation duration ms */
  duration: number
  /** Animation delay ms */
  delay: number
  /** Font size px */
  size: number
  /** Optional override color (CSS) */
  color?: string
}

const LIFETIME_MS = 2400

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function buildParticles(type: CatParticleType, count: number): Particle[] {
  const n = Math.max(1, Math.floor(count))
  const out: Particle[] = []
  for (let i = 0; i < n; i++) {
    const key = `${type}-${i}-${Math.random().toString(36).slice(2, 8)}`
    if (type === 'hearts') {
      out.push({
        key,
        glyph: Math.random() < 0.5 ? '💕' : '❤️',
        dx: rand(-8, 8),
        dy: rand(-2, 2),
        driftX: rand(-22, 22),
        driftY: rand(-44, -28),
        duration: rand(1600, 2200),
        delay: i * 90 + rand(0, 80),
        size: rand(12, 16),
      })
    } else if (type === 'dust') {
      out.push({
        key,
        glyph: '•',
        dx: rand(-14, 14),
        dy: rand(-2, 4),
        driftX: rand(-18, 18),
        driftY: rand(-6, 4),
        duration: rand(700, 1100),
        delay: i * 80 + rand(0, 60),
        size: rand(14, 22),
        color: 'var(--color-text-tertiary)',
      })
    } else if (type === 'sparkles') {
      out.push({
        key,
        glyph: '✨',
        dx: rand(-18, 18),
        dy: rand(-14, 6),
        driftX: rand(-6, 6),
        driftY: rand(-10, -2),
        duration: rand(900, 1400),
        delay: i * 110 + rand(0, 120),
        size: rand(12, 16),
        color: 'var(--color-warning)',
      })
    } else if (type === 'anger') {
      out.push({
        key,
        glyph: '💢',
        dx: rand(-12, 12),
        dy: rand(-12, -2),
        driftX: rand(-3, 3),
        driftY: rand(-6, -2),
        duration: rand(600, 900),
        delay: i * 120 + rand(0, 80),
        size: rand(14, 18),
        color: 'var(--color-danger)',
      })
    } else {
      // zzz
      out.push({
        key,
        glyph: 'z',
        dx: rand(-4, 8),
        dy: rand(-4, 0),
        driftX: rand(8, 18),
        driftY: rand(-40, -28),
        duration: rand(1800, 2400),
        delay: i * 380,
        size: 10 + i * 2,
        color: 'var(--color-text-secondary)',
      })
    }
  }
  return out
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function CatParticles({ type, x, y, count }: Props) {
  const reducedMotion = usePrefersReducedMotion()
  const [hidden, setHidden] = useState(false)
  const [particles] = useState<Particle[]>(() => buildParticles(type, count))

  useEffect(() => {
    if (reducedMotion) return
    const t = window.setTimeout(() => setHidden(true), LIFETIME_MS)
    return () => window.clearTimeout(t)
  }, [reducedMotion])

  if (reducedMotion || hidden) return null

  // Per-instance keyframe names (one set per type) — define inline so the
  // module doesn't depend on a global stylesheet edit.
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: x,
        bottom: y,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    >
      <style>{`
        @keyframes cat-particle-hearts {
          0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
          15%  { transform: translate(calc(var(--drift-x) * 0.2), calc(var(--drift-y) * 0.15)) scale(1.05); opacity: 1; }
          85%  { opacity: 1; }
          100% { transform: translate(var(--drift-x), var(--drift-y)) scale(0.85); opacity: 0; }
        }
        @keyframes cat-particle-dust {
          0%   { transform: translate(0, 0) scale(0.4); opacity: 0; }
          25%  { transform: translate(calc(var(--drift-x) * 0.4), calc(var(--drift-y) * 0.4)) scale(1); opacity: 0.7; }
          100% { transform: translate(var(--drift-x), var(--drift-y)) scale(1.6); opacity: 0; }
        }
        @keyframes cat-particle-sparkles {
          0%, 100% { transform: translate(var(--drift-x), var(--drift-y)) scale(0.4); opacity: 0; }
          30%      { transform: translate(calc(var(--drift-x) * 0.6), calc(var(--drift-y) * 0.6)) scale(1.1); opacity: 1; }
          60%      { transform: translate(calc(var(--drift-x) * 0.8), calc(var(--drift-y) * 0.8)) scale(0.9); opacity: 1; }
        }
        @keyframes cat-particle-anger {
          0%   { transform: scale(0.4); opacity: 0; }
          25%  { transform: scale(1.25); opacity: 1; }
          55%  { transform: scale(0.95); opacity: 1; }
          100% { transform: translate(var(--drift-x), var(--drift-y)) scale(0.7); opacity: 0; }
        }
        @keyframes cat-particle-zzz {
          0%   { transform: translate(0, 0) scale(0.6); opacity: 0; }
          20%  { opacity: 1; }
          100% { transform: translate(var(--drift-x), var(--drift-y)) scale(1.1); opacity: 0; }
        }
      `}</style>
      {particles.map((p) => (
        <span
          key={p.key}
          style={
            {
              position: 'absolute',
              left: p.dx,
              bottom: -p.dy,
              fontSize: p.size,
              lineHeight: 1,
              color: p.color ?? 'inherit',
              pointerEvents: 'none',
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))',
              animation: `cat-particle-${type} ${p.duration}ms ease-out ${p.delay}ms forwards`,
              willChange: 'transform, opacity',
              ['--drift-x' as string]: `${p.driftX}px`,
              ['--drift-y' as string]: `${p.driftY}px`,
            } as React.CSSProperties
          }
        >
          {p.glyph}
        </span>
      ))}
    </div>
  )
}
