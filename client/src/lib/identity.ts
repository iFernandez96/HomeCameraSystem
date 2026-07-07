import type { DetectionEvent } from './types'
import { recognizedNames } from './eventLabel'

/**
 * Playroom Modern identity system: WHO appeared, as a color.
 * Detection can't tell cats apart (label is just 'cat'), so cats share
 * the marmalade hue; recognized people get a stable personal hue from
 * a 6-hue wheel; unrecognized people are cobalt; anything else slate.
 * Alert red is deliberately not producible here.
 */

export type IdentityKind = 'named-person' | 'person' | 'cat' | 'other'

export interface Identity {
  kind: IdentityKind
  name: string | null
  colorVar: string
  softVar: string
}

const WHEEL_SIZE = 6

function tokenPair(token: string): { colorVar: string; softVar: string } {
  return { colorVar: `var(--color-id-${token})`, softVar: `var(--color-id-${token}-soft)` }
}

/** djb2 — tiny, stable, good spread on short lowercase names. */
function hashName(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0
  return h
}

export function identityForName(name: string): Identity {
  const slot = (hashName(name.toLowerCase()) % WHEEL_SIZE) + 1
  return { kind: 'named-person', name, ...tokenPair(`wheel-${slot}`) }
}

export function identityOf(
  e: Pick<DetectionEvent, 'label' | 'person_name' | 'person_names'>,
): Identity {
  const names = recognizedNames(e as DetectionEvent)
  if (names.length > 0) return identityForName(names[0])
  if (e.label === 'person') return { kind: 'person', name: null, ...tokenPair('person') }
  if (e.label === 'cat') return { kind: 'cat', name: null, ...tokenPair('mushu') }
  return { kind: 'other', name: null, ...tokenPair('panther') }
}

/** Brand trio for Login, avatars, empty states — NOT per-event colors. */
export const BRAND_CATS = [
  { name: 'Panther', colorVar: 'var(--color-id-panther)' },
  { name: 'Mushu', colorVar: 'var(--color-id-mushu)' },
  { name: 'Coco', colorVar: 'var(--color-id-coco)' },
] as const
