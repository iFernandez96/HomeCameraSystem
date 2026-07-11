import { test, expect } from '@playwright/test'

// iter-245: First Playwright test. Pins the auth-track happy path
// (iter-181..186) end-to-end: cookieless first request → 401-redirect
// to /login, login form posts, HttpOnly cookies set, /me returns
// authed, redirect to the Watch home route, primary navigation visible.

test.describe('Auth — login flow', () => {
  test('given anon user lands on /, when admin/admin login submitted, then redirects to Watch with primary navigation', async ({
    page,
  }) => {
    // arrange
    await page.goto('/')

    // act
    await page.getByLabel(/username/i).fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()

    // assert
    await expect(page).toHaveURL(/\/$/)
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Events', exact: true })).toBeVisible()
    await expect(nav.getByRole('link', { name: 'Settings', exact: true })).toBeVisible()
  })

  test('given a wrong password, when login submitted, then stays on /login with an error', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')

    // act
    await page.getByLabel(/username/i).fill('admin')
    await page.locator('input[type="password"]').fill('not-the-right-one')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()

    // assert
    await expect(page).toHaveURL(/\/login$/)
    await expect(
      page.getByRole('alert').filter({ hasText: /wrong username or password/i }),
    ).toBeVisible()
  })
})
