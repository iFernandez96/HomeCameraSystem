import { test, expect } from '../authHarness'

test.describe('Auth session lifecycle harness', () => {
  test.skip(
    !process.env.CI && process.env.HOMECAM_RUN_REAL_BROWSER_AUTH !== '1',
    'set HOMECAM_RUN_REAL_BROWSER_AUTH=1 to run the real-browser auth harness locally',
  )

  test('given the harness boots, when Chromium opens baseURL, then login page renders and healthz is ready', async ({
    authServer,
    page,
  }) => {
    expect(authServer.healthzStatus).toBe(200)

    await page.goto('/')

    await expect(page).toHaveTitle(/HomeCam/)
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel(/username/i)).toBeVisible()
    // getByLabel(/password/i) is ambiguous here: the Show-password toggle's
    // aria-label also matches. Target the textbox role explicitly.
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })
})
