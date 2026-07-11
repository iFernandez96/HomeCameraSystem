import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
    // arrange — ✨ is a pure symbol glyph with no emotion mapping
    const mood = '✨'

    // act
    const parts = moodBadgeParts('coco', mood)

    // assert
    expect(parts.src).toBeNull()
    expect(parts.face).toBeNull()
    expect(parts.rest).toBe(mood)
  })

  it('Given a primary 💤 mood, When parts are computed for every cat, Then it resolves to that cat\'s own sleepy face badge (user ask 2026-07-11)', () => {
    // arrange — all three cats ship the sleepy badge
    for (const catId of CAT_IDS) {
      expect(AVAILABLE_MOOD_BADGES[catId]).toContain('sleepy')
    }

    // act + assert
    for (const catId of CAT_IDS) {
      const parts = moodBadgeParts(catId, '💤')
      expect(parts.src).toBe(moodBadgeUrl(catId, 'sleepy'))
      expect(parts.face).toBe('💤')
      expect(parts.rest).toBe('')
    }
  })

  it('Given the ground-poop rework (2026-07-11), When mood-emitting sources are scanned, Then no mood string carries 💩 and the shared badge table is empty (poop is a ground object, never a bubble)', () => {
    // arrange — the files that set moods on cats
    const sources = [
      join(__dirname, 'CatLayer.tsx'),
      join(__dirname, '..', 'playground', 'catBrain.beats.ts'),
      join(__dirname, '..', 'playground', 'stepPlayground.ts'),
    ]

    // act
    const offenders = sources.filter((path) => readFileSync(path, 'utf8').includes('💩'))

    // assert
    expect(offenders).toEqual([])
    expect(Object.keys(SHARED_MOOD_BADGES)).toEqual([])
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
