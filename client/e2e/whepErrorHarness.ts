import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

export type WhepErrorMode =
  | '404'
  | '503'
  | 'hang'
  | 'network-close'
  | 'invalid-sdp'

type WhepServerEvent = {
  event: 'start' | 'done' | 'aborted'
  path: string
  mode: WhepErrorMode
  post_id: number
  status?: number
  timestamp: number
}

type ConsoleMarker = {
  type: string
  text: string
  timestamp: number
}

type BrowserPcProbe = {
  constructed: number
  closed: number
  active: number
}

export type WhepErrorLedger = {
  responsePosts: Array<{ path: string; status: number; timestamp: number }>
  consoleMarkers: ConsoleMarker[]
  pcProbe: BrowserPcProbe
}

type WhepErrorServer = {
  baseURL: string
  healthzStatus: number
  logPath: string
  root: string
  serverLedgerPath: string
  setMode: (mode: WhepErrorMode, path?: string) => Promise<void>
  readServerEvents: () => Promise<WhepServerEvent[]>
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
    server.on('error', (error) => {
      console.error(`SANDBOX-HANG failed to bind scratch TCP port: ${String(error)}`)
      reject(error)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to allocate TCP port'))
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
      if (res.status === 200) return res.status
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

async function readServerEvents(pathname: string): Promise<WhepServerEvent[]> {
  let raw = ''
  try {
    raw = await readFile(pathname, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WhepServerEvent)
}

async function installPeerConnectionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __homecamWhepPcProbe?: BrowserPcProbe
    }
    if (win.__homecamWhepPcProbe) return

    const NativeRTCPeerConnection = window.RTCPeerConnection
    const probe: BrowserPcProbe = { constructed: 0, closed: 0, active: 0 }
    win.__homecamWhepPcProbe = probe

    window.RTCPeerConnection = class HomecamE2ERtcPeerConnection extends NativeRTCPeerConnection {
      constructor(configuration?: RTCConfiguration) {
        super(configuration)
        probe.constructed += 1
        probe.active += 1
        const nativeClose = this.close.bind(this)
        let closed = false
        this.close = () => {
          if (!closed) {
            closed = true
            probe.closed += 1
            probe.active -= 1
            console.info(
              `e2e:whep-pc-close constructed=${probe.constructed} closed=${probe.closed} active=${probe.active}`,
            )
          }
          nativeClose()
        }
        console.info(
          `e2e:whep-pc-open constructed=${probe.constructed} closed=${probe.closed} active=${probe.active}`,
        )
      }
    } as typeof RTCPeerConnection
  })
}

async function writeWhepStubApp(modulePath: string): Promise<void> {
  await writeFile(
    modulePath,
    `
import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import Request

from app.main import app as real_app

_ledger_path = Path(os.environ["HOMECAM_WHEP_ERROR_LEDGER"])
_default_mode = os.environ.get("HOMECAM_WHEP_ERROR_MODE", "404")
_modes_by_path = json.loads(os.environ.get("HOMECAM_WHEP_ERROR_MODES", "{}"))
_post_id = 0


def _append(record):
    _ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with _ledger_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True) + "\\n")


@real_app.post("/__e2e/whep-mode")
async def set_whep_mode(request: Request):
    global _default_mode, _modes_by_path
    body = await request.json()
    mode = body["mode"]
    path = body.get("path")
    if path:
        _modes_by_path[path] = mode
    else:
        _default_mode = mode
    return {"ok": True, "mode": mode, "path": path}


async def _read_body_or_disconnect(receive):
    body = bytearray()
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return bytes(body), True
        if message["type"] != "http.request":
            continue
        body.extend(message.get("body", b""))
        if not message.get("more_body", False):
            return bytes(body), False


async def _send_text(send, status, text, content_type="text/plain; charset=utf-8"):
    body = text.encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [
            (b"content-type", content_type.encode("ascii")),
            (b"content-length", str(len(body)).encode("ascii")),
        ],
    })
    await send({"type": "http.response.body", "body": body})


async def _send_whep_response(send, status, text, content_type="text/plain; charset=utf-8"):
    await _send_text(send, status, text, content_type)


async def _whep_stub(scope, receive, send):
    global _post_id
    path = scope["path"]
    query = parse_qs(scope.get("query_string", b"").decode("utf-8"))
    mode = query.get("mode", [None])[0] or _modes_by_path.get(path) or _default_mode
    _, disconnected = await _read_body_or_disconnect(receive)
    _post_id += 1
    post_id = _post_id
    _append({
        "event": "start",
        "path": path,
        "mode": mode,
        "post_id": post_id,
        "timestamp": time.time(),
    })
    if disconnected:
        _append({
            "event": "aborted",
            "path": path,
            "mode": mode,
            "post_id": post_id,
            "timestamp": time.time(),
        })
        return

    if mode == "404":
        _append({
            "event": "done",
            "path": path,
            "mode": mode,
            "post_id": post_id,
            "status": 404,
            "timestamp": time.time(),
        })
        await _send_whep_response(send, 404, "missing WHEP rung")
        return
    if mode == "503":
        _append({
            "event": "done",
            "path": path,
            "mode": mode,
            "post_id": post_id,
            "status": 503,
            "timestamp": time.time(),
        })
        await _send_whep_response(send, 503, "publisher unavailable")
        return
    if mode == "invalid-sdp":
        _append({
            "event": "done",
            "path": path,
            "mode": mode,
            "post_id": post_id,
            "status": 201,
            "timestamp": time.time(),
        })
        await _send_whep_response(send, 201, "not a valid SDP answer", "application/sdp")
        return
    if mode == "network-close":
        _append({
            "event": "aborted",
            "path": path,
            "mode": mode,
            "post_id": post_id,
            "timestamp": time.time(),
        })
        raise RuntimeError("e2e simulated WHEP network close")

    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
    _append({
        "event": "aborted",
        "path": path,
        "mode": mode,
        "post_id": post_id,
        "timestamp": time.time(),
    })


def _prioritize_e2e_routes():
    e2e = []
    rest = []
    for route in real_app.router.routes:
        route_path = getattr(route, "path", "")
        if route_path.startswith("/__e2e/"):
            e2e.append(route)
        else:
            rest.append(route)
    real_app.router.routes[:] = e2e + rest


_prioritize_e2e_routes()


async def app(scope, receive, send):
    # Starlette BaseHTTPMiddleware can swallow http.disconnect before downstream
    # handlers see it. Keep long-poll WHEP test endpoints on this raw-ASGI escape.
    if scope["type"] == "http" and scope["path"].startswith("/whep/"):
        await _whep_stub(scope, receive, send)
        return
    await real_app(scope, receive, send)
`,
    'utf8',
  )
}

