import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CAT_ANIM_SEQUENCES,
  CAT_IDS,
  catAnimFrameUrl,
  gaitVelocityPxPerMs,
  sequenceDurationMs,
  type CatAnimId,
  type CatAnimSequenceName,
  type CatAnimStep,
} from '../components/catAnimSequences'
import { _catSequenceNamesForTransitionForTests } from '../components/CatLayer'
import {
  AVAILABLE_MOOD_BADGES,
  EMOJI_TO_EMOTION,
  moodBadgeUrl,
  type MoodEmotion,
} from '../components/catMoodBadges'

// Dev/QA harness — public, unlisted. Plays every animation sequence,
// gait translation cycle, and activity->activity transition chain
// EXACTLY as CatLayer computes them (same sequence tables, same ms
// timings, same gait velocity, same flip rule) so each action can be
// verified in isolation. No API calls; safe on an unauthenticated
// preview server.

const SEQUENCE_NAMES = Object.keys(CAT_ANIM_SEQUENCES) as CatAnimSequenceName[]

// Mirror of POSE_GROUP_BY_ACTIVITY's keys in CatLayer (the type is not
// exported; keep the label list local — the chain itself comes from the
// exported helper, so a drift here can only hide a choice, not lie).
const ACTIVITIES = [
  'walk',
  'chase',
  'flee',
  'sit',
  'judge',
  'loaf',
  'snuggle',
  'groom',
  'in_box',
  'sleep',
  'stretch',
  'play',
  'pounce',
  'on_post',
  'pooped',
  'hiss',
  'scared',
] as const

type ActivityName = (typeof ACTIVITIES)[number]

const SPRITE = 96

function stepsForChain(
  cat: CatAnimId,
  names: readonly CatAnimSequenceName[],
): CatAnimStep[] {
  return names.flatMap((name) => CAT_ANIM_SEQUENCES[name][cat])
}

function frameAt(steps: readonly CatAnimStep[], elapsed: number, loop: boolean) {
  const total = sequenceDurationMs(steps)
  if (total <= 0 || steps.length === 0) return null
  let cursor = loop ? elapsed % total : Math.min(elapsed, total - 1)
  for (let i = 0; i < steps.length; i++) {
    if (cursor < steps[i].ms) return { step: steps[i], index: i }
    cursor -= steps[i].ms
  }
  return { step: steps[steps.length - 1], index: steps.length - 1 }
}

function usePlayerClock(playing: boolean, speed: number) {
  const [elapsed, setElapsed] = useState(0)
  const raf = useRef(0)
  const last = useRef<number | null>(null)
  useEffect(() => {
    if (!playing) {
      last.current = null
      return
    }
    const tick = (t: number) => {
      if (last.current !== null) {
        const dt = Math.min(t - last.current, 50)
        setElapsed((e) => e + dt * speed)
      }
      last.current = t
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, speed])
  return [elapsed, setElapsed] as const
}

function SpriteFrame({
  cat,
  frame,
  flipped,
  ghost,
}: {
  cat: CatAnimId
  frame: string | null
  flipped: boolean
  ghost?: string | null
}) {
  return (
    <div
      style={{
        position: 'relative',
        width: SPRITE,
        height: SPRITE * 1.2,
        transform: flipped ? 'scaleX(-1)' : undefined,
      }}
    >
      {ghost ? (
        <img
          src={catAnimFrameUrl(cat, ghost as never)}
          alt=""
          width={SPRITE}
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.35,
            filter: 'sepia(1) saturate(8) hue-rotate(-50deg)',
          }}
        />
      ) : null}
      {frame ? (
        <img
          src={catAnimFrameUrl(cat, frame as never)}
          alt={frame}
          width={SPRITE}
          style={{ position: 'absolute', inset: 0 }}
        />
      ) : (
        <span className="text-xs opacity-60">no frames (empty sequence)</span>
      )}
    </div>
  )
}

