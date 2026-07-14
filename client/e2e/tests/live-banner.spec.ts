import { test, expect } from '@playwright/test'

// Pins the current Watch state surfaces. The page-level status region and
// the glance strip both keep camera state visible beside the live scene.
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
    await expect(page).toHaveURL(/\/$/)
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

  test('given the Live page is loaded, then the glance strip reports the watch state', async ({
    page,
  }) => {
    // act — wait for status poll to land.
    await page.waitForTimeout(2000)

    // assert — the current docked layout ties the canonical armed-state
    // vocabulary directly to the live scene in its glance strip.
    const glance = page.getByTestId('live-glance-strip')
    await expect(glance).toBeVisible({ timeout: 8000 })
    await expect(glance).toContainText(
      /On watch|Off duty|Camera offline|Reconnecting|Checking/i,
    )
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
    await expect(page).toHaveURL(/\/$/)
  })

  test('given the Settings tablist, when ArrowRight is pressed on the active tab, then the next tab gains focus + selection', async ({
    page,
  }) => {
    // arrange
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings$/)
    // The Detection tab is owner-only; admin role hits the carve-
    // out and sees all three tabs. Default landing tab is
    // Alerts (the user-facing name for the notifications panel).
    const notifTab = page.getByRole('tab', { name: /^alerts$/i })
    await expect(notifTab).toBeVisible()

    // act — focus the Alerts tab, then arrow right.
    await notifTab.focus()
    await page.keyboard.press('ArrowRight')

    // assert — Account & System (or Account) becomes the selected
    // tab. The label varies by role (admin sees "Account & System").
    const nextTab = page.getByRole('tab', { name: /account/i }).first()
    await expect(nextTab).toHaveAttribute('aria-selected', 'true')
  })

  test('given the Settings tablist with Watching as the active tab, when ArrowLeft is pressed, then selection wraps to the last tab', async ({
    page,
  }) => {
    // arrange — click Watching to make it the ACTIVE tab (idx 0)
    // so the wrap-around behavior is testable. Pre-arrange, the
    // default landing tab is Notifications (iter-279). We need
    // Watching active for the wrap-from-first case to fire.
    await page.goto('/settings')
    await expect(page).toHaveURL(/\/settings$/)
    const detectionTab = page.getByRole('tab', { name: /^watching$/i })
    await expect(detectionTab).toBeVisible()
    await detectionTab.click()
    await expect(detectionTab).toHaveAttribute('aria-selected', 'true')

    // act — Watching is now active; press ArrowLeft to wrap to last.
    await detectionTab.focus()
    await page.keyboard.press('ArrowLeft')

    // assert — selection wraps to the last tab (Account & System
    // for admin/owner role).
    const lastTab = page.getByRole('tab', { name: /account/i }).first()
    await expect(lastTab).toHaveAttribute('aria-selected', 'true')
  })
})
