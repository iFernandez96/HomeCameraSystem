import { test, expect } from '../authHarness'
import type { AuthHarnessLedger } from '../authHarness'
import type { Cookie, Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const ACCESS_COOKIE = 'homecam_access'
const REFRESH_COOKIE = 'homecam_refresh'
const ACCESS_TOKEN_TTL_S = 3
const REFRESH_TOKEN_TTL_S = 20
const COOKIE_EXPIRY_TOLERANCE_S = 3
const EVENTS_WS_PATH = '/api/events/ws'
const AUTH_REJECTED_RE =
  /auth rejected on (?<method>\S+) (?<route>\S+): (?<reason>.*?) \(sub=.*? cookie_present=(?<cookie_present>True|False)\)/

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/')

  await page.getByLabel(/username/i).fill('admin')
  await page.getByRole('textbox', { name: /password/i }).fill('admin')
  await page.getByRole('button', { name: /sign in|log in|login/i }).click()

  // The authed landing route is "/" (App.tsx routes /live -> Navigate to "/").
  await expect(page).toHaveURL(/\/$/)
  // BottomNav labels are Home/Events/Faces/Settings (Playroom pebble bar).
  await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /events/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /settings/i })).toBeVisible()
}

async function authCookies(
  page: Page,
  baseURL: string,
): Promise<{ accessCookie: Cookie; refreshCookie: Cookie }> {
  const cookies = await page.context().cookies(`${baseURL}/api/auth/me`)
  const authCookies = new Map(cookies.map((cookie) => [cookie.name, cookie]))
  const accessCookie = authCookies.get(ACCESS_COOKIE)
  const refreshCookie = authCookies.get(REFRESH_COOKIE)

  expect(accessCookie, `${ACCESS_COOKIE} cookie metadata`).toBeDefined()
  expect(refreshCookie, `${REFRESH_COOKIE} cookie metadata`).toBeDefined()

  return {
    accessCookie: accessCookie!,
    refreshCookie: refreshCookie!,
  }
}

async function expectSessionExpiredViaBoundedRefresh401(
  page: Page,
  refreshResponses: number[],
  // Pre-redirect attempts scale with how many independent consumers 401
  // while the redirect is in flight (each retries once); the WS variant
  // adds the auth-failed /me path on top of the status polls.
  maxAttempts = 3,
): Promise<void> {
  await expect
    .poll(() => refreshResponses.length, { timeout: 10_000 })
    .toBeGreaterThan(0)
  expect(refreshResponses.every((status) => status === 401)).toBe(true)
  expect(refreshResponses.length).toBeLessThanOrEqual(maxAttempts)
  await expect(page).toHaveURL(/\/login\?expired=1$/)
  await expect(
    page.getByText("You've been signed out for security."),
  ).toBeVisible()

  // The true no-storm invariant: once the app has landed on the login
  // page, refresh attempts stop growing entirely.
  const settled = refreshResponses.length
  await page.waitForTimeout(3_000)
  expect(refreshResponses.length).toBe(settled)
}

async function readScratchAuthRejections(
  logPath: string,
): Promise<Array<{ method: string; route: string; cookie_present: boolean }>> {
  const logText = await readFile(logPath, 'utf8')
  return logText
    .split('\n')
    .map((line) => AUTH_REJECTED_RE.exec(line))
    .filter((match): match is RegExpExecArray & {
      groups: {
        method: string
        route: string
        reason: string
        cookie_present: 'True' | 'False'
      }
    } => Boolean(match?.groups))
    .map((match) => ({
      method: match.groups.method,
      route: match.groups.route,
      cookie_present: match.groups.cookie_present === 'True',
    }))
}

