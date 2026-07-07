import type { Identity } from '../lib/identity'
import { BRAND_CATS } from '../lib/identity'

// Landscape-pass Task 3: the brand trio previously drew the same
// geometric eared-square glyph as event-identity marks (WhoMark
// below) — flat and placeholder-looking now that real cat photography
// exists. `public/cats/{cat}-face.png` are the same assets CatTrioMark
// (components/CatIcons.tsx) already uses for the WatchRibbon wordmark;
// this map + idiom mirrors that file's `FACE_SRC`/`FaceImg` pattern.
// Only the BRAND identity (Home header, Login, People header) swaps to
// real art — per-event identity marks (person circles / cat glyph)
// keep the geometric `WhoMark` below, since those must render an
// arbitrary/unknown subject, not one of the three named house cats.
const BRAND_FACE_SRC: Record<string, string> = {
  Panther: '/cats/panther-face.png',
  Mushu: '/cats/mushu-face.png',
  Coco: '/cats/coco-face.png',
}

/**
 * The Playroom signature mark. One shape everywhere: avatar on event
 * cards, filter chips, timeline bands, empty states. People are a
 * circle; cats are a rounded square with two triangle ears; anything
 * else (dogs, cars, packages — `kind === 'other'`) is a plain rounded
 * square with NO ears, so an un-eared silhouette doesn't lie and call
 * itself a cat. Color comes from the identity token, so the mark
 * stays correct in both themes.
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
  const cat = identity.kind === 'cat'
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
      ) : cat ? (
        <>
          <polygon points="7,14 13,3 17,14" fill={identity.colorVar} />
          <polygon points="21,14 25,3 31,14" fill={identity.colorVar} />
          <rect x="4" y="10" width="30" height="24" rx="10" fill={identity.colorVar} />
        </>
      ) : (
        <rect x="4" y="4" width="30" height="30" rx="10" fill={identity.colorVar} />
      )}
    </svg>
  )
}

/** The brand trio in a row — Home header, Login, People page header. */
export function BrandMarkRow({ size = 28 }: { size?: number }) {
  return (
    <div className="flex -space-x-2" role="img" aria-label="Panther, Mushu and Coco">
      {BRAND_CATS.map((c) => (
        <img
          key={c.name}
          src={BRAND_FACE_SRC[c.name]}
          alt=""
          width={size}
          height={size}
          decoding="async"
          // Above-the-fold on the Login hero + Watch header — eager +
          // fetchpriority matches CatTrioMark's contract for the same
          // asset set (CatIcons.tsx).
          loading="eager"
          fetchPriority="high"
          className="shrink-0 rounded-full ring-2 bg-[var(--color-surface)]"
          style={{
            objectFit: 'cover',
            ['--tw-ring-color' as string]: c.colorVar,
          }}
        />
      ))}
    </div>
  )
}
