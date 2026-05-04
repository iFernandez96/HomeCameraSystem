import { test, expect } from '@playwright/test'

// iter-356.56: Pins the new SystemStateBanner + CameraSubtitle on
// the Live page. The banner is the page-level scannable signal
// added in the iter-356 polish thread per Maya's "Live is a black
// void with no clear state" critical finding. The subtitle appears
// directly under the H1 with the armed-state pill.
//
// E2E here means: against a real FastAPI backend with the simulator
// enabled, the page renders the banner with deterministic copy
// because the simulator returns predictable status. We don't assert
// on color (variant-dependent) — only on the role/text contract.

test.describe('Live page — SystemStateBanner + CameraSubtitle (iter-356.56)', () => {
  test.beforeEach(async ({ page }) => {
    // arrange — sign in once per test.
    await page.goto('/login')
    // iter-356.1a added a show-password eye button with aria-label
    // "Show password", which means getByLabel(/password/i) now
    // matches both the input and the button. Selecting via type
    // attribute is unambiguous and pins the input directly.
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/live$/)
  })

  test('given the Live page is loaded, when the simulator returns status, then the system state banner is announced via role=status', async ({
    page,
  }) => {
    // act — landing on /live mounts the page-level banner.
    // Wait for the first /api/status poll to resolve.
    await page.waitForTimeout(2000)

    // assert — banner is one of the role="status" regions on the
    // page. Multiple status regions exist (StatusPill on video,
    // LiveStats summary), so we scope to the banner by its
    // scannable copy. The label varies based on simulator state
    // (armed/disarmed/offline/etc.) — this assertion accepts any
    // of the documented banner labels, which is a real contract:
    // the page must always tell the user what the camera is doing.
    const banner = page
      .getByRole('status')
      .filter({
        hasText:
          /armed and watching|detection paused|camera offline|memory|warm|quiet hours|connecting to the camera/i,
      })
      .first()
    await expect(banner).toBeVisible({ timeout: 8000 })
  })

  test('given the Live page is loaded, then a Camera subtitle row reports the armed/disarmed state', async ({
    page,
  }) => {
    // act — wait for status poll to land.
    await page.waitForTimeout(2000)

    // assert — the subtitle row sits under the H1 with one of the
    // three armed-state labels. We match by aria-label which is a
    // single string covering both the state and the last-frame age.
    // This pins that the page title is no longer a bare camera name
    // floating above a black box (Maya CRITICAL Live #4).
    const subtitle = page.locator('[aria-label^="Camera status:"]')
    await expect(subtitle).toBeVisible({ timeout: 8000 })
    const label = await subtitle.getAttribute('aria-label')
    expect(label).toMatch(/Camera status: (Armed|Disarmed|Camera offline)/i)
  })
})

test.describe('Settings tabs — keyboard navigation (iter-356.56)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    // iter-356.1a added a show-password eye button with aria-label
    // "Show password", which means getByLabel(/password/i) now
    // matches both the input and the button. Selecting via type
    // attribute is unambiguous and pins the input directly.
    await page.locator('input[autocomplete="username"]').fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/live$/)
  })

  test('given the Settings tablist, when ArrowRight is pressed on the active tab, then the next tab gains focus + selection', async ({
    page,
  }) => {
    // arrange
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings$/)
    // The Detection tab is owner-only; admin role hits the carve-
    // out and sees all three tabs. Default landing tab is
    // Notifications (iter-279).
    const notifTab = page.getByRole('tab', { name: /notifications/i })
    await expect(notifTab).toBeVisible()

    // act — focus the Notifications tab, then arrow right.
    await notifTab.focus()
    await page.keyboard.press('ArrowRight')

    // assert — Account & System (or Account) becomes the selected
    // tab. The label varies by role (admin sees "Account & System").
    const nextTab = page.getByRole('tab', { name: /account/i }).first()
    await expect(nextTab).toHaveAttribute('aria-selected', 'true')
  })

  test('given the Settings tablist with Detection as the active tab, when ArrowLeft is pressed, then selection wraps to the last tab', async ({
    page,
  }) => {
    // arrange — click Detection to make it the ACTIVE tab (idx 0)
    // so the wrap-around behavior is testable. Pre-arrange, the
    // default landing tab is Notifications (iter-279). We need
    // Detection active for the wrap-from-first case to fire.
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings$/)
    const detectionTab = page.getByRole('tab', { name: /^detection$/i })
    await expect(detectionTab).toBeVisible()
    await detectionTab.click()
    await expect(detectionTab).toHaveAttribute('aria-selected', 'true')

    // act — Detection is now active; press ArrowLeft to wrap to last.
    await detectionTab.focus()
    await page.keyboard.press('ArrowLeft')

    // assert — selection wraps to the last tab (Account & System
    // for admin/owner role).
    const lastTab = page.getByRole('tab', { name: /account/i }).first()
    await expect(lastTab).toHaveAttribute('aria-selected', 'true')
  })
})
