import { expect, loginOnRealOrigin, test } from '../whepLive'
import type { Page, WhepLiveLedger } from '../whepLive'

const HAVE_CURRENT_DATA = 2
const QUALITY_STORAGE_KEY = 'homecam:streamQuality'

type LiveRung = {
  title: string
  optionName: RegExp
  expectedPath: string
  preseedQuality?: string
}

test.skip(
  process.env.HOMECAM_LIVE_WHEP !== '1',
  'Set HOMECAM_LIVE_WHEP=1 to run the live WHEP smoke against the real origin.',
)

test.describe('WHEP live smoke', () => {
  async function selectQuality(page: Page, name: RegExp) {
    await page.getByRole('button', { name: 'Stream quality' }).click()
    await page.getByRole('option', { name }).click()
  }

  async function expectNextPresentedFrame(
    page: Page,
  ): Promise<void> {
    await expect
      .poll(
        async () =>
          await page.getByLabel('Live camera feed').evaluate((node) => {
            const video = node as HTMLVideoElement & {
              requestVideoFrameCallback?: (callback: () => void) => number
            }

            if (typeof video.requestVideoFrameCallback !== 'function') {
              return (
                video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
                video.videoWidth > 0
              )
            }

            return new Promise<boolean>((resolve) => {
              const timer = window.setTimeout(() => resolve(false), 7_500)
              video.requestVideoFrameCallback(() => {
                window.clearTimeout(timer)
                resolve(video.videoWidth > 0)
              })
            })
          }),
        {
          message: 'wait for first presented frame after selected rung POST',
          timeout: 8_000,
        },
      )
      .toBe(true)
  }

  async function runLiveRung({
    page,
    whepLedger,
    rung,
  }: {
    page: Page
    whepLedger: WhepLiveLedger
    rung: LiveRung
  }) {
    if (rung.preseedQuality) {
      await page.addInitScript(
        ({ key, value }) => {
          window.localStorage.setItem(key, value)
        },
        { key: QUALITY_STORAGE_KEY, value: rung.preseedQuality },
      )
    }

    await loginOnRealOrigin(page)
    await expect(page.getByRole('button', { name: 'Stream quality' })).toBeVisible()

    const postsBefore = whepLedger.whepPosts.length
    await selectQuality(page, rung.optionName)

    await expect
      .poll(
        () =>
          whepLedger.whepPosts
            .slice(postsBefore)
            .some((post) => post.path === rung.expectedPath),
        {
          message: `record WHEP POST to ${rung.expectedPath}`,
          timeout: 8_000,
        },
      )
      .toBe(true)

    await expectNextPresentedFrame(page)
  }

  test('given login on the real origin, when Watch loads, then a real first frame arrives before the LIVE pill is accepted', async ({
    page,
    whepLedger,
  }) => {
    await loginOnRealOrigin(page)

    const video = page.getByLabel('Live camera feed')
    await expect(video).toBeVisible()

    const immediateEvidence = await video.evaluate((node) => {
      const videoNode = node as HTMLVideoElement
      return {
        readyState: videoNode.readyState,
        videoWidth: videoNode.videoWidth,
        videoHeight: videoNode.videoHeight,
      }
    })
    if (
      immediateEvidence.readyState < HAVE_CURRENT_DATA ||
      immediateEvidence.videoWidth <= 0
    ) {
      await expect(page.getByText('LIVE', { exact: true })).toHaveCount(0)
    }

    await expect
      .poll(
        async () =>
          await video.evaluate((node) => {
            const videoNode = node as HTMLVideoElement
            return (
              videoNode.readyState >= 2 &&
              videoNode.videoWidth > 0
            )
          }),
        {
          message: 'wait for decoded live video frame evidence',
          timeout: 12_000,
        },
      )
      .toBe(true)

    const frameEvidence = await video.evaluate((node) => {
      const videoNode = node as HTMLVideoElement
      return {
        readyState: videoNode.readyState,
        videoWidth: videoNode.videoWidth,
        videoHeight: videoNode.videoHeight,
      }
    })
    expect(frameEvidence.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA)
    expect(frameEvidence.videoWidth).toBeGreaterThan(0)

    await expect(page.getByText('Live', { exact: true })).toBeVisible({
      timeout: 5_000,
    })

    const probe = await page.evaluate(() => {
      return (
        (
          window as unknown as {
            __homecamWhepFrameProbe?: {
              firstFrameAt: number | null
              livePillAt: number | null
            }
          }
        ).__homecamWhepFrameProbe ?? {
          firstFrameAt: null,
          livePillAt: null,
        }
      )
    })

    expect(probe.firstFrameAt).not.toBeNull()
    expect(probe.livePillAt).not.toBeNull()
    expect(probe.livePillAt).toBeGreaterThanOrEqual(probe.firstFrameAt ?? 0)

    await expect
      .poll(() => whepLedger.whepPosts.length, {
        message: 'record at least one WHEP POST in the attempt ledger',
        timeout: 1_000,
      })
      .toBeGreaterThan(0)
  })

  const liveRungs: LiveRung[] = [
    {
      title: 'W4: rung hq posts /whep/cam/whep and presents a first frame within 8s',
      optionName: /^HQ\b/,
      expectedPath: '/whep/cam/whep',
      preseedQuality: 'sd',
    },
    {
      title: 'W5: rung sd posts /whep/cam_lq/whep and presents a first frame within 8s',
      optionName: /^Data-saver\b/,
      expectedPath: '/whep/cam_lq/whep',
    },
    {
      title: 'W6: rung xs posts /whep/cam_uq/whep and presents a first frame within 8s',
      optionName: /^Ultra-low\b/,
      expectedPath: '/whep/cam_uq/whep',
    },
  ]

  for (const rung of liveRungs) {
    test(rung.title, async ({ page, whepLedger }) => {
      await runLiveRung({ page, whepLedger, rung })
    })
  }
})