async function expectBrowser401sMatchScratchAuthRejected(
  ledger: AuthHarnessLedger,
  logPath: string,
): Promise<void> {
  // Parity plane is method+path counts only. The browser cannot observe
  // cookie_present (the cookies are HttpOnly), and it would guess wrong
  // anyway: Chromium DELETES the access cookie once its Max-Age passes, so
  // an expired-session 401 reaches the server as "no cookie"
  // (cookie_present=False), not "Signature has expired". The flag stays a
  // server-side detail (pinned by test_a13_parity_auth_rejected.py).
  const expectedCounts = new Map<string, number>()
  for (const rejection of ledger.rest_rejections) {
    const key = `${rejection.method} ${rejection.path}`
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1)
  }

  await expect
    .poll(async () => {
      const actualCounts = new Map<string, number>()
      for (const rejection of await readScratchAuthRejections(logPath)) {
        const key = `${rejection.method} ${rejection.route}`
        actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1)
      }
      return [...expectedCounts].map(([key, count]) => ({
        key,
        browser: count,
        server: actualCounts.get(key) ?? 0,
        ok: (actualCounts.get(key) ?? 0) >= count,
      }))
    }, {
      timeout: 10_000,
    })
    .toEqual(
      [...expectedCounts].map(([key, count]) => ({
        key,
        browser: count,
        server: expect.any(Number),
        ok: true,
      })),
    )
}

