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
 * cards, filter chips, timeline bands, empty states. People and cats
 * now use explicit line glyphs inside the identity-color badge instead
 * of abstract placeholder blobs. Anything else (dogs, cars, packages —
 * `kind === 'other'`) is a plain rounded square with NO ears, so an
 * un-eared silhouette doesn't lie and call itself a cat. Color comes
 * from the identity token, so the mark stays correct in both themes.
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
        <>
          <circle cx="19" cy="19" r="17" fill={identity.colorVar} />
          <circle cx="19" cy="14.5" r="5.25" fill="none" stroke="white" strokeWidth="2.6" />
          <path
            d="M9.5 29c1.8-6 5.3-9 9.5-9s7.7 3 9.5 9"
            fill="none"
            stroke="white"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
        </>
      ) : cat ? (
        <>
          <circle cx="19" cy="19" r="17" fill={identity.colorVar} />
          <path
            d="M10.5 14.5 12.5 8l5 4M27.5 14.5 25.5 8l-5 4"
            fill="none"
            stroke="white"
            strokeWidth="2.45"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10.5 20.5c0-5.1 3.8-8.5 8.5-8.5s8.5 3.4 8.5 8.5c0 5.4-3.5 8.5-8.5 8.5s-8.5-3.1-8.5-8.5Z"
            fill="none"
            stroke="white"
            strokeWidth="2.45"
            strokeLinejoin="round"
          />
          <circle cx="15.5" cy="20" r="1.35" fill="white" />
          <circle cx="22.5" cy="20" r="1.35" fill="white" />
          <path
            d="M19 22.1v2.8M15.5 25.2c1.3 1.3 2.5 1.3 3.5-.1 1 1.4 2.2 1.4 3.5.1"
            fill="none"
            stroke="white"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
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
