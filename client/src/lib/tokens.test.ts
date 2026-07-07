// iter-356.65 (mobile slice A): pin the design-token contrast floor
// so a future drive-by `--color-text-secondary` tweak can't silently
// regress AA on the metadata rows. The slice A bump (#b09070 →
// #c4a482) was driven by Aiko's mobile visual brief; the test
// computes the WCAG 2.1 relative-luminance contrast ratio between
// the secondary text token and the surface bg and asserts ≥ 5:1.
//
// Why a hand-rolled helper instead of a dep: the brief explicitly
// bans new client deps for slice A. The 8-line formula here is
// self-contained and matches the standard WCAG implementation.
import { describe, it, expect } from 'vitest'
// `@types/node` is now an installed devDependency (added when the
// crypto.hash polyfill landed in vite.config.ts) so node:* imports
// type-check natively. The previous `createRequire` + ts-expect-
// error workaround is no longer needed.
import { createRequire } from 'module'
const req = createRequire(import.meta.url)
const fs = req('node:fs') as { readFileSync(p: string, enc: string): string }
const path = req('node:path') as { resolve(...p: string[]): string; dirname(p: string): string }
const url = req('node:url') as { fileURLToPath(u: string): string }

// Vitest is configured with `css: false` (see vite.config.ts) which
// strips a plain `import '../index.css?raw'` to an empty string. We
// sidestep the bundler entirely and read off disk — vitest runs on
// Node, so node:fs is available even under jsdom env.
const indexCss = fs.readFileSync(
  path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../index.css'),
  'utf8',
)

function readToken(name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`)
  const m = indexCss.match(re)
  if (!m) throw new Error(`token ${name} not found in index.css`)
  return m[1]
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('design-system contrast pins (iter-356.65 slice A)', () => {
  it('Given the stone secondary and paper surface, When contrast is computed, Then it clears AA at ~5:1', () => {
    // arrange — redesign/playroom-modern (2026-07-07): pins retuned for
    // the Playroom Modern light palette (#64604f on #fffdf7 ≈ 6.2:1).
    const secondary = readToken('--color-text-secondary')
    const surface = readToken('--color-surface')

    // act
    const ratio = contrast(secondary, surface)

    // assert
    expect(secondary.toLowerCase()).toBe('#64604f')
    expect(surface.toLowerCase()).toBe('#fffdf7')
    expect(ratio).toBeGreaterThanOrEqual(5)
  })

  it('Given the ink primary and linen bg, When contrast is computed, Then it clears AAA at 7:1', () => {
    // arrange — sanity pin so a primary-text drift is also caught
    const primary = readToken('--color-text-primary')
    const bg = readToken('--color-bg')

    // act
    const ratio = contrast(primary, bg)

    // assert
    expect(ratio).toBeGreaterThanOrEqual(7)
  })

  it('Given the typography scale, When mobile floors are read, Then --text-base is 16px and --text-sm is 14px', () => {
    // arrange — the iOS-zoom-suppression floor lives in the token,
    // not per-input. Pin it so a future drift can't sneak inputs
    // back below 16px.
    const baseRe = /--text-base:\s*16px/
    const smRe = /--text-sm:\s*14px/

    // act / assert
    expect(indexCss).toMatch(baseRe)
    expect(indexCss).toMatch(smRe)
  })
})
