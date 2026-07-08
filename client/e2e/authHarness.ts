import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

type AuthHarnessServer = {
  baseURL: string
  healthzStatus: number
  jwtSecretPath: string
  ledgerPath: string
  logPath: string
  root: string
}

export type AuthHarnessLedger = {
  rest_rejections: Array<{ method: string; path: string; status: 401 }>
  refresh_attempts: number[]
  ws_closes: Array<{ code: number }>
  final_url_kind: 'authed' | 'login-expired' | 'login'
  /** Clear collected entries — call after login so a scenario's ledger
   *  excludes the anon boot-phase 401s (unread_count, initial /me, the
   *  boot refresh attempt). */
  reset: () => void
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(clientRoot, '..')
const serverRoot = path.join(repoRoot, 'server')
const clientDist = path.join(clientRoot, 'dist')
const pythonBin = '/tmp/homecam-venv/bin/python'

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('failed to allocate TCP port'))
        }
      })
    })
  })
}

async function execPython(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      pythonBin,
      args,
      { cwd: serverRoot, env },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${pythonBin} ${args.join(' ')} failed\n${stdout}\n${stderr}`,
            ),
          )
          return
        }
        resolve()
      },
    )
  })
}

async function waitForHealthz(baseURL: string, logPath: string): Promise<number> {
  const deadline = Date.now() + 30_000
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (res.status === 200) {
        return res.status
      }
      lastError = new Error(`/healthz returned ${res.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  let logTail = ''
  try {
    const logText = await readFile(logPath, 'utf8')
    logTail = logText.split('\n').slice(-80).join('\n')
  } catch {
    logTail = '(log unavailable)'
  }
  throw new Error(
    `uvicorn did not become ready at ${baseURL}/healthz: ${String(
      lastError,
    )}\n${logTail}`,
  )
}

function safeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function classifyFinalUrl(url: string): AuthHarnessLedger['final_url_kind'] {
  const parsed = new URL(url)
  if (parsed.pathname !== '/login') {
    return 'authed'
  }
  return parsed.searchParams.get('expired') === '1' ? 'login-expired' : 'login'
}

async function installWebSocketProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (
      (
        window as unknown as {
          __homecamWsProbe?: unknown
        }
      ).__homecamWsProbe
    ) {
      return
    }

    const NativeWebSocket = window.WebSocket
    type WsProbeRecord = {
      url: string
      opens: number
      closes: Array<{ code: number; reason: string }>
    }
    const records: WsProbeRecord[] = []
    const sockets: WebSocket[] = []

    Object.defineProperty(window, '__homecamWsProbe', {
      configurable: true,
      value: {
        records,
        closeLast() {
          const ws = sockets[sockets.length - 1]
          if (
            ws &&
            ws.readyState !== NativeWebSocket.CLOSED &&
            ws.readyState !== NativeWebSocket.CLOSING
          ) {
            ws.close(4000, 'e2e stale reconnect')
          }
        },
      },
    })

    window.WebSocket = class HomecamE2EWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) {
          super(url)
        } else {
          super(url, protocols)
        }
        const record: WsProbeRecord = { url: String(url), opens: 0, closes: [] }
        records.push(record)
        sockets.push(this)
        this.addEventListener('open', () => {
          record.opens += 1
        })
        this.addEventListener('close', (event) => {
          record.closes.push({ code: event.code, reason: event.reason })
        })
      }
    } as typeof WebSocket
  })
}

export const test = base.extend<
  { authLedger: AuthHarnessLedger; authServer: AuthHarnessServer },
  Record<string, never>
