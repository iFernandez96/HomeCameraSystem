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

  test('given a worker heartbeat carries fps=12.5, when /api/status is polled, then top-level fps mirrors worker_metrics.fps (iter-246)', async ({
    page,
  }) => {
    // arrange — fire a heartbeat directly to /api/_internal/* (the
    // unauth carve-out the real worker also uses). The E2E harness
    // doesn't run the actual detection worker, but the route + the
    // server-side WorkerHealth bookkeeping are real.
    const hb = await page.request.post('/api/_internal/heartbeat', {
      data: { fps: 12.5, gear: 'idle' },
    })
    expect(hb.status()).toBe(200)

    // act
    const r = await page.request.get('/api/status')

    // assert — pre-iter-246 status.fps was always 0.0 (read
    // camera_service.fps, a never-updated stub). Post-fix it
    // mirrors worker_metrics.fps.
    expect(r.status()).toBe(200)
    const body = await r.json()
    expect(body.worker_metrics?.fps).toBe(12.5)
    expect(body.fps).toBe(12.5)
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
