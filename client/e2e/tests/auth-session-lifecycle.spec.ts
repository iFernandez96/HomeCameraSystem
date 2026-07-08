import { test, expect } from '../authHarness'
import type { Cookie, Page } from '@playwright/test'

const ACCESS_COOKIE = 'homecam_access'
const REFRESH_COOKIE = 'homecam_refresh'
const ACCESS_TOKEN_TTL_S = 3
const REFRESH_TOKEN_TTL_S = 20
const COOKIE_EXPIRY_TOLERANCE_S = 3

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/')

  await page.getByLabel(/username/i).fill('admin')
  await page.getByRole('textbox', { name: /password/i }).fill('admin')
  await page.getByRole('button', { name: /sign in|log in|login/i }).click()

  // The authed landing route is "/" (App.tsx routes /live -> Navigate to "/").
  await expect(page).toHaveURL(/\/$/)
  // BottomNav labels are Home/Events/Faces/Settings (Playroom pebble bar).
  await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /events/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /settings/i })).toBeVisible()
}

async function authCookies(
  page: Page,
  baseURL: string,
): Promise<{ accessCookie: Cookie; refreshCookie: Cookie }> {
  const cookies = await page.context().cookies(`${baseURL}/api/auth/me`)
  const authCookies = new Map(cookies.map((cookie) => [cookie.name, cookie]))
  const accessCookie = authCookies.get(ACCESS_COOKIE)
  const refreshCookie = authCookies.get(REFRESH_COOKIE)

  expect(accessCookie, `${ACCESS_COOKIE} cookie metadata`).toBeDefined()
  expect(refreshCookie, `${REFRESH_COOKIE} cookie metadata`).toBeDefined()

  return {
    accessCookie: accessCookie!,
    refreshCookie: refreshCookie!,
  }
}

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

  test('given default TTLs, when seeded user logs in through the real form, then auth cookies match the browser contract', async ({
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)

    const { accessCookie, refreshCookie } = await authCookies(
      page,
      authServer.baseURL,
    )

    for (const cookie of [accessCookie, refreshCookie]) {
      expect(cookie.path).toBe('/api')
      expect(cookie.httpOnly).toBe(true)
      expect(cookie.sameSite).toBe('Strict')
      expect(cookie.expires).toBeGreaterThan(0)
    }

    const ttlDifference = REFRESH_TOKEN_TTL_S - ACCESS_TOKEN_TTL_S
    expect(
      Math.abs(refreshCookie.expires - accessCookie.expires - ttlDifference),
    ).toBeLessThanOrEqual(COOKIE_EXPIRY_TOLERANCE_S)
  })

  test('given a logged-in session, when access TTL elapses and the next API round-trip runs, then auth refresh rotates both cookies', async ({
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)

    const original = await authCookies(page, authServer.baseURL)
    const refreshResponses: number[] = []
    page.on('response', (response) => {
      const request = response.request()
      if (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/refresh'
      ) {
        refreshResponses.push(response.status())
      }
    })

    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 0.5) * 1_000)
    await page.getByRole('link', { name: /events/i }).click()

    await expect
      .poll(() => refreshResponses, { timeout: 10_000 })
      .toEqual([200])
    await expect(page).not.toHaveURL(/\/login(?:$|[/?#])/)
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /events/i })).toBeVisible()

    const rotated = await authCookies(page, authServer.baseURL)
    expect(rotated.accessCookie.expires).toBeGreaterThan(
      original.accessCookie.expires,
    )
    expect(rotated.refreshCookie.expires).toBeGreaterThan(
      original.refreshCookie.expires,
    )
  })
})
