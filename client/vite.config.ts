/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

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
        globPatterns: ['**/*.{js,css,html,svg,ico,webmanifest}'],
        globIgnores: ['**/cats/**', '**/*-cat-*.png'],
      },
      includeAssets: ['icon.svg', 'icon-maskable.svg'],
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
        // iter-356.65 (mobile slice A): manifest theme/bg flipped to
        // the dark "watchpost" page bg so the iOS standalone splash
        // and Android adaptive-icon background match the running app
        // instead of the obsolete cream theme that was here before.
        theme_color: '#1e1710',
        background_color: '#1e1710',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
          // iter-356.x (mobile audit D1): Android Chrome 12+ adaptive-
          // icon system applies a circular mask to maskable icons.
          // SVG-only maskable can render without the safe-zone crop
          // on some launchers, bleeding artwork to the edge. PNG
          // raster fallbacks fix that.
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
            icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
          },
          {
            name: 'Recent events',
            short_name: 'Events',
            description: 'Browse recent detection events',
            url: '/events',
            icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
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
