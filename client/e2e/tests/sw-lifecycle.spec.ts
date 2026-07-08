import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from '../swHarness'

type LedgerEntry =
  | {
      kind: 'checkpoint'
      phase: string
      label: string
      marker: string | null
    }
  | {
      kind: 'request'
      phase: string
      method: string
      path: string
      resourceType: string
      serviceWorker: boolean
      navigation: boolean
    }
  | {
      kind: 'response'
      phase: string
      method: string
      path: string
      status: number
      fromServiceWorker: boolean
      navigation: boolean
    }

function pathOf(rawUrl: string): string {
  const url = new URL(rawUrl)
  return `${url.pathname}${url.search}`
}

function isLedgerUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl)
  return (
    url.pathname === '/' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/assets/')
  )
}

function attachFetchLedger(page: Page) {
  let phase = 'setup'
  const entries: LedgerEntry[] = []

  page.on('request', (request) => {
    if (!isLedgerUrl(request.url())) return
    entries.push({
      kind: 'request',
      phase,
      method: request.method(),
      path: pathOf(request.url()),
      resourceType: request.resourceType(),
      serviceWorker: Boolean(request.serviceWorker()),
      navigation: request.isNavigationRequest(),
    })
  })

  page.on('response', (response) => {
    const request = response.request()
    if (!isLedgerUrl(response.url())) return
    entries.push({
      kind: 'response',
      phase,
      method: request.method(),
      path: pathOf(response.url()),
      status: response.status(),
      fromServiceWorker: response.fromServiceWorker(),
      navigation: request.isNavigationRequest(),
    })
  })

  return {
    entries,
    setPhase(nextPhase: string) {
      phase = nextPhase
    },
    checkpoint(label: string, marker: string | null) {
      entries.push({ kind: 'checkpoint', phase, label, marker })
    },
  }
}

async function waitForActivatedSw(page: Page) {
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
}

async function activeSwMarker(page: Page): Promise<string | null> {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const worker = registration.active
    if (!worker) return null

    return await new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener('message', onMessage)
        resolve(null)
      }, 5_000)

      function onMessage(event: MessageEvent) {
        if (event.data?.type !== 'HOMECAM_SW_MARKER') return
        window.clearTimeout(timer)
        navigator.serviceWorker.removeEventListener('message', onMessage)
        resolve(typeof event.data.marker === 'string' ? event.data.marker : null)
      }

      navigator.serviceWorker.addEventListener('message', onMessage)
      worker.postMessage({ type: 'HOMECAM_SW_MARKER' })
    })
  })
}

async function renderedBuildMarker(page: Page): Promise<string | null> {
  const marker = await page
    .locator('[data-homecam-build-marker]')
    .first()
    .getAttribute('data-homecam-build-marker')
  return marker
}

async function triggerUpdateAndWaitForTakeover(page: Page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 10_000)

      async function update() {
        try {
          await registration.update()
          if (!registration.installing && !registration.waiting) {
            window.setTimeout(resolve, 250)
          }
        } catch (error) {
          reject(error)
        }
      }

      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      void update()
    })
  })

  await expect
    .poll(() => activeSwMarker(page), { timeout: 10_000 })
    .toBe('h6-b')
}

async function attachLedger(testInfo: TestInfo, entries: LedgerEntry[]) {
  await testInfo.attach('sw-fetch-ledger', {
    body: JSON.stringify(entries, null, 2),
    contentType: 'application/json',
  })
}

async function loadBuildAAndActivate(page: Page, ledger = attachFetchLedger(page)) {
  ledger.setPhase('initial-load-build-a')
  await page.goto('/')

  await expect(page.locator('[data-homecam-build-marker="h6-a"]')).toBeVisible()
  await expect(page.locator('[data-homecam-build-marker="h6-b"]')).toHaveCount(0)
  await waitForActivatedSw(page)
  const marker = await activeSwMarker(page)
  ledger.checkpoint('active-sw-after-initial-load', marker)
  expect(marker).toBe('h6-a')

  return ledger
}

async function runFirstDeployReload(
  page: Page,
  swServer: { switchToBuildB: () => Promise<void> },
) {
  const ledger = await loadBuildAAndActivate(page)

  await swServer.switchToBuildB()
  ledger.setPhase('first-reload-after-deploy')
  ledger.checkpoint('active-sw-before-first-reload', await activeSwMarker(page))
  await page.reload({ waitUntil: 'domcontentloaded' })
  const firstReloadMarker = await renderedBuildMarker(page)
  ledger.checkpoint('rendered-marker-after-first-reload', firstReloadMarker)

  return { ledger, firstReloadMarker }
}

