import { test as base, expect, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

type WhepPost = {
  path: string
  status: number | null
  startTime: number
  responseEnd: number
  durationMs: number | null
}

type ConsoleMarker = {
  type: string
  text: string
  timestamp: number
}

type BrowserFrameProbe = {
  firstFrameAt: number | null
  livePillAt: number | null
  samples: Array<{
    timestamp: number
    readyState: number
    videoWidth: number
    videoHeight: number
  }>
}

export type WhepLiveLedger = {
  origin: string
  whepPosts: WhepPost[]
  consoleWebrtcMarkers: ConsoleMarker[]
  frameProbe: BrowserFrameProbe
}

type WhepLiveFixtures = {
  whepLedger: WhepLiveLedger
}

const WHEP_LIVE_ENABLED = process.env.HOMECAM_LIVE_WHEP === '1'

function safeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function requireLiveCredentials(): { username: string; password: string } {
  const username = process.env.HOMECAM_LIVE_USER
  const password = process.env.HOMECAM_LIVE_PASS

  if (!username || !password) {
    throw new Error(
      'HOMECAM_LIVE_USER and HOMECAM_LIVE_PASS are required when HOMECAM_LIVE_WHEP=1',
    )
  }

  return { username, password }
}

async function installFrameProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Probe = {
      firstFrameAt: number | null
      livePillAt: number | null
      samples: Array<{
        timestamp: number
        readyState: number
        videoWidth: number
        videoHeight: number
      }>
    }

    const win = window as unknown as { __homecamWhepFrameProbe?: Probe }
    if (win.__homecamWhepFrameProbe) return

    const probe: Probe = {
      firstFrameAt: null,
      livePillAt: null,
      samples: [],
    }
    win.__homecamWhepFrameProbe = probe

    const now = () => performance.timeOrigin + performance.now()

    const scan = () => {
      const timestamp = now()
      const video = document.querySelector(
        'video[aria-label="Live camera feed"]',
      ) as HTMLVideoElement | null

      if (video) {
        const sample = {
          timestamp,
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        }
        if (probe.samples.length < 200) probe.samples.push(sample)

        if (
          probe.firstFrameAt === null &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.videoWidth > 0
        ) {
          probe.firstFrameAt = timestamp
        }
      }

      // VideoTile's connection pill renders exactly 'Live' on its own line.
      // A word-boundary regex is WRONG here: the header's static "Live now"
      // chip matches from page load, long before any frame.
      if (
        probe.livePillAt === null &&
        document.body.innerText
          .split('\n')
          .some((line) => line.trim() === 'Live')
      ) {
        probe.livePillAt = timestamp
      }

      requestAnimationFrame(scan)
    }

    requestAnimationFrame(scan)
  })
}

export const test = base.extend<WhepLiveFixtures>({
  whepLedger: async ({ baseURL }, use, testInfo) => {
    test.skip(
      !WHEP_LIVE_ENABLED,
      'Set HOMECAM_LIVE_WHEP=1 to run the live WHEP smoke against the real origin.',
    )

    const ledger: WhepLiveLedger = {
      origin: String(baseURL),
      whepPosts: [],
      consoleWebrtcMarkers: [],
      frameProbe: {
        firstFrameAt: null,
        livePillAt: null,
        samples: [],
      },
    }

    await use(ledger)

    const root = await mkdtemp(path.join(tmpdir(), 'homecam-whep-live-'))
    const runName = safeTitle(testInfo.title) || 'whep-live'
    const ledgerPath = path.join(root, `${runName}.ledger.json`)
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    testInfo.attachments.push({
      name: 'whep-live-ledger',
      path: ledgerPath,
      contentType: 'application/json',
    })

    if (process.env.HOMECAM_E2E_KEEP_TMP !== '1') {
      await rm(root, { recursive: true, force: true })
    }
  },

  page: async ({ page, whepLedger }, use) => {
    await installFrameProbe(page)

    page.on('console', (message) => {
      const text = message.text()
      if (/(webrtc|whep|videoTile)/i.test(text)) {
        whepLedger.consoleWebrtcMarkers.push({
          type: message.type(),
          text,
          timestamp: Date.now(),
        })
      }
    })

    page.on('response', (response) => {
      const request = response.request()
      if (request.serviceWorker()) return
      if (request.method() !== 'POST') return

      const parsed = new URL(response.url())
      if (!parsed.pathname.includes('/whep/')) return

      const timing = request.timing()
      const responseEnd = timing.responseEnd
      const startTime = timing.startTime
      whepLedger.whepPosts.push({
        path: parsed.pathname,
        status: response.status(),
        startTime,
        responseEnd,
        durationMs: Number.isFinite(responseEnd) ? Math.max(0, responseEnd) : null,
      })
    })

    try {
      await use(page)
    } finally {
      try {
        whepLedger.frameProbe = await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamWhepFrameProbe?: BrowserFrameProbe
              }
            ).__homecamWhepFrameProbe ?? {
              firstFrameAt: null,
              livePillAt: null,
              samples: [],
            }
          )
        })
      } catch {
        whepLedger.frameProbe = {
          firstFrameAt: null,
          livePillAt: null,
          samples: [],
        }
      }
    }
  },
})

export async function loginOnRealOrigin(page: Page): Promise<void> {
  const { username, password } = requireLiveCredentials()

  await page.goto('/login')
  await page.getByLabel(/username/i).fill(username)
  // getByLabel(/password/i) also matches the Show-password toggle.
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in|log in|login/i }).click()
  await expect(page).toHaveURL(/\/(?:live)?$/)
}

export { expect, type Page }
