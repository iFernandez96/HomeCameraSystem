import type { CatAnimId } from './catAnimSequences'

// Cat-personalized mood badges (user directive 2026-07-11): mood bubbles
// show THIS cat's face wearing the emotion instead of a generic emoji.
// Face emojis map to emotion archetypes; symbol glyphs (💤 ✨ 💢 🐾 ⚡ 💨
// 👀 💕) stay as text beside the badge. Every lookup falls back to the
// original emoji when a badge is missing or fails to load, so moods can
// never go blank.

export type MoodEmotion =
  | 'smug'
  | 'grumpy'
  | 'happy'
  | 'grin'
  | 'laugh'
  | 'love'
  | 'scared'
  | 'shock'
  | 'furious'
  | 'sleepy'
  | 'yawn'
  | 'sad'

export const EMOJI_TO_EMOTION: Readonly<Record<string, MoodEmotion>> = {
  '😼': 'smug',
  '😾': 'grumpy',
  '😺': 'happy',
  '😸': 'grin',
  '😹': 'laugh',
  '🤣': 'laugh',
  '😻': 'love',
  '🥰': 'love',
  '😨': 'scared',
  '🙀': 'shock',
  '😱': 'shock',
  '😡': 'furious',
  '😴': 'sleepy',
  '🥱': 'yawn',
  '😿': 'sad',
  '😢': 'sad',
}

// Exported badge assets that actually exist on disk (gated one by one).
// Keep in lock-step with client/public/cats/mood/<cat>/<emotion>.png —
// pinned by catMoodBadges.test.ts against the real directory.
export const AVAILABLE_MOOD_BADGES: Readonly<Record<CatAnimId, readonly MoodEmotion[]>> = {
  panther: ['smug', 'grumpy', 'happy', 'furious', 'shock', 'sleepy', 'yawn', 'love'],
  mushu: ['happy', 'smug', 'grin', 'laugh', 'love', 'grumpy', 'scared', 'shock', 'sleepy', 'yawn', 'sad'],
  coco: ['sleepy', 'love', 'grin', 'yawn', 'sad', 'shock'],
}

export function moodBadgeUrl(catId: CatAnimId, emotion: MoodEmotion): string {
  return `/cats/mood/${catId}/${emotion}.png`
}

// Shared (cat-agnostic) badge art for non-face glyphs that have a prop
// sprite. Unlike AVAILABLE_MOOD_BADGES these are the SAME image for every
// cat, and they take priority over the per-cat face table so a prop glyph
// always renders as its prop. CatMoodBubble's img onError fallback still
// covers a missing/broken file by showing the raw emoji.
export const SHARED_MOOD_BADGES: Readonly<Record<string, string>> = {
  '💩': '/cats/props/poop.png',
}

export type MoodBadgeParts = {
  /** Badge image URL for the first mapped face emoji, if available. */
  src: string | null
  /** The emoji the badge replaces (used as alt + fallback). */
  face: string | null
  /** Remaining glyphs (symbols / unmapped faces) to render as text. */
  rest: string
}

/**
 * Split a mood string (e.g. "😻💕") into a per-cat badge and the textual
 * remainder. The FIRST glyph with a badge available for this cat becomes
 * the image; everything else stays text in original order.
 */
export function moodBadgeParts(catId: CatAnimId, mood: string): MoodBadgeParts {
  const glyphs = [...mood]
  // Shared prop badges win over per-cat face badges.
  for (let i = 0; i < glyphs.length; i++) {
    const shared = SHARED_MOOD_BADGES[glyphs[i] ?? '']
    if (shared) {
      return {
        src: shared,
        face: glyphs[i] ?? null,
        rest: glyphs.filter((_, j) => j !== i).join(''),
      }
    }
  }
  const available = new Set(AVAILABLE_MOOD_BADGES[catId])
  for (let i = 0; i < glyphs.length; i++) {
    const emotion = EMOJI_TO_EMOTION[glyphs[i] ?? '']
    if (emotion && available.has(emotion)) {
      return {
        src: moodBadgeUrl(catId, emotion),
        face: glyphs[i] ?? null,
        rest: glyphs.filter((_, j) => j !== i).join(''),
      }
    }
  }
  return { src: null, face: null, rest: mood }
}
