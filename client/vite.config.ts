/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
      },
      includeAssets: ['icon.svg', 'icon-maskable.svg'],
      devOptions: {
        enabled: true,
        type: 'module',
      },
      manifest: {
        name: 'Home Camera',
        short_name: 'HomeCam',
        description: 'Self-hosted Jetson camera viewer',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
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
