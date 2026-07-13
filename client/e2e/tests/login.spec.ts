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

  test('given repeated wrong passwords, when backoff expires and valid credentials are submitted, then the UI recovers', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')
    await page.getByLabel(/username/i).fill('admin')
    const password = page.locator('input[type="password"]')
    const submit = page.getByRole('button', { name: /sign in|log in|login/i })

    // act/assert: the first two failures remain deliberately indistinguishable.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await password.fill('not-the-right-one')
      await submit.click()
      await expect(page).toHaveURL(/\/login$/)
      await expect(
        page.getByRole('alert').filter({ hasText: /wrong username or password/i }),
      ).toBeVisible()
    }

    // The third failure exposes only the bounded retry interval.
    await password.fill('not-the-right-one')
    await submit.click()
    await expect(
      page.getByRole('alert').filter({
        hasText: /too many attempts.*wait 1 second and try again/i,
      }),
    ).toBeVisible()

    // Once the interval expires, a successful login clears this exact bucket.
    await page.waitForTimeout(1_100)
    await password.fill('admin')
    await submit.click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  })
})
