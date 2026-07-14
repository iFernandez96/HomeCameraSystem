import { defineConfig, devices } from '@playwright/test'

// A deliberately small mobile gate. The full desktop suite contains
// desktop-only assertions; this project exercises the highest-risk phone path
// without pretending desktop navigation is visible on a 412 px viewport.
export default defineConfig({
  testDir: './e2e/tests',
  testMatch: /mobile-smoke\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Pixel 7'],
  },
  webServer: {
    command: 'sh ./e2e/start-server.sh',
    url: 'http://127.0.0.1:8000/healthz',
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
