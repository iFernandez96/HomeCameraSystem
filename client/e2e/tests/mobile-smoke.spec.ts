import { expect, test } from '@playwright/test'

test('phone journey: sign in, watch controls, and Focus Assistant remain usable', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/login')
  await page.getByLabel(/username/i).fill('admin')
  await page.locator('input[autocomplete="current-password"]').fill('admin')
  await page.getByRole('button', { name: /sign in|log in|login/i }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('live-scene')).toBeVisible()
  await expect(page.getByRole('button', { name: /stream quality/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /snapshot/i })).toBeVisible()

  // Scene chrome should toggle without hiding the persistent toolbar.
  await page.getByTestId('live-scene').tap({ position: { x: 180, y: 100 } })
  await expect(page.getByRole('button', { name: /snapshot/i })).toBeVisible()

  await page.getByRole('link', { name: /settings/i }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByRole('tab', { name: /watching/i }).click()
  await page.getByRole('link', { name: /open assistant/i }).click()
  await expect(page).toHaveURL(/\/settings\/focus-assistant$/)
  await expect(page.getByRole('heading', { name: /focus assistant/i })).toBeVisible()

  expect(pageErrors, `uncaught browser errors: ${pageErrors.join('; ')}`).toEqual([])
})
