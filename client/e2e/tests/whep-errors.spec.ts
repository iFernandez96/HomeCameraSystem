import { expect, loginAsAdmin, test, type Page } from '../whepErrorHarness'
import type { WhepErrorLedger, WhepErrorMode } from '../whepErrorHarness'

const HqPath = '/whep/cam/whep'
const SdPath = '/whep/cam_lq/whep'

test.describe('WHEP local error harness', () => {
  async function openWatch(page: Page): Promise<void> {
    await loginAsAdmin(page)
    await expect(page.getByRole('button', { name: 'Stream quality' })).toBeVisible()
  }

  async function openWatchWithServiceWorkerControl(page: Page): Promise<void> {
    await openWatch(page)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) {
        window.location.reload()
      }
    })
    await expect
      .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true)
    await expect(page.getByRole('button', { name: 'Stream quality' })).toBeVisible()
  }

  async function expectOfflineRetry(page: Page): Promise<void> {
    await expect(page.getByTestId('live-viewport').getByText('Camera offline')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible()
  }

  async function selectQuality(page: Page, name: RegExp): Promise<void> {
    await page.getByRole('button', { name: 'Stream quality' }).click()
    await page.getByRole('option', { name }).click()
  }

  function consoleText(ledger: WhepErrorLedger): string {
    return ledger.consoleMarkers.map((marker) => marker.text).join('\n')
  }

  async function runHungPostQualitySwitch(
    page: Page,
    whepErrorServer: {
      setMode: (mode: WhepErrorMode, path?: string) => Promise<void>
      readServerEvents: () => Promise<Array<{ event: string; path: string }>>
    },
    openPage: (page: Page) => Promise<void>,
  ): Promise<void> {
    await whepErrorServer.setMode('hang', HqPath)
    await whepErrorServer.setMode('503', SdPath)
    await openPage(page)

    await expect
      .poll(async () => {
        const events = await whepErrorServer.readServerEvents()
        return events.filter((event) => event.event === 'start').length
      })
      .toBe(1)

    await selectQuality(page, /Data-saver/)
  }

  async function serverEventCounts(
    whepErrorServer: {
      readServerEvents: () => Promise<Array<{ event: string; path: string }>>
    },
  ) {
    const events = await whepErrorServer.readServerEvents()
    return {
      hqStarts: events.filter(
        (event) => event.event === 'start' && event.path === HqPath,
      ).length,
      hqAborts: events.filter(
        (event) => event.event === 'aborted' && event.path === HqPath,
      ).length,
      sdStarts: events.filter(
        (event) => event.event === 'start' && event.path === SdPath,
      ).length,
      starts: events.filter((event) => event.event === 'start').length,
    }
  }

  test('W10: non-2xx WHEP responses show error UI, log status, and manual Retry makes one new POST', async ({
    page,
    whepErrorLedger,
    whepErrorServer,
  }) => {
    await whepErrorServer.setMode('404')
    await openWatch(page)

    const expectRetryAddsOnePost = async (mode: WhepErrorMode) => {
      await expectOfflineRetry(page)
      expect(consoleText(whepErrorLedger)).toContain(`status: ${Number(mode)}`)
      const before = (await whepErrorServer.readServerEvents()).filter(
        (event) => event.event === 'start',
      ).length

      await page.getByRole('button', { name: /retry/i }).click()

      await expect
        .poll(async () => {
          const events = await whepErrorServer.readServerEvents()
          return events.filter((event) => event.event === 'start').length
        })
        .toBe(before + 1)
      await page.waitForTimeout(750)
      const events = await whepErrorServer.readServerEvents()
      expect(events.filter((event) => event.event === 'start').length).toBe(before + 1)
    }

    await expectRetryAddsOnePost('404')

    await whepErrorServer.setMode('503')
    await page.getByRole('button', { name: /retry/i }).click()
    await expect
      .poll(() => consoleText(whepErrorLedger))
      .toContain('status: 503')
    await expectRetryAddsOnePost('503')

    expect(whepErrorLedger.responsePosts.map((post) => post.status)).toEqual([
      404,
      404,
      503,
      503,
    ])
  })

  // context.route cannot intercept SW registration script fetches; the only
  // reliable way to keep the page uncontrolled is the context-level option.
  test.describe('without service worker', () => {
    test.use({ serviceWorkers: 'block' })

    test('W11a: without service worker control, hung WHEP POST is aborted by quality switch with no second concurrent attempt and no peer leak', async ({
      page,
      whepErrorLedger,
      whepErrorServer,
    }) => {
      await runHungPostQualitySwitch(page, whepErrorServer, openWatch)

    await expect
      .poll(async () => {
        const { hqStarts, hqAborts, sdStarts } =
          await serverEventCounts(whepErrorServer)
        return { hqStarts, hqAborts, sdStarts }
      })
      .toEqual({ hqStarts: 1, hqAborts: 1, sdStarts: 1 })

    await expectOfflineRetry(page)
    await expect
      .poll(async () => {
        return await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamWhepPcProbe?: {
                  constructed: number
                  closed: number
                  active: number
                }
              }
            ).__homecamWhepPcProbe ?? { constructed: 0, closed: 0, active: 0 }
          )
        })
      })
      .toMatchObject({ constructed: 2, closed: 2, active: 0 })

    expect((await serverEventCounts(whepErrorServer)).starts).toBe(2)
    expect(consoleText(whepErrorLedger)).toContain('e2e:whep-pc-close')
    })
  })

  test('W11b: abort propagates to the server even with the service worker controlling the page', async ({
    page,
    whepErrorServer,
  }) => {
    await runHungPostQualitySwitch(
      page,
      whepErrorServer,
      openWatchWithServiceWorkerControl,
    )

    // Measured truth (2026-07-08): once the harness detects disconnects at
    // the raw ASGI layer, the abort is visible with the SW active too — the
    // earlier "Chromium SW pass-through gap" was an artifact of starlette
    // BaseHTTPMiddleware swallowing http.disconnect, not a platform gap.
    await expect
      .poll(async () => {
        const { hqStarts, hqAborts, sdStarts } =
          await serverEventCounts(whepErrorServer)
        return { hqStarts, hqAborts, sdStarts }
      })
      .toEqual({ hqStarts: 1, hqAborts: 1, sdStarts: 1 })
  })

  test('W12: invalid SDP answer logs set-remote failure, never shows Live, and leaves Retry visible', async ({
    page,
    whepErrorLedger,
    whepErrorServer,
  }) => {
    await whepErrorServer.setMode('invalid-sdp')
    await openWatch(page)

    await expectOfflineRetry(page)
    await expect(page.getByText(/^Live$/)).toHaveCount(0)
    await expect
      .poll(async () => {
        const events = await whepErrorServer.readServerEvents()
        return events.filter((event) => event.event === 'start').length
      })
      .toBe(1)

    expect(whepErrorLedger.responsePosts.map((post) => post.status)).toEqual([201])
    expect(consoleText(whepErrorLedger)).toContain('webrtc:set-remote-failed')
  })
})
