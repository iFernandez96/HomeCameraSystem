import { defineConfig, devices } from '@playwright/test'

// A10 real-browser auth/session harness.
//
// Unlike playwright.config.ts, this config deliberately has no global
// webServer. The scratch FastAPI server is owned by the authHarness
// fixture so each test gets its own temp root, port, logs, users DB,
// JWT secret, and recordings directory.
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /auth-session-lifecycle\.spec\.ts/,
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
