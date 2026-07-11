import { defineConfig, devices } from '@playwright/test'

// iter-245: Playwright E2E harness. Catches the integration bugs
// the unit suite can't reach (CSS layout, fullscreen API, real
// WHEP / pywebpush calls, route URL composition end-to-end). User
// asked for this after iter-244c-d-e surfaced ~6 bugs in a row
// that mock-heavy unit tests didn't catch.
//
// Runs against:
//   - A fresh FastAPI server (../server/, dev venv at
//     /tmp/homecam-venv) booted by `e2e/start-server.sh` with
//     temp DBs + admin user seeded + simulator on.
//   - The Vite dev server on :5173 which proxies /api → :8000.
//
// Run from `client/`:
//   npm run test:e2e
//
// Headed run (debugging):
//   npm run test:e2e -- --headed
export default defineConfig({
  testDir: './e2e/tests',
  // These journeys own special fixtures, devices, or live infrastructure and
  // are run through their dedicated Playwright configs.  Keeping them out of
  // the normal desktop suite prevents a phone-only touch journey (and the
  // self-hosted harnesses) from accidentally inheriting Desktop Chrome plus
  // this config's shared FastAPI server.
  testIgnore: [
    /auth-session-lifecycle\.spec\.ts/,
    /mobile-smoke\.spec\.ts/,
    /multicam-switch\.spec\.ts/,
    /sw-lifecycle\.spec\.ts/,
    /whep-errors\.spec\.ts/,
    /whep-live\.spec\.ts/,
  ],
  // Sequential. The server is single-process and stateful (one
  // shared sqlite, one DetectionService gate). Cross-test
  // isolation would require per-test fixture dirs, deferred.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    // iter-245: target FastAPI's :8000 directly — it serves both the
    // /api/* surface and the SPA's static bundle (CLIENT_DIST mount).
    // Pre-iter-245 attempt used Vite's dev server at :5173 but Vite
    // 7's new dep-optimizer calls `crypto.hash()` which doesn't
    // exist on Node 18 (the project's pinned dev Node, see
    // CLAUDE.md). Serving the built bundle is also more honest as
    // production tests — exercises the real chunk-split + minified
    // code paths.
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: [
    {
      command: 'sh ./e2e/start-server.sh',
      url: 'http://127.0.0.1:8000/healthz',
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
