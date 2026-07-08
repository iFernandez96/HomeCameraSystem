import { expect, loginAsAdmin, test, type Page } from '../multicamHarness'
import type { MulticamLedger } from '../multicamHarness'

const QUALITY_STORAGE_KEY = 'homecam:streamQuality'

async function openWatch(page: Page): Promise<void> {
  await loginAsAdmin(page)
  await expect(page.getByRole('radiogroup', { name: 'Switch camera' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stream quality' })).toBeVisible()
}

async function selectSynthCamera(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Synth' }).click()
  await expect(page.getByRole('radio', { name: 'Synth' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
}

async function selectQuality(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Stream quality' }).click()
  await page.getByRole('option', { name }).click()
}

async function waitForPost(
  ledger: MulticamLedger,
  expectedPath: string,
): Promise<void> {
  await expect
    .poll(
      () => ledger.whepPosts.some((post) => post.path === expectedPath),
      { timeout: 8_000, message: `record WHEP POST to ${expectedPath}` },
    )
    .toBe(true)
}

async function waitForPresentedFrame(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.getByLabel('Live camera feed').evaluate((node) => {
          const video = node as HTMLVideoElement
          return (
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth === 320 &&
            video.videoHeight === 240
          )
        }),
      { timeout: 12_000, message: 'wait for a real presented synth frame' },
    )
    .toBe(true)
}

test.describe('Harness #10 multicam synthetic WHEP', () => {
  test('M10.5: switching to the synth camera posts /whep/synth/whep and presents a real frame', async ({
    page,
    multicamLedger,
  }) => {
    await openWatch(page)

    await selectSynthCamera(page)

    await waitForPost(multicamLedger, '/whep/synth/whep')
    await waitForPresentedFrame(page)
    // multicamLedger.frameProbe is harvested at fixture teardown — mid-test
    // the probe must be read from the page directly.
    const firstFrameAt = await page.evaluate(
      () =>
        (
          window as unknown as {
            __homecamMulticamFrameProbe?: { firstFrameAt: number | null }
          }
        ).__homecamMulticamFrameProbe?.firstFrameAt ?? null,
    )
    expect(firstFrameAt).not.toBeNull()
  })

  test('M10.6: quality rung selection composes the non-default camera rung URL', async ({
    page,
    multicamLedger,
  }) => {
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: QUALITY_STORAGE_KEY, value: 'hq' },
    )
    await openWatch(page)
    await selectSynthCamera(page)
    await waitForPost(multicamLedger, '/whep/synth/whep')

    await selectQuality(page, /data-saver/i)

    await waitForPost(multicamLedger, '/whep/synth_lq/whep')
  })
})
