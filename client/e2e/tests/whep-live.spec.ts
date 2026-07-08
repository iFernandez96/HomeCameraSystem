import { expect, loginOnRealOrigin, test } from '../whepLive'

const HAVE_CURRENT_DATA = 2

test.skip(
  process.env.HOMECAM_LIVE_WHEP !== '1',
  'Set HOMECAM_LIVE_WHEP=1 to run the live WHEP smoke against the real origin.',
)

test.describe('WHEP live smoke', () => {
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
})