>({
  authLedger: async ({}, use) => {
    const ledger: AuthHarnessLedger = {
      rest_rejections: [],
      refresh_attempts: [],
      ws_closes: [],
      final_url_kind: 'authed',
      reset() {
        ledger.rest_rejections.length = 0
        ledger.refresh_attempts.length = 0
        ledger.ws_closes.length = 0
      },
    }
    await use(ledger)
  },

  authServer: async ({}, use, testInfo) => {
    const root = await mkdtemp(path.join(tmpdir(), 'homecam-auth-e2e-'))
    const runName = safeTitle(testInfo.title) || 'auth-harness'
    const logPath = path.join(root, `${runName}.log`)
    const ledgerPath = path.join(root, `${runName}.ledger.json`)
    const log = createWriteStream(logPath, { flags: 'a' })
    const port = await getFreePort()
    const baseURL = `http://127.0.0.1:${port}`

    const dirs = {
      snapshots: path.join(root, 'snapshots'),
      recordings: path.join(root, 'recordings'),
      timelapses: path.join(root, 'timelapses'),
      backups: path.join(root, 'backups'),
      faceCaptures: path.join(root, 'face_captures'),
      personCaptures: path.join(root, 'person_captures'),
    }
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))

    const jwtSecretPath = path.join(root, 'jwt_secret.bin')
    const env = {
      ...process.env,
      HOMECAM_SIMULATOR: '1',
      HOMECAM_LOG_LEVEL: 'INFO',
      PORT: String(port),
      CLIENT_DIST: clientDist,
      USERS_DB_PATH: path.join(root, 'users.db'),
      JWT_SECRET_PATH: jwtSecretPath,
      ACCESS_TOKEN_TTL_S: '3',
      REFRESH_TOKEN_TTL_S: '20',
      COOKIE_SECURE: 'false',
      RECORDINGS_DIR: dirs.recordings,
      SNAPSHOTS_DIR: dirs.snapshots,
      TIMELAPSES_DIR: dirs.timelapses,
      BACKUP_TARGET_DIR: dirs.backups,
      FACE_CAPTURES_DIR: dirs.faceCaptures,
      PERSON_CAPTURES_DIR: dirs.personCaptures,
      EVENTS_DB_PATH: path.join(root, 'events.db'),
      PUSH_SUBS_PATH: path.join(root, 'push_subs.json'),
      DETECTION_CONFIG_PATH: path.join(root, 'detection_config.json'),
      VAPID_PRIVATE_KEY_PATH: path.join(root, 'vapid_private.pem'),
      VAPID_PUBLIC_KEY_PATH: path.join(root, 'vapid_public.pem'),
    }

    await execPython(['-m', 'app.scripts.gen_vapid'], env)
    await execPython(
      [
        '-c',
        [
          'from pathlib import Path',
          'import os',
          'from app.auth import passwords, users_db',
          'db = Path(os.environ["USERS_DB_PATH"])',
          'users_db.init_db(db)',
          'users_db.create_user(db, "admin", passwords.hash_password("admin"), role="owner")',
        ].join('; '),
      ],
      env,
    )

    const proc = spawn(
      pythonBin,
      [
        '-m',
        'uvicorn',
        'app.main:app',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-level',
        'info',
      ],
      { cwd: serverRoot, env },
    )
    proc.stdout.pipe(log, { end: false })
    proc.stderr.pipe(log, { end: false })

    try {
      const healthzStatus = await waitForHealthz(baseURL, logPath)
      await use({
        baseURL,
        healthzStatus,
        jwtSecretPath,
        ledgerPath,
        logPath,
        root,
      })
    } finally {
      testInfo.attachments.push({
        name: 'auth-harness-log',
        path: logPath,
        contentType: 'text/plain',
      })
      if (!proc.killed) {
        proc.kill('SIGTERM')
      }
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL')
          }
          resolve()
        }, 5_000)
      })
      log.end()
      // HOMECAM_E2E_KEEP_TMP=1 preserves the scratch dir (uvicorn log +
      // ledger) for post-mortem — Playwright's attachment references the
      // path, so deleting it makes failures undebuggable.
      if (process.env.HOMECAM_E2E_KEEP_TMP !== '1') {
        await rm(root, { recursive: true, force: true })
      }
    }
  },

  baseURL: async ({ authServer }, use) => {
    await use(authServer.baseURL)
  },

  page: async ({ page, authLedger, authServer }, use, testInfo) => {
    await installWebSocketProbe(page)

    page.on('response', (response) => {
      const request = response.request()
      // The PWA's service worker proxies fetches, so one network request can
      // surface twice (page fetch + SW passthrough). Count each once or the
      // ledger double-counts against the server's auth_rejected lines.
      if (request.serviceWorker()) return
      const parsed = new URL(response.url())
      const method = request.method()
      const path = parsed.pathname
      const status = response.status()

      if (method === 'POST' && path === '/api/auth/refresh') {
        authLedger.refresh_attempts.push(status)
      }
      if (status === 401) {
        authLedger.rest_rejections.push({ method, path, status })
      }
    })

    try {
      await use(page)
    } finally {
      try {
        authLedger.ws_closes = await page.evaluate(() => {
          const records =
            (
              window as unknown as {
                __homecamWsProbe?: {
                  records: Array<{
                    closes: Array<{ code: number }>
                  }>
                }
              }
            ).__homecamWsProbe?.records ?? []
          return records.flatMap((record) =>
            record.closes.map((close) => ({ code: close.code })),
          )
        })
      } catch {
        authLedger.ws_closes = []
      }

      try {
        authLedger.final_url_kind = classifyFinalUrl(page.url())
      } catch {
        authLedger.final_url_kind = 'authed'
      }

      await writeFile(
        authServer.ledgerPath,
        `${JSON.stringify(authLedger, null, 2)}\n`,
        'utf8',
      )
      testInfo.attachments.push({
        name: 'auth-harness-ledger',
        path: authServer.ledgerPath,
        contentType: 'application/json',
      })
    }
  },
})

export { expect, type Page }
