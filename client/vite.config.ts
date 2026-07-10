/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
// Default import (mutable module object) rather than `import * as`
// (frozen namespace object) — see polyfill block below: we need to
// install `hash` as a property if the running Node version doesn't
// already expose it.
import nodeCrypto from 'node:crypto'

// Premium-launch slice — `crypto.hash` polyfill for Node 18.
//
// Vite 7 + vite-plugin-pwa call the synchronous one-shot
// `crypto.hash(algorithm, data, encoding)` API that landed in
// Node 20.12+. The build host still ships Node 18 because the repo
// lives on exFAT and `nvm install` cannot create the
// `~/.nvm/.../bin/node` symlink. Production runs PRE-BUILT dist/
// output, so this shim runs on the build machine only and has no
// production footprint.
//
// Without it, any new `url('/path')` reference in src/index.css or
// inline `<style>` in index.html crashes vite-plugin-pwa's hashing
// pass with `crypto.hash is not a function` — the prior loop had
// to route font @font-face declarations through a static
// /public/fonts.css to sidestep this. With the shim in place, future
// CSS asset references work normally.
//
// The shim mirrors Node 20+'s synchronous one-shot signature
// exactly: `(algorithm, data, encoding = 'hex') => string`. On
// Node 20.12+ the `if (!hash)` guard is false and the shim is a
// no-op, preserving native behavior. On Node 18 the shim installs
// itself via the createHash → update → digest chain.
//
// `@types/node` is installed as a devDependency (type-only, no bin
// scripts → no symlink required, exFAT-safe) so `node:crypto` types
// resolve cleanly. We avoid mirroring Node's full polymorphic
// `crypto.hash` overload set — Vite/Workbox only need the simple
// 2-arg / 3-arg `(algo, data, enc)` shape, so the polyfill exposes
// just that. The cast to `unknown as { hash?: ... }` lets us assign
// without fighting Node's own conditional-type `hash` declaration.
type SimpleHash = (
  algorithm: string,
  data: string | NodeJS.ArrayBufferView,
  outputEncoding?: nodeCrypto.BinaryToTextEncoding,
) => string
const _cryptoSlot = nodeCrypto as unknown as { hash?: SimpleHash }
if (typeof _cryptoSlot.hash !== 'function') {
  _cryptoSlot.hash = (algorithm, data, outputEncoding = 'hex') => {
    const h = nodeCrypto.createHash(algorithm)
    h.update(data)
    return h.digest(outputEncoding)
  }
}

// iter-356.37: build-time stamp injected as `__BUILD_ID__` so the
// debug-reload UI in Settings can show "Bundle: <id>" — operator can
// confirm a force-reload actually pulled the latest deploy. Format:
// ISO date + 6-char random suffix so two builds in the same minute
// still differ.
const __BUILD_ID = (() => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  const rand = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${rand}`
})()

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(__BUILD_ID),
  },
  build: {
    rollupOptions: {
      output: {
        // UI/UX overhaul 2026-07-07 (perf A1): split the framework
        // trio into a stable `vendor` chunk. React/ReactDOM/router
        // change only on dependency bumps, so returning users keep a
        // cached vendor chunk across app deploys instead of
        // re-downloading it inside a monolithic index chunk on every
        // client release.
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // iter-356.65 (mobile slice A): cat PNG sprites are heavy
        // (Panther/Mushu/Coco bodies + variants) and only render on
        // empty-state surfaces / ambient CatLayer — not on the
        // critical path. Ship them out of the precache and into a
        // runtime CacheFirst rule (configured in src/sw.ts) so the
        // initial install payload drops by ~28 entries / hundreds of
        // KB. The runtime rule still caches them on first hit with a
        // 30-day expiration, so offline behaviour is preserved.
        // Premium-launch slice: include woff2 so the self-hosted
        // Inter + Fraunces variable fonts are available offline (the
        // PWA precache adds ~115 KB but pays off the first time the
        // user opens the app on a flaky cellular connection — the
        // /fonts.css link in index.html resolves from the cache
        // instead of a network round-trip and there is no FOIT).
        globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest,woff2}'],
        globIgnores: ['**/cats/**', '**/*-cat-*.png'],
      },
      includeAssets: ['icon-96.png', 'icon-192.png', 'icon-512.png'],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        // iter-356.35: cat-themed brand identity carried into the PWA
        // install surface. Name flips from "Home Camera" → "HomeCam" so
        // the short version shows on most Android home-screen labels.
        // theme_color + background_color flip from legacy dark to cream
        // matching the iter-356.25 light theme; iOS splash + Android
        // adaptive-icon background now reads as the same brand surface
        // as the running app.
        name: 'HomeCam — Panther, Mushu & Coco',
        short_name: 'HomeCam',
        description: 'Self-hosted home camera, watched over by three cats.',
        // Dual-theme (2026-07-02): the manifest is static, so splash +
        // task-switcher chrome pin to the DARK bg (the user's default
        // Android-native face); the live status bar follows the
        // resolved theme via the index.html meta pair + lib/theme.ts.
        // Keep in lock-step with index.css dark --color-bg.
        theme_color: '#232019',
        background_color: '#232019',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
        // Long-press home-screen icon on Android (and right-click on
        // most desktops) → quick action menu. Skip Settings — it's
        // the rarer destination and the menu reads cleaner with two
        // entries.
        shortcuts: [
          {
            name: 'Live camera',
            short_name: 'Live',
            description: 'Open the live camera feed',
            url: '/live',
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Recent events',
            short_name: 'Events',
            description: 'Browse recent detection events',
            url: '/events',
            icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
        lang: 'en',
        dir: 'ltr',
        categories: ['utilities', 'productivity'],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
      // iter-244b: dev-time mirror of the iter-244 Tailscale Serve
      // path proxy at `/whep`. Lets `whepUrl()` produce the same
      // same-origin URL in dev (`http://localhost:5173/whep/cam/whep`)
      // and prod (`https://homecam.tail4a6525.ts.net/whep/cam/whep`).
      // MediaMTX listens on :8889 in both environments.
      '/whep': {
        target: 'http://localhost:8889',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/whep/, ''),
      },
    },
  },
  test: {
    globals: false,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/sw.ts',
        'src/vite-env.d.ts',
        'src/lib/types.ts',
      ],
    },
  },
})
