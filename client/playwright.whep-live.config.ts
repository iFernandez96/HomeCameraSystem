import { defineConfig, devices } from '@playwright/test'

const liveOrigin =
  process.env.HOMECAM_LIVE_ORIGIN ?? 'https://homecam.tail4a6525.ts.net'

// Harness #5 W1-W3: live WHEP browser smoke.
//
// No webServer: this intentionally targets the already-running real origin
// when HOMECAM_LIVE_WHEP=1 is set. Without that gate the suite skips before
// navigation, so local/sandbox runs never touch the live Jetson.
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /whep-live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: liveOrigin,
    trace: 'on-first-retry',
    headless: true,
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
})