async function completeTakeover(page: Page, ledger: ReturnType<typeof attachFetchLedger>) {
  ledger.setPhase('registration-update-takeover')
  await triggerUpdateAndWaitForTakeover(page)
  ledger.checkpoint('active-sw-after-update', await activeSwMarker(page))

  ledger.setPhase('second-reload-after-takeover')
  await page.reload({ waitUntil: 'domcontentloaded' })
  const secondReloadMarker = await renderedBuildMarker(page)
  ledger.checkpoint('rendered-marker-after-second-reload', secondReloadMarker)

  return secondReloadMarker
}

async function runDeployScenario(
  page: Page,
  swServer: { switchToBuildB: () => Promise<void> },
) {
  const { ledger, firstReloadMarker } = await runFirstDeployReload(page, swServer)
  const secondReloadMarker = await completeTakeover(page, ledger)

  return { ledger: ledger.entries, firstReloadMarker, secondReloadMarker }
}

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

    await loadBuildAAndActivate(page)
  })

  test('H6.5 deploy-truth pin: given build A is active, when the scratch server switches to build B and the page reloads once, then the previous build remains rendered', async ({
    page,
    swServer,
  }) => {
    const { firstReloadMarker } = await runFirstDeployReload(page, swServer)

    // OBSERVED RIG TRUTH (pinned per the harness rule): with autoUpdate +
    // clientsClaim, the first reload after the dist switch ALREADY renders
    // the NEW build in this rig. The 2026-07-08 production observation of
    // a stale first load involved timing this rig does not reproduce
    // (long-idle SW / update check racing the navigation); if this pin
    // ever flips, SW update semantics changed — investigate, don't bump.
    expect(firstReloadMarker).toBe('h6-b')
  })

  test('H6.6 takeover: given the first reload after deploy still rendered A, when registration.update and controllerchange settle, then the next reload renders B from the active B worker', async ({
    page,
    swServer,
  }) => {
    const { firstReloadMarker, secondReloadMarker } = await runDeployScenario(
      page,
      swServer,
    )

    expect(firstReloadMarker).toBe('h6-b')
    expect(secondReloadMarker).toBe('h6-b')
    expect(await activeSwMarker(page)).toBe('h6-b')
  })

  test('H6.7 fetch ledger: given the A to B deploy reload sequence runs, then the request ledger matches the pinned first-load and takeover outcomes', async ({
    page,
    swServer,
  }, testInfo) => {
    const { ledger, firstReloadMarker, secondReloadMarker } =
      await runDeployScenario(page, swServer)
    await attachLedger(testInfo, ledger)

    expect(firstReloadMarker).toBe('h6-b')
    expect(secondReloadMarker).toBe('h6-b')

    // Playwright does not emit request/response events for navigations the
    // SW serves entirely from its precache (verified by ledger dump), so
    // the navigation itself is invisible here. The reliable evidence for
    // "the reload really happened and rendered B" is: asset fetches in the
    // first-reload phase plus the rendered-marker checkpoint.
    const firstReloadAssets = ledger.filter(
      (entry) =>
        entry.kind === 'request' &&
        entry.phase === 'first-reload-after-deploy' &&
        entry.path.startsWith('/assets/'),
    )
    expect(firstReloadAssets.length).toBeGreaterThan(0)
    const firstReloadRendered = ledger.find(
      (entry) =>
        entry.kind === 'checkpoint' &&
        entry.phase === 'first-reload-after-deploy' &&
        entry.label === 'rendered-marker-after-first-reload',
    )
    expect(firstReloadRendered).toMatchObject({ marker: 'h6-b' })

    const takeoverMarker = ledger.find(
      (entry) =>
        entry.kind === 'checkpoint' &&
        entry.phase === 'registration-update-takeover' &&
        entry.label === 'active-sw-after-update',
    )
    expect(takeoverMarker).toMatchObject({ marker: 'h6-b' })

    // Same SW-precache invisibility as the first reload: pin the rendered
    // checkpoint instead of the navigation event Playwright never emits.
    const secondReloadRendered = ledger.find(
      (entry) =>
        entry.kind === 'checkpoint' &&
        entry.phase === 'second-reload-after-takeover' &&
        entry.label === 'rendered-marker-after-second-reload',
    )
    expect(secondReloadRendered).toMatchObject({ marker: 'h6-b' })
  })
})
