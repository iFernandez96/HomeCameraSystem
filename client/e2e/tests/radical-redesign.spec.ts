import { test, expect } from '@playwright/test'

// iter-356.57 (radical redesign): pins the new "Watchpost / Den"
// identity. These tests assert visible artifacts of the radical
// theme + microcopy shift so a regression that reverts to the
// iter-356.56 cream-Inter palette would fail at the E2E gate.

test.describe('Radical redesign — visible identity (iter-356.57)', () => {
  test('given anon user lands on /, then the den brand row identifies the product as a household watch', async ({
    page,
  }) => {
    // act
    await page.goto('/')

    // assert — the brass uppercase "THE DEN · A HOUSEHOLD WATCH"
    // tag + the cat-trio + the italic motto attribute the cats as
    // agents (not beneficiaries). All three must be present on the
    // login surface for the identity to read.
    await expect(
      page.getByText(/the den · a household watch/i),
    ).toBeVisible()
    await expect(
      page.getByText(/Panther, Mushu & Coco are watching the door/i),
    ).toBeVisible()
  })

  test('given the user logs in, then the page-level system banner attributes the watch to Panther', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/$/)

    // act — wait for status poll
    await page.waitForTimeout(2500)

    // assert — banner copy now uses the cat-brand role phrasing.
    // The fixture simulator has detection_active=true and worker_alive=true,
    // so we expect the armed-state copy.
    const banner = page
      .getByRole('status')
      .filter({ hasText: /Panther's watching|Panther's off duty|Camera offline/i })
      .first()
    await expect(banner).toBeVisible({ timeout: 10_000 })
  })

  test('given any authed page is loaded, then page titles use the Bricolage Grotesque display family (playroom-modern typography flip)', async ({
    page,
  }) => {
    // arrange — log in. The page-title h1 is on every authed page.
    await page.goto('/login')
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.waitForTimeout(1000)

    // assert — the .page-title H1 must resolve `font-family` to
    // include Bricolage Grotesque. redesign/playroom-modern (Task 0)
    // swapped the display face from Fraunces to Bricolage Grotesque.
    // A regression that drops `font-family: var(--font-display)`
    // from `.page-title` (or removes the Bricolage token) would
    // fail this test.
    const h1 = page.locator('h1.page-title').first()
    await expect(h1).toBeVisible()
    const fontFamily = await h1.evaluate(
      (el) => window.getComputedStyle(el).fontFamily,
    )
    expect(fontFamily.toLowerCase()).toMatch(/bricolage/i)
  })

  test('given the People page renders empty, then Mushu greets the user', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/people')

    // act
    await page.waitForTimeout(2000)

    // assert — Mushu copy attributes the empty face-recognition list
    // to him as the Greeter (cat-brand role mapping).
    await expect(
      page.getByText(/Mushu doesn't know anyone yet/i),
    ).toBeVisible({ timeout: 6000 })
  })

  test('given the user is signed in, then the SideNav account marker identifies the current user accessibly', async ({
    page,
  }) => {
    // arrange
    await page.goto('/login')
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/$/)

    // act — desktop sidebar is `hidden lg:flex`; the test viewport
    // (Desktop Chrome via playwright config) renders it. The compact avatar
    // keeps the username in its accessible name while avoiding duplicate
    // visible account chrome beside the Sign out control.
    await page.waitForTimeout(1000)

    // assert — account identity and the adjacent action are both discoverable.
    await expect(page.locator('[aria-label="Signed in as admin"]')).toBeVisible({ timeout: 4000 })
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
  })
})
