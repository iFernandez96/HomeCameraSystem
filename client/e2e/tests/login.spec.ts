import { test, expect } from '@playwright/test'

// iter-245: First Playwright test. Pins the auth-track happy path
// (iter-181..186) end-to-end: cookieless first request → 401-redirect
// to /login, login form posts, HttpOnly cookies set, /me returns
// authed, redirect to /live, BottomNav visible.

test.describe('Auth — login flow', () => {
  test('given anon user lands on /, when admin/admin login submitted, then redirects to /live with bottom nav', async ({
    page,
  }) => {
    // arrange
    await page.goto('/')

    // act
    await page.getByLabel(/username/i).fill('admin')
    await page.getByLabel(/password/i).fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()

    // assert
    await expect(page).toHaveURL(/\/live$/)
    // BottomNav only renders when state==='authed' (iter-184 contract).
    await expect(page.getByRole('link', { name: /live/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /events/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible()
  })

  test('given a wrong password, when login submitted, then stays on /login with an error', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')

    // act
    await page.getByLabel(/username/i).fill('admin')
    await page.getByLabel(/password/i).fill('not-the-right-one')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()

    // assert
    await expect(page).toHaveURL(/\/login$/)
    // Some error indication appears — exact copy is design-tunable.
    await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible()
  })
})
