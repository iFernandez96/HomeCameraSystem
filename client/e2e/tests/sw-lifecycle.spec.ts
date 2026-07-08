import { test, expect } from '../swHarness'

test.describe('SW lifecycle two-build harness', () => {
  test.skip(
    process.env.HOMECAM_RUN_SW_HARNESS !== '1',
    'set HOMECAM_RUN_SW_HARNESS=1 to run Harness #6 SW lifecycle rig',
  )

  test('given two marked builds and scratch uvicorn serving build A, when Chromium loads the app, then marker A renders and the SW activates', async ({
    page,
    swServer,
  }) => {
    expect(swServer.healthzStatus).toBe(200)
    expect(swServer.buildA.marker).toBe('h6-a')
    expect(swServer.buildB.marker).toBe('h6-b')
    expect(swServer.buildA.dist).not.toBe(swServer.buildB.dist)

    await page.goto('/')

    await expect(page.locator('[data-homecam-build-marker="h6-a"]')).toBeVisible()
    await expect(page.locator('[data-homecam-build-marker="h6-b"]')).toHaveCount(0)

    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return { supported: false, readyState: null, scriptURL: null }
      }
      const registration = await navigator.serviceWorker.ready
      return {
        supported: true,
        readyState: registration.active?.state ?? null,
        scriptURL: registration.active?.scriptURL ?? null,
      }
    })

    expect(swState.supported).toBe(true)
    expect(swState.scriptURL).toBe(`${swServer.baseURL}/sw.js`)
    // navigator.serviceWorker.ready resolves while the worker can still be
    // 'activating'; poll until the state machine settles.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready
            return registration.active?.state ?? null
          }),
        { timeout: 10_000 },
      )
      .toBe('activated')
  })
})
