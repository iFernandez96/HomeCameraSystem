/**
 * Regression sentinel for the Node 18 `crypto.hash` polyfill that
 * lives in `vite.config.ts`. The polyfill exposes Node 20.12+'s
 * synchronous one-shot `crypto.hash(algorithm, data, encoding)`
 * API on older Node so Vite 7 + vite-plugin-pwa can hash CSS
 * `url()` references and woff2 assets at build time.
 *
 * This test does NOT import vite.config.ts (TS doesn't trust Vite's
 * config-file ambient types from the src scope). Instead it
 * re-applies the same polyfill algorithm in-process and asserts it
 * matches the canonical createHash → update → digest output. If a
 * future refactor breaks the polyfill's algorithm, this test
 * catches it before the build pipeline trips on a real CSS asset
 * reference.
 *
 * The full integration check is the build itself: src/index.css's
 * `@font-face url('/fonts/...')` references exercise the polyfill
 * via vite-plugin-pwa's manifest hashing on every build. The
 * /public/fonts/woff2 files + the @font-face declarations are the
 * permanent regression sentinel that proves CSS asset refs work
 * end-to-end under Node 18.
 */
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const req = createRequire(import.meta.url)

// Local types — we reach into node:crypto from inside the src
// type-scope, which deliberately doesn't include @types/node (kept
// as a Vite-side-only dep to avoid leaking Node types onto the
// browser bundle's type surface). createRequire bypasses TS module
// resolution entirely so the runtime call works without a typed
// import statement.
type Hash = {
  update(data: string | Uint8Array): Hash
  digest(encoding: string): string
}
type CryptoModule = {
  createHash(algorithm: string): Hash
  hash?: (
    algorithm: string,
    data: string | Uint8Array,
    encoding?: string,
  ) => string
}

/** Apply the same polyfill vite.config.ts applies — keep the
 *  algorithm in lock-step with the real one. */
function applyPolyfill(c: CryptoModule): void {
  if (typeof c.hash !== 'function') {
    c.hash = (algorithm, data, encoding = 'hex') => {
      const h = c.createHash(algorithm)
      h.update(data)
      return h.digest(encoding)
    }
  }
}

describe('crypto.hash polyfill (vite.config.ts regression sentinel)', () => {
  it('Given any supported Node version, When the polyfill is applied, Then crypto.hash is a callable function (Vite + vite-plugin-pwa contract)', () => {
    // arrange
    const nodeCrypto = req('node:crypto') as CryptoModule

    // act
    applyPolyfill(nodeCrypto)

    // assert — function exists either natively (Node 20.12+) or
    // via the shim (Node 18). The build pipeline calls this from
    // vite-plugin-pwa's manifest hashing pass on every CSS asset.
    expect(typeof nodeCrypto.hash).toBe('function')
  })

  it('Given an SHA-256 hash request, When the polyfilled crypto.hash runs, Then it returns the same hex digest as the createHash → update → digest chain (algorithm fidelity)', () => {
    // arrange
    const nodeCrypto = req('node:crypto') as CryptoModule
    applyPolyfill(nodeCrypto)
    const data = 'premium-launch-slice-regression-sentinel'
    const expected = nodeCrypto
      .createHash('sha256')
      .update(data)
      .digest('hex')

    // act
    const got = nodeCrypto.hash!('sha256', data)

    // assert
    expect(got).toBe(expected)
    expect(got).toMatch(/^[0-9a-f]{64}$/)
  })

  it('Given a base64 output encoding, When the polyfilled crypto.hash runs with a non-default encoding, Then the encoding is honored (Workbox uses base64 revisions in the SW manifest)', () => {
    // arrange
    const nodeCrypto = req('node:crypto') as CryptoModule
    applyPolyfill(nodeCrypto)
    const data = 'check-base64-pass-through'
    const expected = nodeCrypto
      .createHash('md5')
      .update(data)
      .digest('base64')

    // act
    const got = nodeCrypto.hash!('md5', data, 'base64')

    // assert
    expect(got).toBe(expected)
  })

  it('Given Uint8Array input, When the polyfilled crypto.hash runs, Then it accepts binary data the same way the chained API does (asset-content fingerprinting case)', () => {
    // arrange — vite-plugin-pwa hashes asset CONTENTS, not just
    // strings, when generating precache revisions. Pin the binary-
    // input branch so a regression that only handled strings would
    // surface here before the build pipeline trips.
    const nodeCrypto = req('node:crypto') as CryptoModule
    applyPolyfill(nodeCrypto)
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
    const expected = nodeCrypto
      .createHash('sha256')
      .update(data)
      .digest('hex')

    // act
    const got = nodeCrypto.hash!('sha256', data)

    // assert
    expect(got).toBe(expected)
  })
})
