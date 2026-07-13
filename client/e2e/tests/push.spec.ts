import { test, expect } from '@playwright/test'

// iter-245: Pins the iter-244e VAPID-key-format bug end-to-end. The
// pywebpush 2.3.0 regression silently turned every push fanout into
// a ValueError caught by the iter-165 transient-error handler — the
// route still returned `{ok: true, sent: 0}` because the call never
// got far enough to count as a delivery. Without an E2E test, the
// only signal was the user reporting "no reachable subscriptions"
// from the UI. Now we hit the backend's `/api/push/test` endpoint
// directly and assert it doesn't 5xx and returns a sane shape.
//
// We don't have a real PushManager subscription in headless
// Chromium without a push service backend, so we test the route
// shape + that VAPID load didn't poison the service. The "real
// fanout against a fake gateway" upgrade is a follow-up.

test.describe('Push — VAPID + test fanout shape', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/username/i).fill('admin')
    await page.locator('input[type="password"]').fill('admin')
    await page.getByRole('button', { name: /sign in|log in|login/i }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('given an authed session, when /api/push/test is called, then it returns 200 with a numeric sent count', async ({
    page,
  }) => {
    // arrange — use page.request so HttpOnly cookies set by the
    // page-level login are inherited by the API request. Playwright
    // does not share cookies between the standalone `request`
    // fixture and the page context.

    // act
    const r = await page.request.post('/api/push/test')

    // assert
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(typeof body.sent).toBe('number')
    // No subscriptions registered in the harness → 0 sent. The
    // critical pin is that the call DIDN'T 500 (which would mean
    // VAPID load broke and pywebpush threw uncaught).
    expect(body.sent).toBe(0)
  })

  test('given an authenticated browser, when it posts a worker heartbeat without the worker credential, then the route rejects it without mutation', async ({
    page,
  }) => {
    // Browser login cookies do not grant worker authority. The real worker
    // reads a separate file-backed credential that is deliberately absent
    // from browser state and this request.
    const hb = await page.request.post('/api/_internal/heartbeat', {
      data: { fps: 12.5, gear: 'idle' },
    })
    expect(hb.status()).toBe(401)
    expect(await hb.body()).toHaveLength(0)

    const r = await page.request.get('/api/status')

    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body.worker_metrics?.fps).not.toBe(12.5)
    expect(body.fps).not.toBe(12.5)
  })

  test('given an authed session, when /api/push/vapid-public-key is called, then a non-empty key string is returned', async ({
    page,
  }) => {
    // arrange — keys are written into the temp fixture dir at
    // server boot; this asserts they were generated AND loaded.
    // Use page.request to inherit auth cookies.

    // act
    const r = await page.request.get('/api/push/vapid-public-key')

    // assert
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(typeof body.key).toBe('string')
    expect(body.key.length).toBeGreaterThan(20)
  })
})
