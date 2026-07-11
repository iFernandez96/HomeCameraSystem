import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAT_IDS } from './catAnimSequences'
import {
  AVAILABLE_MOOD_BADGES,
  EMOJI_TO_EMOTION,
  SHARED_MOOD_BADGES,
  moodBadgeParts,
  moodBadgeUrl,
} from './catMoodBadges'

const ASSET_ROOT = join(__dirname, '..', '..', 'public', 'cats', 'mood')

describe('cat mood badges', () => {
  it('Given the availability table, When the exported asset dir is scanned, Then table and disk agree exactly both ways', () => {
    // arrange
    const mismatches: string[] = []

    // act
    for (const catId of CAT_IDS) {
      for (const emotion of AVAILABLE_MOOD_BADGES[catId]) {
        if (!existsSync(join(ASSET_ROOT, catId, `${emotion}.png`))) {
          mismatches.push(`table lists ${catId}/${emotion} but no PNG on disk`)
        }
      }
      const dir = join(ASSET_ROOT, catId)
      const onDisk = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith('.png'))
        : []
      for (const file of onDisk) {
        const emotion = file.replace(/\.png$/, '')
        if (!AVAILABLE_MOOD_BADGES[catId].includes(emotion as never)) {
          mismatches.push(`${catId}/${file} on disk but missing from table`)
        }
      }
    }

    // assert
    expect(mismatches).toEqual([])
  })

  it('Given a mood string with a mapped face and a symbol, When parts are computed, Then the face becomes the badge and the symbol stays text', () => {
    // arrange — only run the positive path when the badge shipped.
    const hasLove = AVAILABLE_MOOD_BADGES.mushu.includes('love')

    // act
    const parts = moodBadgeParts('mushu', '😻💕')

    // assert
    if (hasLove) {
      expect(parts.src).toBe(moodBadgeUrl('mushu', 'love'))
      expect(parts.face).toBe('😻')
      expect(parts.rest).toBe('💕')
    } else {
      expect(parts.src).toBeNull()
      expect(parts.rest).toBe('😻💕')
    }
  })

  it('Given a symbols-only mood, When parts are computed, Then no badge is used and the full string stays text', () => {
    // arrange
    const mood = '💤'

    // act
    const parts = moodBadgeParts('coco', mood)

    // assert
    expect(parts.src).toBeNull()
    expect(parts.face).toBeNull()
    expect(parts.rest).toBe(mood)
  })

  it('Given the shared 💩 glyph, When parts are computed for every cat, Then all cats resolve to the same poop prop badge', () => {
    // arrange
    const expectedSrc = SHARED_MOOD_BADGES['💩']

    // act
    const parts = CAT_IDS.map((catId) => moodBadgeParts(catId, '💩'))

    // assert — shared badge, not a per-cat mood asset.
    expect(expectedSrc).toBe('/cats/props/poop.png')
    for (const p of parts) {
      expect(p.src).toBe(expectedSrc)
      expect(p.face).toBe('💩')
      expect(p.rest).toBe('')
    }
  })

  it('Given the shared badge table, When the exported props dir is scanned, Then each shared badge PNG exists on disk', () => {
    // arrange
    const propsRoot = join(__dirname, '..', '..', 'public')

    // act
    const missing = Object.entries(SHARED_MOOD_BADGES)
      .filter(([, url]) => !existsSync(join(propsRoot, url)))
      .map(([glyph, url]) => `${glyph} -> ${url}`)

    // assert
    expect(missing).toEqual([])
  })

  it('Given every mood emoji used by CatLayer pools, When looked up, Then each face emoji maps to an emotion archetype', () => {
    // arrange — the face glyphs that appear in MOOD pools + setMood calls.
    const faces = ['😼', '😾', '😺', '😸', '😹', '🤣', '😻', '🥰', '😨', '🙀', '😱', '😡', '😴', '🥱', '😿', '😢']

    // act
    const unmapped = faces.filter((f) => !EMOJI_TO_EMOTION[f])

    // assert
    expect(unmapped).toEqual([])
  })
})