test.describe('Auth session lifecycle harness', () => {
  test.skip(
    !process.env.CI && process.env.HOMECAM_RUN_REAL_BROWSER_AUTH !== '1',
    'set HOMECAM_RUN_REAL_BROWSER_AUTH=1 to run the real-browser auth harness locally',
  )

  test('given the harness boots, when Chromium opens baseURL, then login page renders and healthz is ready', async ({
    authServer,
    page,
  }) => {
    expect(authServer.healthzStatus).toBe(200)

    await page.goto('/')

    await expect(page).toHaveTitle(/HomeCam/)
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel(/username/i)).toBeVisible()
    // getByLabel(/password/i) is ambiguous here: the Show-password toggle's
    // aria-label also matches. Target the textbox role explicitly.
    await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('given default TTLs, when seeded user logs in through the real form, then auth cookies match the browser contract', async ({
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)

    const { accessCookie, refreshCookie } = await authCookies(
      page,
      authServer.baseURL,
    )

    for (const cookie of [accessCookie, refreshCookie]) {
      expect(cookie.path).toBe('/api')
      expect(cookie.httpOnly).toBe(true)
      expect(cookie.sameSite).toBe('Strict')
      expect(cookie.expires).toBeGreaterThan(0)
    }

    const ttlDifference = REFRESH_TOKEN_TTL_S - ACCESS_TOKEN_TTL_S
    expect(
      Math.abs(refreshCookie.expires - accessCookie.expires - ttlDifference),
    ).toBeLessThanOrEqual(COOKIE_EXPIRY_TOLERANCE_S)
  })

  test('given a logged-in session, when access TTL elapses and the next API round-trip runs, then auth refresh rotates both cookies', async ({
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)

    const original = await authCookies(page, authServer.baseURL)
    const refreshResponses: number[] = []
    page.on('response', (response) => {
      const request = response.request()
      if (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/refresh'
      ) {
        refreshResponses.push(response.status())
      }
    })

    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 0.5) * 1_000)
    await page.getByRole('link', { name: /events/i }).click()

    await expect
      .poll(() => refreshResponses, { timeout: 10_000 })
      .toEqual([200])
    await expect(page).not.toHaveURL(/\/login(?:$|[/?#])/)
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /events/i })).toBeVisible()

    const rotated = await authCookies(page, authServer.baseURL)
    expect(rotated.accessCookie.expires).toBeGreaterThan(
      original.accessCookie.expires,
    )
    expect(rotated.refreshCookie.expires).toBeGreaterThan(
      original.refreshCookie.expires,
    )
  })

  test('given a logged-in session, when mobile resume happens after access expiry but before refresh expiry, then the app self-heals without sign-out', async ({
    page,
  }) => {
    await loginAsAdmin(page)

    const refreshResponses: number[] = []
    const unauthorizedResponses: string[] = []
    page.on('response', (response) => {
      const request = response.request()
      const pathname = new URL(response.url()).pathname
      if (request.method() === 'POST' && pathname === '/api/auth/refresh') {
        refreshResponses.push(response.status())
      }
      if (response.status() === 401) {
        unauthorizedResponses.push(`${request.method()} ${pathname}`)
      }
    })

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 3) * 1_000)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expect
      .poll(() => refreshResponses.includes(200), { timeout: 10_000 })
      .toBe(true)
    // Reactive refresh means data requests legitimately 401 first — that 401
    // IS the refresh trigger, and api.ts retries them after rotating. The
    // sign-out invariant is that the refresh endpoint itself never 401s.
    expect(unauthorizedResponses).not.toContain('POST /api/auth/refresh')
    expect(refreshResponses.every((status) => status === 200)).toBe(true)
    await expect(page).not.toHaveURL(/\/login(?:$|[/?#])/)
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /events/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible()
  })

  test('given mobile resume self-heals through real 401s, when the ledger is compared to scratch logs, then browser and server auth rejection planes agree', async ({
    authLedger,
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)
    // Scope the ledger to this scenario: the anon boot phase legitimately
    // 401s (unread_count, initial /me, one boot refresh attempt) before
    // login and would pollute the parity plane.
    authLedger.reset()

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 3) * 1_000)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expect
      .poll(() => authLedger.refresh_attempts.includes(200), { timeout: 10_000 })
      .toBe(true)
    expect(authLedger.rest_rejections.length).toBeGreaterThan(0)
    expect(authLedger.rest_rejections).not.toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/auth/refresh' }),
    )
    await expect(page).not.toHaveURL(/\/login(?:$|[/?#])/)
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible()

    await expectBrowser401sMatchScratchAuthRejected(
      authLedger,
      authServer.logPath,
    )
  })

  test('given events WS is connected, when access expires and a stale reconnect gets 1008, then auth self-heals without sign-out', async ({
    page,
  }) => {
    const playwrightWsUrls: string[] = []
    const refreshResponses: number[] = []
    const consoleMessages: string[] = []

    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname === EVENTS_WS_PATH) {
        playwrightWsUrls.push(ws.url())
      }
    })
    page.on('response', (response) => {
      const request = response.request()
      const pathname = new URL(response.url()).pathname
      if (request.method() === 'POST' && pathname === '/api/auth/refresh') {
        refreshResponses.push(response.status())
      }
    })
    page.on('console', (message) => {
      consoleMessages.push(message.text())
    })

    await loginAsAdmin(page)
    await page.getByRole('link', { name: /events/i }).click()

    await expect
      .poll(
        async () =>
          await page.evaluate(
            (eventsWsPath) =>
              (
                window as unknown as {
                  __homecamWsProbe?: {
                    records: Array<{ url: string; opens: number }>
                  }
                }
              ).__homecamWsProbe?.records.some(
                (record) =>
                  new URL(record.url).pathname === eventsWsPath &&
                  record.opens > 0,
              ) ?? false,
            EVENTS_WS_PATH,
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
    expect(playwrightWsUrls.length).toBeGreaterThan(0)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 0.5) * 1_000)
    await page.evaluate(() => {
      (
        window as unknown as {
          __homecamWsProbe?: { closeLast: () => void }
        }
      ).__homecamWsProbe?.closeLast()
    })

    await expect
      .poll(
        async () =>
          await page.evaluate(
            (eventsWsPath) =>
              (
                window as unknown as {
                  __homecamWsProbe?: {
                    records: Array<{
                      url: string
                      closes: Array<{ code: number; reason: string }>
                    }>
                  }
                }
              ).__homecamWsProbe?.records.some(
                (record) =>
                  new URL(record.url).pathname === eventsWsPath &&
                  record.closes.some((close) => close.code === 1008),
              ) ?? false,
            EVENTS_WS_PATH,
          ),
        { timeout: 10_000 },
      )
      .toBe(true)
    await expect
      .poll(() => refreshResponses, { timeout: 10_000 })
      .toContain(200)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expect(page).not.toHaveURL(/\/login(?:$|[/?#])/)
    await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /events/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible()
    expect(consoleMessages.some((text) => text.includes('auth:self-heal-ok'))).toBe(
      true,
    )
  })

  test('given a logged-in session, when both tokens expire and the next app interaction runs, then session-expired UX is reached', async ({
    page,
  }) => {
    await loginAsAdmin(page)

    const refreshResponses: number[] = []
    page.on('response', (response) => {
      const request = response.request()
      if (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/refresh'
      ) {
        refreshResponses.push(response.status())
      }
    })

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await page.waitForTimeout((REFRESH_TOKEN_TTL_S + 1) * 1_000)
    await page.getByRole('link', { name: /events/i }).click()

    // Each independent 401'd request retries refresh once (api.ts contract),
    // so the status poll and the navigation fetch can each contribute one
    // attempt. The invariant: every attempt 401s (never a late 200) and the
    // count stays bounded — not exactly one.
    await expectSessionExpiredViaBoundedRefresh401(page, refreshResponses)
  })

  test('given a logged-in session, when the JWT secret rotates and the next API round-trip runs after access expiry, then session-expired UX is reached', async ({
    authServer,
    page,
  }) => {
    await loginAsAdmin(page)

    const refreshResponses: number[] = []
    page.on('response', (response) => {
      const request = response.request()
      if (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/refresh'
      ) {
        refreshResponses.push(response.status())
      }
    })

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await writeFile(authServer.jwtSecretPath, randomBytes(32), { mode: 0o600 })
    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 0.5) * 1_000)

    // Don't click a nav link here: background traffic (WS reconnect /
    // residual poll) can hit the rotated secret during the wait and the app
    // may already be on /login, making the link vanish before the click.
    // Restoring visibility is the natural resume round-trip either way.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expectSessionExpiredViaBoundedRefresh401(page, refreshResponses)
  })

  test('given events WS is connected, when the JWT secret rotates and the socket reconnects, then session-expired UX is reached without a reconnect storm', async ({
    authServer,
    page,
  }) => {
    const refreshResponses: number[] = []
    page.on('response', (response) => {
      const request = response.request()
      if (
        request.method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/refresh'
      ) {
        refreshResponses.push(response.status())
      }
    })

    await loginAsAdmin(page)
    await page.getByRole('link', { name: /events/i }).click()

    await expect
      .poll(
        async () =>
          await page.evaluate(
            (eventsWsPath) =>
              (
                window as unknown as {
                  __homecamWsProbe?: {
                    records: Array<{ url: string; opens: number }>
                  }
                }
              ).__homecamWsProbe?.records.some(
                (record) =>
                  new URL(record.url).pathname === eventsWsPath &&
                  record.opens > 0,
              ) ?? false,
            EVENTS_WS_PATH,
          ),
        { timeout: 10_000 },
      )
      .toBe(true)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await writeFile(authServer.jwtSecretPath, randomBytes(32), { mode: 0o600 })
    await page.waitForTimeout((ACCESS_TOKEN_TTL_S + 0.5) * 1_000)
    await page.evaluate(() => {
      (
        window as unknown as {
          __homecamWsProbe?: { closeLast: () => void }
        }
      ).__homecamWsProbe?.closeLast()
    })

    await expect
      .poll(
        async () =>
          await page.evaluate((eventsWsPath) => {
            const records =
              (
                window as unknown as {
                  __homecamWsProbe?: {
                    records: Array<{
                      url: string
                      closes: Array<{ code: number; reason: string }>
                    }>
                  }
                }
              ).__homecamWsProbe?.records.filter(
                (record) => new URL(record.url).pathname === eventsWsPath,
              ) ?? []
            return records.findIndex((record) =>
              record.closes.some((close) => close.code === 1008),
            )
          }, EVENTS_WS_PATH),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(0)

    await expectSessionExpiredViaBoundedRefresh401(page, refreshResponses, 6)

    const wsAttemptsAfter1008 = await page.evaluate((eventsWsPath) => {
      const records =
        (
          window as unknown as {
            __homecamWsProbe?: {
              records: Array<{
                url: string
                closes: Array<{ code: number; reason: string }>
              }>
            }
          }
        ).__homecamWsProbe?.records.filter(
          (record) => new URL(record.url).pathname === eventsWsPath,
        ) ?? []
      const first1008Index = records.findIndex((record) =>
        record.closes.some((close) => close.code === 1008),
      )
      return first1008Index < 0 ? Number.POSITIVE_INFINITY : records.length - first1008Index - 1
    }, EVENTS_WS_PATH)
    expect(wsAttemptsAfter1008).toBeLessThanOrEqual(3)
  })
})