export const test = base.extend<
  {
    whepErrorLedger: WhepErrorLedger
    whepErrorServer: WhepErrorServer
  },
  Record<string, never>
>({
  whepErrorLedger: async ({}, use) => {
    const ledger: WhepErrorLedger = {
      responsePosts: [],
      consoleMarkers: [],
      pcProbe: { constructed: 0, closed: 0, active: 0 },
    }
    await use(ledger)
  },

  whepErrorServer: async ({}, use, testInfo) => {
    test.skip(
      !process.env.CI && process.env.HOMECAM_RUN_WHEP_ERRORS !== '1',
      'set HOMECAM_RUN_WHEP_ERRORS=1 to run the local WHEP error harness',
    )

    const root = await mkdtemp(path.join(tmpdir(), 'homecam-whep-errors-'))
    const runName = safeTitle(testInfo.title) || 'whep-errors'
    const logPath = path.join(root, `${runName}.log`)
    const serverLedgerPath = path.join(root, `${runName}.server.jsonl`)
    const stubModulePath = path.join(root, 'whep_stub_app.py')
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
    await writeWhepStubApp(stubModulePath)

    const env = {
      ...process.env,
      HOMECAM_SIMULATOR: '1',
      HOMECAM_LOG_LEVEL: 'INFO',
      PORT: String(port),
      CLIENT_DIST: clientDist,
      USERS_DB_PATH: path.join(root, 'users.db'),
      AUDIT_DB_PATH: path.join(root, 'audit.db'),
      SESSIONS_DB_PATH: path.join(root, 'sessions.db'),
      JWT_SECRET_PATH: path.join(root, 'jwt_secret.bin'),
      ACCESS_TOKEN_TTL_S: '30',
      REFRESH_TOKEN_TTL_S: '120',
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
      HOMECAM_WHEP_ERROR_LEDGER: serverLedgerPath,
      HOMECAM_WHEP_ERROR_MODE: '404',
      PYTHONPATH: [root, serverRoot, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
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
        'whep_stub_app:app',
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
        logPath,
        root,
        serverLedgerPath,
        setMode: async (mode, requestPath) => {
          const res = await fetch(`${baseURL}/__e2e/whep-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, path: requestPath }),
          })
          if (!res.ok) {
            throw new Error(`failed to set WHEP mode: ${res.status}`)
          }
        },
        readServerEvents: () => readServerEvents(serverLedgerPath),
      })
    } finally {
      testInfo.attachments.push({
        name: 'whep-error-harness-log',
        path: logPath,
        contentType: 'text/plain',
      })
      testInfo.attachments.push({
        name: 'whep-error-server-ledger',
        path: serverLedgerPath,
        contentType: 'application/jsonl',
      })
      if (!proc.killed) proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
          resolve()
        }, 5_000)
      })
      log.end()
      if (process.env.HOMECAM_E2E_KEEP_TMP !== '1') {
        await rm(root, { recursive: true, force: true })
      }
    }
  },

  baseURL: async ({ whepErrorServer }, use) => {
    await use(whepErrorServer.baseURL)
  },

  page: async ({ page, whepErrorLedger }, use) => {
    await installPeerConnectionProbe(page)

    page.on('console', (message) => {
      const text = message.text()
      if (/(webrtc|whep|videoTile|e2e:whep)/i.test(text)) {
        whepErrorLedger.consoleMarkers.push({
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
      whepErrorLedger.responsePosts.push({
        path: parsed.pathname,
        status: response.status(),
        timestamp: Date.now(),
      })
    })

    try {
      await use(page)
    } finally {
      try {
        whepErrorLedger.pcProbe = await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamWhepPcProbe?: BrowserPcProbe
              }
            ).__homecamWhepPcProbe ?? { constructed: 0, closed: 0, active: 0 }
          )
        })
      } catch {
        whepErrorLedger.pcProbe = { constructed: 0, closed: 0, active: 0 }
      }
    }
  },
})

export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByLabel(/username/i).fill('admin')
  await page.getByRole('textbox', { name: /password/i }).fill('admin')
  await page.getByRole('button', { name: /sign in|log in|login/i }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('link', { name: /home/i })).toBeVisible()
}

export { expect, type Page, type WhepServerEvent }
