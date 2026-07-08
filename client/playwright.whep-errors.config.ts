import { defineConfig, devices } from '@playwright/test'

// Harness #5 W9-W12: local WHEP error-path browser harness.
//
// No global webServer: the fixture owns a per-test scratch uvicorn that serves
// the real built SPA and mounts deterministic /whep/* failure modes.
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /whep-errors\.spec\.ts/,
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
