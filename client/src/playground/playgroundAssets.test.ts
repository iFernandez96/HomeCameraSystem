import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLAYGROUND_AMBIENT_URLS,
  PLAYGROUND_CAT_FRAME_MANIFEST,
  PLAYGROUND_CAT_FRAME_URLS,
  PLAYGROUND_FURNITURE_URLS,
  PLAYGROUND_TOY_URLS,
} from './playgroundAssets'

const PUBLIC_ROOT = join(__dirname, '..', '..', 'public')

describe('playground asset manifest', () => {
  it('Given every manifest URL, When the exported asset dir is scanned, Then each PNG exists on disk', () => {
    // arrange — flatten all four manifests into url strings
    const urls: string[] = [
      ...Object.values(PLAYGROUND_FURNITURE_URLS),
      ...Object.values(PLAYGROUND_TOY_URLS),
      ...Object.values(PLAYGROUND_AMBIENT_URLS),
      ...Object.values(PLAYGROUND_CAT_FRAME_URLS).flatMap((byFrame) =>
        Object.values(byFrame as Record<string, string>),
      ),
    ]

    // act
    const missing = urls.filter((url) => !existsSync(join(PUBLIC_ROOT, url)))

    // assert — 73 assets (12 furniture + 6 toys + 4 ambient + 3 cats
    // × 17 manifest frames each), generated and gated 2026-07-11; a
    // missing file means an export regression, not a generation gap.
    expect(urls.length).toBeGreaterThanOrEqual(73)
    expect(missing).toEqual([])
  })

  it('Given the 2026-07-11 tween-wave-2 midpoints, When each *_ab frame is checked per cat, Then the per-cat manifest matches the disk exactly', () => {
    // arrange — scratch_ab/eat_ab/bat_ab shipped for all three cats;
    // the re-rolls for coco/drink_ab, mushu/climb_ab and
    // panther/climb_ab came out deformed twice and were permanently
    // DROPPED, so drink_ab is panther+mushu-only, climb_ab coco-only.
    const allTweens = ['scratch_ab', 'eat_ab', 'bat_ab', 'climb_ab', 'drink_ab'] as const

    // act / assert — expected midpoints exist on disk; dropped ones do
    // NOT (a resurrected file means the manifest should be revisited).
    for (const catId of ['panther', 'mushu', 'coco'] as const) {
      for (const frame of allTweens) {
        const onDisk = existsSync(
          join(PUBLIC_ROOT, 'cats', 'playground', catId, `${frame}.png`),
        )
        const inManifest = (
          PLAYGROUND_CAT_FRAME_MANIFEST[catId] as readonly string[]
        ).includes(frame)
        expect(onDisk, `${catId}/${frame} on disk`).toBe(inManifest)
        expect(inManifest, `${catId}/${frame} in manifest`).toBe(
          frame === 'climb_ab' ? catId === 'coco'
          : frame === 'drink_ab' ? catId !== 'coco'
          : true,
        )
      }
    }
  })

  it('Given the 2026-07-11 interaction-frame wave, When each new frame is checked per cat, Then all 8 exist on disk for all 3 cats', () => {
    // arrange — the interaction wave: scratch/climb (160-tall canvases),
    // drink, hammock_lie, window_watch (128-tall)
    const newFrames = [
      'scratch_a',
      'scratch_b',
      'climb_a',
      'climb_b',
      'drink_a',
      'drink_b',
      'hammock_lie',
      'window_watch',
    ] as const

    // act
    const missing: string[] = []
    for (const [catId, byFrame] of Object.entries(PLAYGROUND_CAT_FRAME_URLS)) {
      for (const frame of newFrames) {
        const url = (byFrame as Record<string, string>)[frame]
        if (!url || !existsSync(join(PUBLIC_ROOT, url))) missing.push(`${catId}/${frame}`)
      }
    }

    // assert
    expect(missing).toEqual([])
  })
})
