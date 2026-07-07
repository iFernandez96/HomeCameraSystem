# Playroom Modern — UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Design reference: the "Playroom Modern" direction (Direction 3) in the approved mockup artifact (2026-07-07). Mockups showed Watch/Home, Events, Review, Settings phone frames plus Login/Faces/danger-state notes.

**Goal:** Reskin + restructure every client screen into the Playroom Modern direction: a bright modernist-playroom visual world driven by a functional identity-color system (Panther slate, Mushu marmalade, Coco rose, people cobalt; named people get stable personal hues) where color encodes *who appeared* across event cards, filters, hour bands, and detection boxes.

**Architecture:** Keep the existing token architecture (names, dual-theme `data-theme` mechanism, `@theme` in `client/src/index.css`) and re-derive every VALUE for Playroom in both themes; add a new `--color-id-*` identity token group. Add two new pure units (`lib/identity.ts`, `components/WhoMark.tsx`) that every screen consumes. Then restructure screens one task each, migrating their sibling tests on touch. No server changes; no route changes; no changes to WebRTC/WS/visibility invariants.

**Tech Stack:** Vite + React 19 + TS + Tailwind v4 (CSS-var tokens), Vitest + Testing Library + jsdom.

## Global Constraints

- Work on a new branch `redesign/playroom-modern` off `main`. Commit atomically per task; NEVER push without explicit confirmation.
- Tailwind v4 arbitrary values MUST use `var()`: `bg-[var(--color-x)]`, never `bg-[--color-x]`.
- Token NAMES in `@theme` are load-bearing aliases — re-derive VALUES only; add new names, never rename/remove existing ones.
- Alert red (`--color-danger*`) is reserved for failure/offline/destructive. It must NEVER appear in the identity palette (design rule: red can't mean "Mushu walked by").
- Danger states must never be obscured by playfulness (camera offline, worker dead, low storage keep full-contrast treatment).
- Untouchable invariants (from CLAUDE.md "Don't reintroduce"): WHEP config + ICE gathering in `lib/webrtc.ts`; Watch's docked↔full CSS-state video container (the `<video>` must not remount); the three visibility-aware listeners (`useStatus.ts`, `Events.tsx`, `ConnectionBanner.tsx`); WS close-1008 no-retry; the two window auth signals; SPA middleware order; `CatLayer` dt clamp 33ms + no CSS `transition` on per-frame `transform` + `willChange: transform`.
- React 19 `react-hooks/set-state-in-effect`: no synchronous setState in `useEffect` bodies.
- New tests use BDD-lite naming (Given/When/Then) + `// arrange / act / assert` blocks; existing tests migrate on touch. Prefer `getByRole`/`getByLabelText`.
- All dev runs Jetson-OFF: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` in `client/`. Deploy only at the end via the `jetson-cross-deploy` skill when the Jetson is on.
- Copy rules: sentence case, plain household language, no emojis, no em-dashes in shipped copy.
- Data reality: events carry `label` (`person`/`cat`/`dog`/…) and `person_names` for recognized faces. Individual cats are NOT distinguishable at detection time. Identity colors therefore key on: recognized name → personal hue; unrecognized person → cobalt; `cat` → marmalade (the cats' collective hue); any other label → slate. The three cat hues (Panther/Mushu/Coco) remain the *brand* palette (Login, avatars, empty states, CatLayer), not per-event colors.

## File Structure

New files:

| File | Responsibility |
|---|---|
| `client/src/lib/identity.ts` | Pure subject→identity mapping: `identityOf(event)` → `{ kind, name?, colorVar, softVar }`; stable hue wheel for named people |
| `client/src/lib/identity.test.ts` | Unit tests for the mapping + wheel stability |
| `client/src/components/WhoMark.tsx` | The signature mark: rounded square + triangle ears (cats/brand) or circle (person), sized variants, a11y-labeled |
| `client/src/components/WhoMark.test.tsx` | Rendering + role/label tests |
| `client/src/components/HourBand.tsx` | "Today, hour by hour" 24-cell band colored by identity (replaces abstract heatmap on Events top; EventHeatmap stays for the 7-day view) |
| `client/src/components/HourBand.test.tsx` | Bucketing + color mapping tests |
| `client/public/fonts/bricolage-variable-latin.woff2` | Display face (self-hosted, replaces Fraunces) |

Modified (one task each unless noted): `client/src/index.css` (tokens light+dark, fonts, component classes), `client/index.html` (font preload, theme-color metas), `client/src/lib/theme.ts` (`THEME_BG`), `client/src/lib/drawBoxes.ts` (identity color param), `components/BottomNav.tsx`, `components/SideRail.tsx`, `components/primitives/Button.tsx`, `components/EventList.tsx`, `components/CatEmptyState.tsx`, `components/CatIcons.tsx`, `components/PawSpinner.tsx`, `components/CatLayer.tsx`, `pages/Watch.tsx`, `pages/Events.tsx`, `pages/Review.tsx`, `pages/Login.tsx`, `pages/People.tsx`, `pages/Training.tsx`, `pages/Settings.tsx` + `pages/settings/*`, `components/ClipModal.tsx`, `components/SnapshotPreview.tsx`, plus each file's sibling `.test.tsx`. Finally `CLAUDE.md` (theme section) and memory.

---

### Task 0: Branch + design tokens (both themes) + fonts

**Files:**
- Modify: `client/src/index.css` (the `@theme` block ~lines 49–243, the `:root[data-theme='dark']` block at ~line 264, `@font-face` at lines 21–39, `--font-display` at line 193)
- Modify: `client/index.html` (font preload lines 86–87, `meta name="theme-color"` pair)
- Modify: `client/src/lib/theme.ts:22-25` (`THEME_BG`)
- Create: `client/public/fonts/bricolage-variable-latin.woff2`

**Interfaces:**
- Produces: re-derived values for every existing `--color-*`, `--radius-*` token; NEW tokens `--color-id-panther`, `--color-id-mushu`, `--color-id-coco`, `--color-id-person`, `--color-id-wheel-1..6`, each with `-soft` pair and shared `--color-id-on`; `--font-display` = Bricolage Grotesque. All later tasks consume these by name.

- [ ] **Step 1: Branch**

```bash
git checkout -b redesign/playroom-modern main
```

- [ ] **Step 2: Fetch the display font**

```bash
cd client
curl -sL -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&display=swap" \
  | grep -o "https://[^)]*latin[^)]*woff2" | head -1 | xargs curl -sL -o public/fonts/bricolage-variable-latin.woff2
ls -la public/fonts/bricolage-variable-latin.woff2   # expect ~30-60 KB, non-zero
```

If offline, defer the file and keep the Fraunces `src` line temporarily; the `--font-display` stack change still lands (falls back to system sans below).

- [ ] **Step 3: Swap the display `@font-face` + stack**

In `client/src/index.css`, replace the Fraunces `@font-face` (lines 31–39) with:

```css
@font-face {
  font-family: 'Bricolage Grotesque';
  font-style: normal;
  font-weight: 400 800;
  font-display: swap;
  src: url('/fonts/bricolage-variable-latin.woff2') format('woff2-variations'),
       url('/fonts/bricolage-variable-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
```

And change line 193 to:

```css
--font-display: 'Bricolage Grotesque', 'Inter', -apple-system, sans-serif;
```

In `client/index.html` swap the Fraunces preload href to `/fonts/bricolage-variable-latin.woff2`. Grep for stragglers: `grep -rn "fraunces\|Fraunces" client/ --include="*.{ts,tsx,html,css}"` and update each hit (comments may stay).

- [ ] **Step 4: Re-derive light-theme token values**

In the `@theme` block, replace the Sunroom VALUES with Playroom values (names unchanged). Exact values:

```css
/* Playroom Modern (redesign/playroom-modern, 2026-07-07).
 * Bright modernist playroom. Structure over decoration: the identity
 * palette (--color-id-*) encodes WHO appeared and drives event cards,
 * filters, hour bands, and detection boxes. Alert red is excluded
 * from the identity palette by design. */

/* Brand accent (MARMALADE — the cats' collective hue, Mushu's coat) */
--color-accent-subtle:  #fceadd;
--color-accent-muted:   #f6d5bc;
--color-accent-default: #c25a12;  /* links, focus ring — 4.6:1 on surface */
--color-accent-bright:  #e5701f;
--color-accent-deep:    #8f3f0a;

/* Ink (primary-action fills; near-black warm) */
--color-ink:            #211f1b;
--color-ink-hover:      #38352e;
--color-on-ink:         #fffdf7;
--color-on-accent:      #ffffff;

/* Brass → warm stone secondary (nameplate, sigil) */
--color-brass-default:  #7d7258;
--color-brass-bright:   #9a8d6d;
--color-brass-subtle:   #efece2;
--color-brass-border:   color-mix(in srgb, var(--color-brass-default) 40%, transparent);

/* Surfaces (WALL + CARD) — cooler and brighter than Sunroom linen */
--color-bg:              #f3f1ea;
--color-surface:         #fffdf7;
--color-surface-raised:  #efece2;
--color-surface-overlay: #fffdf7;
--color-border-subtle:   #eae7dc;
--color-border:          #e2ded2;
--color-border-strong:   #b9b3a3;

/* Text */
--color-text-primary:    #211f1b;
--color-text-secondary:  #64604f;
--color-text-tertiary:   #7a756a;
--color-text-disabled:   #b5afa1;

/* Semantic — red/green/amber stay OUT of the identity palette */
--color-success:         #1e7d3f;
--color-warning:         #94660c;
--color-danger:          #c93222;
--color-danger-strong:   #dc2626;
--color-danger-muted:    #f6d9d4;
--color-info:            #64604f;

/* === NEW: identity palette (Playroom signature) ==================
 * Brand trio + person cobalt + a 6-hue wheel for NAMED people.
 * Every hue ≥4.5:1 as text on --color-surface; -soft is the 14%
 * card-tint; --color-id-on is the text color on a full id fill. */
--color-id-panther:      #34323a;
--color-id-mushu:        #c25a12;   /* shares the accent hue by design */
--color-id-coco:         #c04f70;
--color-id-person:       #2f5fe0;
--color-id-wheel-1:      #2f5fe0;   /* cobalt   */
--color-id-wheel-2:      #0f766e;   /* teal     */
--color-id-wheel-3:      #7c3aed;   /* violet   */
--color-id-wheel-4:      #be185d;   /* magenta  */
--color-id-wheel-5:      #15803d;   /* forest   */
--color-id-wheel-6:      #a16207;   /* ochre    */
--color-id-panther-soft: color-mix(in srgb, var(--color-id-panther) 14%, transparent);
--color-id-mushu-soft:   color-mix(in srgb, var(--color-id-mushu) 14%, transparent);
--color-id-coco-soft:    color-mix(in srgb, var(--color-id-coco) 14%, transparent);
--color-id-person-soft:  color-mix(in srgb, var(--color-id-person) 14%, transparent);
--color-id-wheel-1-soft: color-mix(in srgb, var(--color-id-wheel-1) 14%, transparent);
--color-id-wheel-2-soft: color-mix(in srgb, var(--color-id-wheel-2) 14%, transparent);
--color-id-wheel-3-soft: color-mix(in srgb, var(--color-id-wheel-3) 14%, transparent);
--color-id-wheel-4-soft: color-mix(in srgb, var(--color-id-wheel-4) 14%, transparent);
--color-id-wheel-5-soft: color-mix(in srgb, var(--color-id-wheel-5) 14%, transparent);
--color-id-wheel-6-soft: color-mix(in srgb, var(--color-id-wheel-6) 14%, transparent);
--color-id-on:           #ffffff;
```

Keep the pre-mixed `--color-*-bg/-border` color-mix group and `--color-surface-scrim` exactly as-is (they derive from the tokens above). In the `--radius-*` group (~line 160-192), set: card radius 18px, control/pill radius 999px, tile (video card) radius 26px, keeping existing token names — read the current names in-file and map by comment (`card`→18, `control`/`button`→999, largest→26). Do the same restraint for `--shadow-*`: one soft drop `0 14px 34px -16px rgb(33 31 27 / 0.35)` for the video card token, hairline defaults elsewhere.

- [ ] **Step 5: Re-derive the dark theme**

In `:root[data-theme='dark']` (line ~264) replace values with the "playroom after dark" set — warm charcoal, identity hues brightened one step, ink INVERTED (keep the Sunroom inversion mechanism: dark ink fill becomes light, `--color-on-ink` flips):

```css
--color-bg:              #232019;
--color-surface:         #2c2820;
--color-surface-raised:  #37322a;
--color-surface-overlay: #2c2820;
--color-border-subtle:   #3a352b;
--color-border:          #453f33;
--color-border-strong:   #6a624f;
--color-text-primary:    #f1ede2;
--color-text-secondary:  #b5ad9c;
--color-text-tertiary:   #948c7a;
--color-text-disabled:   #6a624f;
--color-ink:             #f1ede2;
--color-ink-hover:       #ffffff;
--color-on-ink:          #232019;
--color-accent-subtle:   #3a2c1e;
--color-accent-muted:    #4d3826;
--color-accent-default:  #f08536;
--color-accent-bright:   #ff9a4d;
--color-accent-deep:     #c25a12;
--color-on-accent:       #231a10;
--color-brass-default:   #a89a78;
--color-brass-bright:    #c4b48c;
--color-brass-subtle:    #37322a;
--color-success:         #4ade80;
--color-warning:         #fbbf24;
--color-danger:          #f87171;
--color-danger-strong:   #dc2626;
--color-danger-muted:    #4d2320;
--color-info:            #b5ad9c;
--color-id-panther:      #8f8ba0;
--color-id-mushu:        #f08536;
--color-id-coco:         #e8859e;
--color-id-person:       #6c8ff0;
--color-id-wheel-1:      #6c8ff0;
--color-id-wheel-2:      #2dd4bf;
--color-id-wheel-3:      #a78bfa;
--color-id-wheel-4:      #f472b6;
--color-id-wheel-5:      #4ade80;
--color-id-wheel-6:      #eab308;
--color-id-on:           #1c1913;
```

(The `-soft` color-mix tokens recompute automatically from the redefined bases — verify they are defined via `var()` refs in `@theme`; if the dark block previously re-declared any pre-mixed token, re-declare the `-soft` group there the same way.)

- [ ] **Step 6: Sync the boot constants**

`client/src/lib/theme.ts:22-25`:

```ts
const THEME_BG: Record<ResolvedTheme, string> = {
  light: '#f3f1ea',
  dark: '#232019',
}
```

Update the matching `meta name="theme-color"` values and the inline pre-paint script constants in `client/index.html` to the same two hexes. `lib/theme.test.ts` pins these — update the expected hexes there.

- [ ] **Step 7: Verify**

```bash
cd client && npm run typecheck && npm test -- --run src/lib/theme.test.ts && npm run build
```

Expected: green. The app now renders every screen on Playroom values with zero className churn (token names unchanged).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(theme): playroom modern token set, both themes + bricolage display face"
```

---

### Task 1: `lib/identity.ts` — the subject→color mapping (pure, TDD)

**Files:**
- Create: `client/src/lib/identity.ts`
- Create: `client/src/lib/identity.test.ts`

**Interfaces:**
- Consumes: `DetectionEvent` from `lib/types.ts`, `recognizedNames()` from `lib/eventLabel.ts`.
- Produces (all later tasks import these):

```ts
export type IdentityKind = 'named-person' | 'person' | 'cat' | 'other'
export interface Identity {
  kind: IdentityKind
  name: string | null          // recognized name, else null
  colorVar: string             // e.g. 'var(--color-id-person)'
  softVar: string              // e.g. 'var(--color-id-person-soft)'
}
export function identityOf(e: Pick<DetectionEvent, 'label' | 'person_name' | 'person_names'>): Identity
export function identityForName(name: string): Identity   // wheel hue, stable per name
export const BRAND_CATS: ReadonlyArray<{ name: 'Panther' | 'Mushu' | 'Coco'; colorVar: string }>
```

- [ ] **Step 1: Write the failing tests** (`client/src/lib/identity.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { identityOf, identityForName } from './identity'

describe('identityOf', () => {
  it('GIVEN a cat event WHEN mapped THEN kind cat with the marmalade hue', () => {
    // arrange
    const e = { label: 'cat', person_name: null, person_names: null }
    // act
    const id = identityOf(e)
    // assert
    expect(id.kind).toBe('cat')
    expect(id.colorVar).toBe('var(--color-id-mushu)')
    expect(id.softVar).toBe('var(--color-id-mushu-soft)')
  })

  it('GIVEN an unrecognized person WHEN mapped THEN kind person with cobalt', () => {
    // arrange
    const e = { label: 'person', person_name: null, person_names: null }
    // act
    const id = identityOf(e)
    // assert
    expect(id.kind).toBe('person')
    expect(id.name).toBeNull()
    expect(id.colorVar).toBe('var(--color-id-person)')
  })

  it('GIVEN a recognized person WHEN mapped THEN named-person with a stable wheel hue', () => {
    // arrange
    const e = { label: 'person', person_name: 'israel', person_names: ['israel'] }
    // act
    const a = identityOf(e)
    const b = identityOf(e)
    // assert
    expect(a.kind).toBe('named-person')
    expect(a.name).toBe('israel')
    expect(a.colorVar).toMatch(/^var\(--color-id-wheel-[1-6]\)$/)
    expect(b.colorVar).toBe(a.colorVar) // deterministic
  })

  it('GIVEN two different names WHEN adjacent in the wheel THEN they usually differ (hash spread)', () => {
    // arrange / act
    const hues = ['israel', 'sheenal', 'ana', 'mateo'].map((n) => identityForName(n).colorVar)
    // assert — at least 2 distinct hues across 4 names (hash isn't degenerate)
    expect(new Set(hues).size).toBeGreaterThanOrEqual(2)
  })

  it('GIVEN a dog event WHEN mapped THEN kind other with panther slate', () => {
    // arrange
    const e = { label: 'dog', person_name: null, person_names: null }
    // act / assert
    expect(identityOf(e).colorVar).toBe('var(--color-id-panther)')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd client && npm test -- --run src/lib/identity.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`client/src/lib/identity.ts`)

```ts
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
```

- [ ] **Step 4: Run to verify pass** — same command, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.ts src/lib/identity.test.ts
git commit -m "feat(client): identity color mapping for the playroom system"
```

---

### Task 2: `WhoMark` — the signature mark (TDD)

**Files:**
- Create: `client/src/components/WhoMark.tsx`, `client/src/components/WhoMark.test.tsx`

**Interfaces:**
- Consumes: `Identity` from `lib/identity.ts`.
- Produces: `<WhoMark identity={id} size={38} />` — an inline-SVG mark: rounded square + two triangle ears for `cat`/`other`/brand use; plain circle for `person`/`named-person`. `role="img"` with `aria-label` = `identity.name ?? ({cat: 'A cat', person: 'Someone unrecognized', other: 'Something else'})[kind]`. Also exports `<BrandMarkRow />` (the three cat marks, used by Login/headers).

- [ ] **Step 1: Failing tests** (`client/src/components/WhoMark.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { identityOf, identityForName } from '../lib/identity'
import { WhoMark } from './WhoMark'

describe('WhoMark', () => {
  it('GIVEN a cat identity WHEN rendered THEN an eared img labeled as a cat', () => {
    // arrange / act
    render(<WhoMark identity={identityOf({ label: 'cat', person_name: null, person_names: null })} />)
    // assert
    const img = screen.getByRole('img', { name: 'A cat' })
    expect(img.querySelectorAll('polygon')).toHaveLength(2) // the ears
  })

  it('GIVEN a named person WHEN rendered THEN a circle labeled with the name and no ears', () => {
    // arrange / act
    render(<WhoMark identity={identityForName('Israel')} />)
    // assert
    const img = screen.getByRole('img', { name: 'Israel' })
    expect(img.querySelectorAll('polygon')).toHaveLength(0)
    expect(img.querySelector('circle')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (`npm test -- --run src/components/WhoMark.test.tsx`).

- [ ] **Step 3: Implement** (`client/src/components/WhoMark.tsx`)

```tsx
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
```

- [ ] **Step 4: Run, expect PASS.** (Note: the brand row renders three eared marks with names — the outer `role="img"` label covers a11y; inner marks are decorative but named, acceptable.)

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(client): WhoMark identity mark + brand trio row"`

---

### Task 3: Primitive restyle — Button, toggles, chips, cards (component CSS layer)

**Files:**
- Modify: `client/src/components/primitives/Button.tsx` (+ its test), `client/src/index.css` (component classes: `.card-paper` line ~371, `.focus-ring` ~351, `.page-title` ~538)

**Interfaces:**
- Produces: the Playroom control language every screen task below uses verbatim:
  - Primary button: `rounded-full bg-[var(--color-ink)] text-[var(--color-on-ink)] font-bold` (pill, ink fill)
  - Secondary: `rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] font-bold`
  - Danger: `rounded-full border-[1.5px] border-[var(--color-danger)] text-[var(--color-danger)]`
  - Card: `.card-paper` → `border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-card)] bg-[var(--color-surface)]`, soft shadow only on the video tile
  - Chip (selected): ink fill / (idle): surface + 1.5px border — mirrors the mockup's `wchip`

- [ ] **Step 1:** Update `Button.tsx` variants to the classes above (read the file first; keep the ripple wiring from `lib/ripple.ts` and the 44px min target). Update `Button.test.tsx` class/style pins.
- [ ] **Step 2:** Update `.card-paper`, `.page-title` (now Bricolage 800, `letter-spacing:-0.03em`), and `.focus-ring` (2px `var(--color-accent-default)` offset ring) in `index.css`.
- [ ] **Step 3:** `npm test -- --run src/components/primitives && npm run lint` — green.
- [ ] **Step 4: Commit** — `feat(ui): playroom control language — pill buttons, 1.5px card grammar`

---

### Task 4: Navigation — pebble BottomNav + SideRail parity

**Files:**
- Modify: `client/src/components/BottomNav.tsx` + `BottomNav.test.tsx`, `client/src/components/SideRail.tsx`, `client/src/index.css` (`.bottomnav-paw-active` ~line 652, `.paw-active` ~line 633)

**Interfaces:**
- Consumes: existing routes (do not change paths). Final labels: **Home** (`/`), **Events**, **Review**, **Faces** (the People route), **Settings**.
- Produces: the floating pill bar ("pebbles"): container `mx-3.5 mb-3.5 rounded-full border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface-scrim)] backdrop-blur px-2.5 py-2 shadow-[0_10px_24px_-14px_rgb(33_31_27/0.35)]` respecting `env(safe-area-inset-bottom)`; active item = ink-filled pill (`rounded-full bg-[var(--color-ink)] text-[var(--color-on-ink)]`), replacing the paw-mask active treatment on mobile. SideRail keeps the same active grammar vertically; the brand nameplate at its top becomes `<BrandMarkRow />`.

- [ ] **Step 1:** Restyle `BottomNav.tsx`: floating container (absolute-positioned above content is NOT needed — keep it in flow as today, only the visual chrome changes), swap label "People"→"Faces" and "Watch"→"Home" if those labels render (read current labels first; routes unchanged).
- [ ] **Step 2:** Delete usage of `.bottomnav-paw-active` in the component; leave the CSS class in place (CatLayer-era rules removed in Task 10 cleanup).
- [ ] **Step 3:** Update `BottomNav.test.tsx` label pins (`getByRole('link', { name: 'Home' })` etc.), migrate touched tests to BDD-lite naming. Check `App.tsx` and any `aria-current` logic still passes.
- [ ] **Step 4:** Same active-grammar pass on `SideRail.tsx` (desktop). Run `npm test -- --run src/components/BottomNav.test.tsx && npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(nav): pebble bar + Home/Faces labels, ink active pill`

---

### Task 5: Watch → "Home" (glance cards + story with WhoMarks)

**Files:**
- Modify: `client/src/pages/Watch.tsx` (590 lines) + `Watch.test.tsx`, `client/src/components/VideoTile.tsx` (chrome only), `client/src/components/LiveStats.tsx`

**Interfaces:**
- Consumes: `identityOf`, `WhoMark`, control language from Task 3. MUST NOT touch: the docked↔full CSS-state container (video never remounts), WHEP retry semantics, `useStatus` polling.
- Produces: the mockup's Home structure.

- [ ] **Step 1:** Page header: `<h1>` "Home" in `.page-title`, right-aligned `<BrandMarkRow size={28} />`.
- [ ] **Step 2:** Video card chrome: wrap the existing docked video container with `rounded-[26px] overflow-hidden shadow-[...]` per Task 3 tile grammar; keep the expand behavior class-toggle intact. Live pill (`bg-[var(--color-surface-scrim)] rounded-full`, red dot = `--color-danger` — recording-red is semantically alarm-adjacent and allowed on the live badge) and camera-name pill (`bg-black/70 text-white rounded-full`) as overlays. Verify against `Watch.tsx` header comment invariants before editing.
- [ ] **Step 3:** Glance row — two cards under the video, exactly:

```tsx
<div className="mx-4 mt-3.5 flex gap-2.5">
  <div className="flex-1 rounded-[var(--radius-card)] bg-[var(--color-ink)] px-3 py-2.5 text-[var(--color-on-ink)]">
    <p className="text-[17px] font-extrabold tracking-tight">{watching ? 'Watching' : 'Paused'}</p>
    <p className="text-[10.5px] font-semibold opacity-70">{watchingDetail}</p>
  </div>
  <div className="flex-1 rounded-[var(--radius-card)] border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
    <p className="text-[17px] font-extrabold tracking-tight">{todayCount} today</p>
    <p className="text-[10.5px] font-semibold text-[var(--color-text-secondary)]">{todayBreakdown}</p>
  </div>
</div>
```

where `watchingDetail` reuses the existing sentry-cat line ("Mushu is on sentry · detection active") and `todayBreakdown` = `"{persons} person · {cats} cat sightings"` computed from the already-fetched today events. Degraded gears (low-memory/thermal) and camera-offline keep their existing full-contrast danger treatment INSIDE the armed card (swap ink fill for `--color-danger-bg` + danger text when unhealthy).
- [ ] **Step 4:** "Today's story" list: heading `Today at home`; each event row = Task 3 card grammar with `<WhoMark identity={identityOf(e)} />` on the left, `eventTitle(e)` bold, duration/sub second line, `clockTime` right in tabular-nums. Quiet-gap rows keep plain words, no mark.
- [ ] **Step 5:** Update `Watch.test.tsx`: heading pins ("Home", "Today at home"), glance-card copy, keep all behavioral tests (expand, retry, snapshot) untouched. Run `npm test -- --run src/pages/Watch.test.tsx`.
- [ ] **Step 6: Commit** — `feat(watch): playroom home — glance cards + identity story`

---

### Task 6: HourBand component (TDD) + Events restyle (who-chips, identity cards)

**Files:**
- Create: `client/src/components/HourBand.tsx`, `client/src/components/HourBand.test.tsx`
- Modify: `client/src/pages/Events.tsx` (1641 lines) + `Events.test.tsx`, `client/src/components/EventList.tsx` + test, `client/src/components/EventHeatmap.tsx` (palette only)

**Interfaces:**
- Consumes: `identityOf`, `WhoMark`; existing search/filter/pagination logic in `Events.tsx` (cursor semantics untouched).
- Produces: `<HourBand events={DetectionEvent[]} dayStartTs={number} />` — 24 cells, each colored by the identity of the FIRST event in that hour (person outranks cat when both occur: `named-person`/`person` wins the cell), empty cells `bg-[var(--color-surface-raised)]`. `role="img"` + `aria-label` "Today hour by hour: N quiet hours, M with activity".

- [ ] **Step 1: Failing tests** (`HourBand.test.tsx`)

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HourBand } from './HourBand'

const day = new Date(2026, 6, 7).getTime() / 1000
const ev = (h: number, label: string, name?: string) => ({
  id: `${h}-${label}`, ts: day + h * 3600 + 60, label,
  person_name: name ?? null, person_names: name ? [name] : null,
}) as any

describe('HourBand', () => {
  it('GIVEN events in two hours WHEN rendered THEN 24 cells with those hours colored', () => {
    // arrange / act
    render(<HourBand events={[ev(8, 'cat'), ev(20, 'person')]} dayStartTs={day} />)
    // assert
    const band = screen.getByRole('img', { name: /hour by hour/i })
    const cells = band.querySelectorAll('[data-hour]')
    expect(cells).toHaveLength(24)
    expect((cells[8] as HTMLElement).style.background).toContain('--color-id-mushu')
    expect((cells[20] as HTMLElement).style.background).toContain('--color-id-person')
  })

  it('GIVEN a person and a cat in the same hour WHEN rendered THEN the person wins the cell', () => {
    // arrange / act
    render(<HourBand events={[ev(9, 'cat'), ev(9, 'person')]} dayStartTs={day} />)
    // assert
    const cell = screen.getByRole('img', { name: /hour by hour/i }).querySelectorAll('[data-hour]')[9]
    expect((cell as HTMLElement).style.background).toContain('--color-id-person')
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — bucket `Math.floor((e.ts - dayStartTs) / 3600)` into 0..23, rank `named-person|person > cat > other`, render `<div role="img" aria-label=...><div className="grid grid-cols-[repeat(24,1fr)] gap-[3px]">{cells}</div></div>` with each cell `data-hour={h} className="h-6 rounded-[5px]" style={{ background: colorVar or 'var(--color-surface-raised)' }}`.
- [ ] **Step 4: Run, expect PASS. Commit** — `feat(client): HourBand identity timeline`
- [ ] **Step 5: Events page restyle** (separate commit, same task):
  - Filter row → who-chips: `Everyone` / `People` (person filter) / `Cats` (cat label filter) / `Unrecognized` — mapped 1:1 onto the EXISTING filter state (read the current chip handlers; only chrome + labels change). Chips carry a 12px color square (`--color-id-person` / `--color-id-mushu`) per the mockup; selected = ink fill.
  - Mount `<HourBand>` in a Task 3 card titled "Today, hour by hour" above the list (today's events already in state; else fetch reuse). Keep `EventHeatmap` (7-day) below/behind its existing toggle, repaletted: tiers from `--color-accent-subtle`→`--color-accent-deep`.
  - `EventList.tsx` rows: `WhoMark` left, same grammar as Watch story rows. Keep selection/delete/bulk logic untouched.
  - Update copy pins in `Events.test.tsx` + `EventList.test.tsx` (cat-themed copy pins WILL break — update to new copy; keep behavioral assertions).
- [ ] **Step 6:** `npm test -- --run src/pages/Events.test.tsx src/components/EventList.test.tsx src/components/HourBand.test.tsx` — green. **Commit** — `feat(events): who-chips + hour band + identity cards`

---

### Task 7: Review + ClipModal — identity-colored detection boxes

**Files:**
- Modify: `client/src/lib/drawBoxes.ts` + its consumers, `client/src/pages/Review.tsx` (326 lines) + test, `client/src/components/ClipModal.tsx` + test, `client/src/components/SnapshotPreview.tsx`

**Interfaces:**
- Consumes: `identityOf`. `drawBoxes.ts` is shared by the live tile + clip modal — one change, both surfaces.
- Produces: `drawBoxes(ctx, boxes, opts)` gains `opts.color?: string` (a RESOLVED rgb/hex string — canvas can't resolve `var()`; resolve via `getComputedStyle(document.documentElement).getPropertyValue('--color-id-…')` at call site, falling back to the current hardcoded color). Callers pass the event's identity color; label chip text uses "Someone · 92%" for unrecognized persons.

- [ ] **Step 1:** Read `drawBoxes.ts`; add the `color` option with the current color as default (non-breaking). Extend `drawBoxes`'s existing test file if present, else add `lib/drawBoxes.test.ts` with a canvas-mock assertion that `strokeStyle` receives the passed color (BDD-lite).
- [ ] **Step 2:** `ClipModal.tsx` + `Review.tsx`: resolve the event's identity token to a concrete color once per event (`resolveIdColor(identity)` helper inside `drawBoxes.ts`, reading computed style with a `#2f5fe0` fallback for jsdom) and pass it through. Restyle action row to pill grammar: `Play` (primary ink), `Save`, `Name them` (persons only — navigates to the existing name/training flow), `Delete` (danger outline).
- [ ] **Step 3:** "More from tonight" section on Review: reuse the Watch story row component for ±2h events (extract that row into `components/EventRow.tsx` NOW if Watch and Review would otherwise duplicate it; single shared component, both pages import it).
- [ ] **Step 4:** Update the touched tests; run `npm test -- --run src/pages/Review.test.tsx src/components/ClipModal.test.tsx`. **Commit** — `feat(review): identity-colored boxes + pill actions`

---

### Task 8: Settings — rounded rows + plain-language sublabels

**Files:**
- Modify: `client/src/pages/Settings.tsx` (356) + `Settings.test.tsx` (2260), `client/src/pages/settings/*.tsx` (all 9 sections + `parts.tsx`)

**Interfaces:**
- Consumes: Task 3 grammar. All handlers, API calls, RBAC `isOwner` carve-out, and section logic UNCHANGED — this is chrome + copy only.
- Produces: each row = Task 3 card grammar (`rounded-[var(--radius-card)] border-[1.5px] …`), toggle = the knob (`w-11 h-[26px] rounded-full`, ink track when on), section eyebrows uppercase `text-[var(--color-text-secondary)]`.

- [ ] **Step 1:** Restyle `parts.tsx` shared row/toggle primitives first (most sections inherit it), then sweep each section file for leftover raw classes.
- [ ] **Step 2:** Copy pass (exact strings): section heads `Watching` (Detection), `Alerts` (Notifications), `Appearance`, `Timelapses` → row sublabel "Stitch a day's clips into one video", Jetson section head `The box in the closet` with row `Jetson health` sublabel "{temp}°C · worker {alive|down} · {pct}% storage". Danger zone keeps its name and full danger treatment.
- [ ] **Step 3:** `Settings.test.tsx` is 2260 lines of pins — update ONLY broken copy/class pins; behavioral assertions stay. Run `npm test -- --run src/pages/Settings.test.tsx`. **Commit** — `feat(settings): playroom rows + plain-language copy`

---

### Task 9: Login + People/Training → "Faces"

**Files:**
- Modify: `client/src/pages/Login.tsx` (357) + test, `client/src/pages/People.tsx` (524) + test, `client/src/pages/Training.tsx` (1025) + test

**Interfaces:**
- Consumes: `BrandMarkRow`, `WhoMark`, `identityForName`.
- Produces: Login = wall ground, `BrandMarkRow size={44}` above the title, staggered mark entrance (CSS `animation-delay` 0/90/180ms on a 300ms ease-out rise; wrapped in `@media (prefers-reduced-motion: no-preference)`), one big rounded input bar + ink pill submit. People = "Faces": each known person's card gets `<WhoMark identity={identityForName(name)} />` and their wheel hue as the card's left identity; the header explains the system in one line: "Everyone the camera knows gets their own color." Training keeps its flow, restyled with Task 3 grammar only.

- [ ] **Step 1:** Login restructure (auth flow, error handling, `homecam:*` signals untouched). Update `Login.test.tsx` pins.
- [ ] **Step 2:** People/Faces + Training chrome pass; page `<h1>` "Faces"; update route-label consistency with Task 4 nav. Update tests.
- [ ] **Step 3:** `npm test -- --run src/pages/Login.test.tsx src/pages/People.test.tsx src/pages/Training.test.tsx`. **Commit** — `feat(faces): brand-mark login + identity roster`

---

### Task 10: Brand layer — CatEmptyState, CatIcons, PawSpinner, CatLayer, toasts/banners

**Files:**
- Modify: `client/src/components/CatEmptyState.tsx` + test, `CatIcons.tsx` + test, `PawSpinner.tsx`, `CatLayer.tsx` + test, `client/src/index.css` (`.paw-active`, `.bottomnav-paw-active`, `.paw-spinner-dot`, `.sentry-sparkle`), `lib/toast.tsx`, `components/ConnectionBanner.tsx`, `components/Skeleton.tsx`

**Interfaces:**
- Produces: cat visuals redrawn geometric (WhoMark language: rounded rect + triangle ears) in the brand trio hues. `CatEmptyState` keeps its API and remains the only empty-state primitive. `CatLayer` sprites recolored/reshaped ONLY — the animation loop (dt clamp 33ms, no transition on transform, `willChange`) untouched. PawSpinner becomes three bouncing WhoMark dots in the trio hues (respect reduced-motion). Toasts: success/danger fills keep `text-white`-on-semantic (allowed exception); chrome moves to pill grammar. Remove now-unused `.paw-active`/`.bottomnav-paw-active` CSS after grepping for zero usages.

- [ ] **Step 1:** Redraw `CatIcons.tsx` primitives; snapshot-ish tests updated to role/label assertions.
- [ ] **Step 2:** `CatEmptyState` copy stays cat-voiced but Playroom-toned; update pinned copy in its test + any page tests that pin empty-state text (`grep -rn "CatEmptyState" src/pages/*.test.tsx`).
- [ ] **Step 3:** CatLayer sprite swap; run its test to prove the loop untouched. `npm test -- --run src/components` full component sweep. **Commit** — `feat(brand): geometric cat layer, spinner, empty states`

---

### Task 11: Full-suite verification + visual pass + docs

**Files:**
- Modify: `CLAUDE.md` (Theme bullet under "### Theme"), memory files

- [ ] **Step 1: Full local gates**

```bash
cd client && npm run typecheck && npm run lint && npm test -- --run && npm run build
```

Expected: all green, bundle builds. Fix any missed copy pins (the suite names them precisely).

- [ ] **Step 2: Visual smoke** — `npm run dev`, walk all 7 routes in both themes (toggle in Settings → Appearance) at 390px and desktop width. Screenshot each; check: identity colors legible in dark theme, danger states unmistakable, focus rings visible, no horizontal scroll.
- [ ] **Step 3: Critique gate** — dispatch the Maya polish critic (`mobile-brutal-polish-critic`) + `mobile-view-auditor` + `mobile-accessibility-auditor` in parallel on the branch; triage findings; fix accepts before merge.
- [ ] **Step 4: Docs** — update CLAUDE.md "### Theme" bullets: replace "Light calico theme is baseline" with the Playroom description (identity-token rule: alert red never in the identity palette; `--color-id-*` group; Bricolage display). Update the Sunroom memory file (`sunroom_redesign_2026_07.md`) to point at the new state; add a `playroom_modern_2026_07.md` memory.
- [ ] **Step 5: Commit** — `docs: playroom modern theme notes` — then STOP. Merge to `main` and deploy (client `rsync` via `jetson-cross-deploy` skill) only after Israel reviews the branch; never push without confirmation.

---

## Self-Review Notes

- **Coverage vs the approved design:** tokens/dual-theme (T0), identity system (T1), WhoMark (T2), control language (T3), pebble nav (T4), Home glance+story (T5), who-chips/hour-band/events (T6), identity bboxes + review (T7), settings (T8), login+faces (T9), brand layer (T10), verify+docs (T11). The mockup's "name them adds a hue app-wide" is delivered by `identityForName` being deterministic — naming a person in the existing flow immediately colors their events; no new server work.
- **Known adaptation from mockup:** per-cat colors on event cards are impossible with current detection (label is just `cat`); cats share marmalade. The trio hues live in brand surfaces. If per-cat identity ever ships worker-side, `identityOf` is the single extension point.
- **Test-pin blast radius:** Events/EventList/Settings/Login/BottomNav tests pin copy and will fail loudly per task — each task budgets its own pin migration; nothing is deferred to the end except stragglers T11 catches.
- **Type consistency check:** `Identity`/`identityOf`/`identityForName`/`BRAND_CATS` (T1) match usages in T2/T5/T6/T7/T9; `WhoMark({ identity, size })` consistent across T5/T6/T9/T10; `HourBand({ events, dayStartTs })` used only in T6. `EventRow` extraction is defined in T7 step 3 as the shared unit for T5/T7 — if T5 lands first with an inline row, T7 extracts it.
