import { defineConfig, devices } from '@playwright/test'

// Harness #6 owns its scratch FastAPI server from swHarness.ts.
// Keep this config free of the default global webServer so the env gate can
// cleanly skip without binding ports or starting unrelated infrastructure.
export default defineConfig({
  testDir: './tests',
  testMatch: /sw-lifecycle\.spec\.ts/,
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
