import { describe, expect, it } from 'vitest'
import { CAT_ANIM_MANIFEST } from '../components/catAnimSequences'
import {
  PLAYGROUND_CAT_FRAME_NAMES,
  PLAYGROUND_CAT_IDS,
  PLAYGROUND_PRELOAD_WAVE_1,
  PLAYGROUND_PRELOAD_WAVE_2,
  playgroundCatFrameUrl,
} from './playgroundAssets'
import { PLAYGROUND_SEQUENCES } from './playgroundSequences'

// Slice A pins validate against the MANIFEST CONSTANTS, not the disk —
// the playground PNGs are still generating; the on-disk pin lands with
// the export step (see the TODO in playgroundAssets.ts).

describe('playgroundSequences', () => {
  it('Given every playground sequence, When its frames are checked against the manifests, Then each frame is a playground frame or a shared checked-in anim frame for every cat', () => {
    // arrange
    const playgroundFrames = new Set<string>(PLAYGROUND_CAT_FRAME_NAMES)

    // act / assert — a frame that is neither playground-specific nor in
    // every cat's shared CAT_ANIM_MANIFEST would 404 for at least one
    // cat once the brain plays the bout.
    for (const [name, steps] of Object.entries(PLAYGROUND_SEQUENCES)) {
      for (const step of steps) {
        const inPlayground = playgroundFrames.has(step.frame)
        const inSharedForAllCats = PLAYGROUND_CAT_IDS.every((catId) =>
          (CAT_ANIM_MANIFEST[catId] as readonly string[]).includes(step.frame),
        )
        expect(
          inPlayground || inSharedForAllCats,
          `sequence "${name}" uses frame "${step.frame}" that no manifest provides`,
        ).toBe(true)
      }
    }
  })

  it('Given every sequence step, When durations are read, Then each ms is a positive integer (the 1ms hold-pose convention is the floor)', () => {
    // arrange / act / assert
    for (const steps of Object.values(PLAYGROUND_SEQUENCES)) {
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        expect(Number.isInteger(step.ms)).toBe(true)
        expect(step.ms).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('Given the two preload waves, When compared, Then wave 1 is furniture-only, wave 2 covers toys+ambient+per-cat frames, and the sets do not overlap', () => {
    // arrange / act
    const wave1 = new Set(PLAYGROUND_PRELOAD_WAVE_1)
    const wave2 = new Set(PLAYGROUND_PRELOAD_WAVE_2)

    // assert — 12 furniture pieces; 6 toys + 4 ambient + 3 cats × 5 frames.
    expect(wave1.size).toBe(12)
    expect(wave2.size).toBe(6 + 4 + 3 * 5)
    for (const url of wave1) {
      expect(url).toMatch(/^\/cats\/playground\/furniture\/[a-z_]+\.png$/)
      expect(wave2.has(url)).toBe(false)
    }
    // Per-cat frame URLs resolve under the cat's own directory.
    expect(playgroundCatFrameUrl('mushu', 'bat_a')).toBe(
      '/cats/playground/mushu/bat_a.png',
    )
  })
})
