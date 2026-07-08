import { defineConfig, devices } from '@playwright/test'

// Harness #10 M10.5-M10.6: real-browser multicam proof against a local
// MediaMTX + ffmpeg synthetic source. No global webServer: the fixture owns
// scratch uvicorn, MediaMTX, and publisher lifetimes per test.
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /multicam-switch\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
})