const ALL_EMOTIONS = Array.from(new Set(Object.values(EMOJI_TO_EMOTION)))
const EMOTION_TO_EMOJI: Partial<Record<MoodEmotion, string>> = {}
for (const [emoji, emotion] of Object.entries(EMOJI_TO_EMOTION)) {
  if (!EMOTION_TO_EMOJI[emotion]) EMOTION_TO_EMOJI[emotion] = emoji
}

/** Per-cat mood badge inventory: shipped badges render as images, the
    rest show the emoji they would fall back to. */
function MoodBadgeGrid() {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold">Mood badges (shipped vs emoji fallback)</h2>
      <div style={{ overflowX: 'auto' }}>
        <table className="text-xs" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ padding: 4 }}>cat</th>
              {ALL_EMOTIONS.map((e) => (
                <th key={e} style={{ padding: 4, fontWeight: 400 }}>{e}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CAT_IDS.map((catId) => (
              <tr key={catId}>
                <td style={{ padding: 4, fontWeight: 700 }}>{catId}</td>
                {ALL_EMOTIONS.map((emotion) => (
                  <td key={emotion} style={{ padding: 4, textAlign: 'center', border: '1px solid #ccc4' }}>
                    {AVAILABLE_MOOD_BADGES[catId].includes(emotion) ? (
                      <img
                        src={moodBadgeUrl(catId, emotion)}
                        alt={`${catId} ${emotion}`}
                        width={28}
                        height={28}
                        style={{ display: 'inline-block' }}
                      />
                    ) : (
                      <span style={{ fontSize: 16, opacity: 0.45 }} title="fallback emoji">
                        {EMOTION_TO_EMOJI[emotion]}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function AnimLab() {
  const [cat, setCat] = useState<CatAnimId>('panther')
  const [mode, setMode] = useState<'sequence' | 'transition' | 'treadmill'>(
    'sequence',
  )
  const [sequence, setSequence] = useState<CatAnimSequenceName>('walk')
  const [fromActivity, setFromActivity] = useState<ActivityName>('sleep')
  const [toActivity, setToActivity] = useState<ActivityName>('walk')
  const [gait, setGait] = useState<'walk' | 'run'>('walk')
  const [direction, setDirection] = useState<'L' | 'R'>('L')
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(true)
  const [onion, setOnion] = useState(false)
  const [elapsed, setElapsed] = usePlayerClock(playing, speed)

  const chainNames = useMemo<readonly CatAnimSequenceName[]>(() => {
    if (mode === 'sequence') return [sequence]
    if (mode === 'transition')
      return _catSequenceNamesForTransitionForTests(fromActivity, toActivity)
    return [gait]
  }, [mode, sequence, fromActivity, toActivity, gait])

  const steps = useMemo(() => stepsForChain(cat, chainNames), [cat, chainNames])
  const loop = mode === 'treadmill' || (mode === 'sequence' && (sequence === 'walk' || sequence === 'run'))
  const current = frameAt(steps, elapsed, loop)
  const prevStep = current && current.index > 0 ? steps[current.index - 1] : null
  const total = sequenceDurationMs(steps)

  // Treadmill translation — the REAL gait velocity from catAnimSequences,
  // so foot-slide (stride vs px/ms mismatch) is visible immediately.
  const [laneW, setLaneW] = useState(640)
  const laneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = laneRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const velocity = gaitVelocityPxPerMs(gait, SPRITE)
  const travel = Math.max(0, laneW - SPRITE)
  const treadmillX =
    mode === 'treadmill'
      ? direction === 'R'
        ? (elapsed * velocity) % travel
        : travel - ((elapsed * velocity) % travel)
      : 0

  const flipped = direction === 'R' // PNGs face LEFT natively

  return (
    <main className="mx-auto max-w-3xl p-4 space-y-4" style={{ fontFamily: 'monospace' }}>
      <h1 className="text-lg font-bold">Cat animation lab</h1>
      <p className="text-sm opacity-70">
        Plays the real CAT_ANIM_SEQUENCES tables, transition chains, and gait
        velocities used by CatLayer. Sprites natively face LEFT; direction R
        applies scaleX(-1), same as the app.
      </p>

      <div className="flex flex-wrap gap-2 items-center text-sm">
        <label>
          cat{' '}
          <select value={cat} onChange={(e) => { setCat(e.target.value as CatAnimId); setElapsed(0) }}>
            {CAT_IDS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          mode{' '}
          <select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setElapsed(0) }}>
            <option value="sequence">sequence</option>
            <option value="transition">transition</option>
            <option value="treadmill">treadmill</option>
          </select>
        </label>
        {mode === 'sequence' && (
          <label>
            sequence{' '}
            <select value={sequence} onChange={(e) => { setSequence(e.target.value as CatAnimSequenceName); setElapsed(0) }}>
              {SEQUENCE_NAMES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        )}
        {mode === 'transition' && (
          <>
            <label>
              from{' '}
              <select value={fromActivity} onChange={(e) => { setFromActivity(e.target.value as ActivityName); setElapsed(0) }}>
                {ACTIVITIES.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label>
              to{' '}
              <select value={toActivity} onChange={(e) => { setToActivity(e.target.value as ActivityName); setElapsed(0) }}>
                {ACTIVITIES.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {mode === 'treadmill' && (
          <label>
            gait{' '}
            <select value={gait} onChange={(e) => { setGait(e.target.value as 'walk' | 'run'); setElapsed(0) }}>
              <option>walk</option>
              <option>run</option>
            </select>
          </label>
        )}
        <label>
          dir{' '}
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'L' | 'R')}>
            <option>L</option>
            <option>R</option>
          </select>
        </label>
        <label>
          speed{' '}
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[0.1, 0.25, 0.5, 1, 2].map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <button className="border px-2 rounded" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'pause' : 'play'}
        </button>
        <button className="border px-2 rounded" onClick={() => setElapsed(0)}>
          restart
        </button>
        <label>
          <input type="checkbox" checked={onion} onChange={(e) => setOnion(e.target.checked)} /> onion
        </label>
      </div>

      <div className="text-xs opacity-80">
        chain: [{chainNames.join(' → ') || 'EMPTY'}] · {steps.length} steps ·{' '}
        {total}ms · frame {current ? `${current.index + 1}/${steps.length}` : '-'} ={' '}
        {current?.step.frame ?? '-'} ({current?.step.ms}ms)
        {mode === 'treadmill' && ` · v=${(velocity * 1000).toFixed(1)}px/s`}
      </div>

      <div
        ref={laneRef}
        style={{
          position: 'relative',
          height: SPRITE * 1.35,
          border: '1.5px solid #999',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'linear-gradient(#0000 92%, #9993 92%)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            bottom: 4,
            left: 0,
            transform: `translateX(${mode === 'treadmill' ? treadmillX : travel / 2}px)`,
          }}
        >
          <SpriteFrame
            cat={cat}
            frame={current?.step.frame ?? null}
            flipped={flipped}
            ghost={onion ? (prevStep?.frame ?? null) : null}
          />
        </div>
      </div>

      <MoodBadgeGrid />

      {/* Frame-by-frame scrubber strip */}
      <div className="flex flex-wrap gap-1">
        {steps.map((s, i) => (
          <button
            key={`${s.frame}-${i}`}
            onClick={() => {
              setPlaying(false)
              setElapsed(steps.slice(0, i).reduce((t, x) => t + x.ms, 0))
            }}
            style={{
              border: current?.index === i ? '2px solid #d33' : '1px solid #bbb',
              borderRadius: 6,
              padding: 2,
              background: 'transparent',
            }}
            title={`${s.frame} ${s.ms}ms`}
          >
            <img src={catAnimFrameUrl(cat, s.frame)} alt={s.frame} width={40} style={{ transform: flipped ? 'scaleX(-1)' : undefined }} />
          </button>
        ))}
      </div>
    </main>
  )
}
