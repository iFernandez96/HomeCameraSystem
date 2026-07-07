import type { Identity } from '../lib/identity'
import { BRAND_CATS } from '../lib/identity'

/**
 * The Playroom signature mark. One shape everywhere: avatar on event
 * cards, filter chips, timeline bands, empty states. Cats (and
 * non-person subjects) are a rounded square with two triangle ears;
 * people are a circle. Color comes from the identity token, so the
 * mark stays correct in both themes.
 */
const KIND_LABEL: Record<Identity['kind'], string> = {
  'named-person': '', // name used instead
  person: 'Someone unrecognized',
  cat: 'A cat',
  other: 'Something else',
}

export function WhoMark({ identity, size = 38 }: { identity: Identity; size?: number }) {
  const label = identity.name ?? KIND_LABEL[identity.kind]
  const person = identity.kind === 'person' || identity.kind === 'named-person'
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 38 38"
      className="shrink-0"
    >
      {person ? (
        <circle cx="19" cy="19" r="15" fill={identity.colorVar} />
      ) : (
        <>
          <polygon points="7,14 13,3 17,14" fill={identity.colorVar} />
          <polygon points="21,14 25,3 31,14" fill={identity.colorVar} />
          <rect x="4" y="10" width="30" height="24" rx="10" fill={identity.colorVar} />
        </>
      )}
    </svg>
  )
}

/** The brand trio in a row — Login header, People page header. */
export function BrandMarkRow({ size = 28 }: { size?: number }) {
  return (
    <div className="flex -space-x-2" role="img" aria-label="Panther, Mushu and Coco">
      {BRAND_CATS.map((c) => (
        <WhoMark
          key={c.name}
          size={size}
          identity={{ kind: 'cat', name: c.name, colorVar: c.colorVar, softVar: '' }}
        />
      ))}
    </div>
  )
}
