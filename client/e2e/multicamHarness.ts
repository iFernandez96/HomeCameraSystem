import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import type { WhepAttemptLedgerEntry } from '../src/lib/webrtc'

type WhepPost = {
  path: string
  status: number
  timestamp: number
}

type BrowserFrameProbe = {
  firstFrameAt: number | null
  samples: Array<{
    timestamp: number
    readyState: number
    videoWidth: number
    videoHeight: number
  }>
}

type BrowserPcProbe = {
  constructed: number
  closed: number
  active: number
}

export type MulticamLedger = {
  whepPosts: WhepPost[]
  attemptLedger: readonly WhepAttemptLedgerEntry[]
  frameProbe: BrowserFrameProbe
  pcProbe: BrowserPcProbe
  consoleMarkers: Array<{ type: string; text: string; timestamp: number }>
}

type MulticamServer = {
  baseURL: string
  logPath: string
  mediamtxLogPath: string
  ffmpegLogPath: string
  root: string
  webrtcPort: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(clientRoot, '..')
const serverRoot = path.join(repoRoot, 'server')
const clientDist = path.join(clientRoot, 'dist')
const pythonBin = '/tmp/homecam-venv/bin/python'
const hardwareProfilePath = path.join(repoRoot, '.jetson-snapshot', 'hardware-profile.json')
const defaultPublisherProfile = {
  width: 320,
  height: 240,
  fps: '10',
  gopFrames: 10,
}

type PublisherProfile = typeof defaultPublisherProfile

type HardwareProfile = {
  width?: unknown
  height?: unknown
  fps?: unknown
  gop_frames?: unknown
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to allocate TCP port'))
      })
    })
  })
}

async function fileIsExecutable(filename: string): Promise<boolean> {
  try {
    await access(filename, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function findExecutable(name: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (await fileIsExecutable(candidate)) return candidate
  }
  return null
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

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null
}

function fpsValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(value)
  }
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  const decimalMatch = /^\d+(?:\.\d+)?$/.test(trimmed)
  if (decimalMatch && Number(trimmed) > 0) return trimmed

  const rationalMatch = trimmed.match(/^(\d+)\/(\d+)$/)
  if (rationalMatch && Number(rationalMatch[1]) > 0 && Number(rationalMatch[2]) > 0) {
    return trimmed
  }

  return null
}

async function readPublisherProfile(): Promise<PublisherProfile> {
  try {
    const raw = await readFile(hardwareProfilePath, 'utf8')
    const profile = JSON.parse(raw) as HardwareProfile
    return {
      width: positiveInteger(profile.width) ?? defaultPublisherProfile.width,
      height: positiveInteger(profile.height) ?? defaultPublisherProfile.height,
      fps: fpsValue(profile.fps) ?? defaultPublisherProfile.fps,
      gopFrames: positiveInteger(profile.gop_frames) ?? defaultPublisherProfile.gopFrames,
    }
  } catch {
    return defaultPublisherProfile
  }
}

async function waitForHttp(url: string, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (res.ok) return
      lastError = new Error(`${url} returned ${res.status}`)
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
  throw new Error(`timed out waiting for ${url}: ${String(lastError)}\n${logTail}`)
}

function safeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function terminate(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  setTimeout(() => {
    if (!proc.killed && proc.exitCode === null) proc.kill('SIGKILL')
  }, 5_000).unref()
}

async function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    setTimeout(() => resolve(), 5_500).unref()
  })
}

async function installFrameProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Probe = {
      firstFrameAt: number | null
      samples: Array<{
        timestamp: number
        readyState: number
        videoWidth: number
        videoHeight: number
      }>
    }

    const win = window as unknown as { __homecamMulticamFrameProbe?: Probe }
    if (win.__homecamMulticamFrameProbe) return

    const probe: Probe = { firstFrameAt: null, samples: [] }
    win.__homecamMulticamFrameProbe = probe
    const now = () => performance.timeOrigin + performance.now()

    const scan = () => {
      const video = document.querySelector(
        'video[aria-label="Live camera feed"]',
      ) as HTMLVideoElement | null
      if (video) {
        const sample = {
          timestamp: now(),
          readyState: video.readyState,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        }
        if (probe.samples.length < 240) probe.samples.push(sample)
        if (
          probe.firstFrameAt === null &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          video.videoWidth > 0 &&
          video.videoHeight > 0
        ) {
          probe.firstFrameAt = sample.timestamp
        }
      }
      requestAnimationFrame(scan)
    }
    requestAnimationFrame(scan)
  })
}

async function installPeerConnectionProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { __homecamMulticamPcProbe?: BrowserPcProbe }
    if (win.__homecamMulticamPcProbe) return

    const NativeRTCPeerConnection = window.RTCPeerConnection
    const probe: BrowserPcProbe = { constructed: 0, closed: 0, active: 0 }
    win.__homecamMulticamPcProbe = probe

    window.RTCPeerConnection = class HomecamMulticamE2EPc extends NativeRTCPeerConnection {
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
              `e2e:multicam-pc-close constructed=${probe.constructed} closed=${probe.closed} active=${probe.active}`,
            )
          }
          nativeClose()
        }
        console.info(
          `e2e:multicam-pc-open constructed=${probe.constructed} closed=${probe.closed} active=${probe.active}`,
        )
      }
    } as typeof RTCPeerConnection
  })
}

async function writeProxyApp(modulePath: string): Promise<void> {
  await writeFile(
    modulePath,
    `
import http.client
import os

from app.main import app as real_app

_whep_host = "127.0.0.1"
_whep_port = int(os.environ["HOMECAM_E2E_MEDIAMTX_WEBRTC_PORT"])


async def _read_body(receive):
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


async def _proxy_whep(scope, receive, send):
    body, disconnected = await _read_body(receive)
    if disconnected:
        return
    upstream_path = scope["path"].replace("/whep", "", 1)
    query = scope.get("query_string", b"")
    if query:
        upstream_path += "?" + query.decode("ascii")
    headers = {
        k.decode("latin1"): v.decode("latin1")
        for k, v in scope.get("headers", [])
        if k.lower() not in (b"host", b"content-length", b"connection")
    }
    headers["Host"] = f"{_whep_host}:{_whep_port}"
    headers["Content-Length"] = str(len(body))
    conn = http.client.HTTPConnection(_whep_host, _whep_port, timeout=10)
    try:
        conn.request(scope["method"], upstream_path, body=body, headers=headers)
        response = conn.getresponse()
        response_body = response.read()
        response_headers = [
            (k.lower().encode("latin1"), v.encode("latin1"))
            for k, v in response.getheaders()
            if k.lower() not in ("connection", "transfer-encoding", "content-length")
        ]
        response_headers.append((b"content-length", str(len(response_body)).encode("ascii")))
        await send({
            "type": "http.response.start",
            "status": response.status,
            "headers": response_headers,
        })
        await send({"type": "http.response.body", "body": response_body})
    finally:
        conn.close()


async def app(scope, receive, send):
    if scope["type"] == "http" and scope["path"].startswith("/whep/"):
        await _proxy_whep(scope, receive, send)
        return
    await real_app(scope, receive, send)
`,
    'utf8',
  )
}

export const test = base.extend<
  {
    multicamLedger: MulticamLedger
    multicamServer: MulticamServer
  },
  Record<string, never>
>({
  multicamLedger: async ({}, use) => {
    const ledger: MulticamLedger = {
      whepPosts: [],
      attemptLedger: [],
      frameProbe: { firstFrameAt: null, samples: [] },
      pcProbe: { constructed: 0, closed: 0, active: 0 },
      consoleMarkers: [],
    }
    await use(ledger)
  },

  multicamServer: async ({}, use, testInfo) => {
    const mediamtxBin = process.env.HOMECAM_MEDIAMTX_BIN ?? ''
    test.skip(
      !mediamtxBin || !(await fileIsExecutable(mediamtxBin)),
      'download a mediamtx release binary and set HOMECAM_MEDIAMTX_BIN',
    )

    const foundFfmpegBin = await findExecutable('ffmpeg')
    test.skip(!foundFfmpegBin, 'ffmpeg binary not found on PATH')
    const ffmpegBin = foundFfmpegBin ?? ''

    const root = await mkdtemp(path.join(tmpdir(), 'homecam-multicam-e2e-'))
    const runName = safeTitle(testInfo.title) || 'multicam'
    const logPath = path.join(root, `${runName}.uvicorn.log`)
    const mediamtxLogPath = path.join(root, `${runName}.mediamtx.log`)
    const ffmpegLogPath = path.join(root, `${runName}.ffmpeg.log`)
    const proxyModulePath = path.join(root, 'multicam_proxy_app.py')
    const mediamtxConfigPath = path.join(root, 'mediamtx.yml')
    const uvicornLog = createWriteStream(logPath, { flags: 'a' })
    const mediamtxLog = createWriteStream(mediamtxLogPath, { flags: 'a' })
    const ffmpegLog = createWriteStream(ffmpegLogPath, { flags: 'a' })

    const appPort = await getFreePort()
    const rtspPort = await getFreePort()
    const webrtcPort = await getFreePort()
    const apiPort = await getFreePort()
    const baseURL = `http://127.0.0.1:${appPort}`
    const publisherProfile = await readPublisherProfile()

    await writeFile(
      mediamtxConfigPath,
      [
        'logLevel: info',
        'logDestinations: [stdout]',
        'api: yes',
        `apiAddress: 127.0.0.1:${apiPort}`,
        `rtspAddress: 127.0.0.1:${rtspPort}`,
        `webrtcAddress: 127.0.0.1:${webrtcPort}`,
        'webrtcEncryption: no',
        "webrtcAllowOrigins: ['*']",
        'rtmp: no',
        'hls: no',
        'srt: no',
        'paths:',
        '  synth:',
        '    source: publisher',
        '  synth_lq:',
        '    source: publisher',
        '  synth_uq:',
        '    source: publisher',
        '',
      ].join('\n'),
      'utf8',
    )

    const mediamtx = spawn(mediamtxBin, [mediamtxConfigPath], {
      cwd: root,
      env: process.env,
    })
    mediamtx.stdout?.pipe(mediamtxLog, { end: false })
    mediamtx.stderr?.pipe(mediamtxLog, { end: false })

    let ffmpeg: ChildProcess | null = null
    let uvicorn: ChildProcess | null = null
    try {
      await waitForHttp(
        `http://127.0.0.1:${apiPort}/v3/config/global/get`,
        mediamtxLogPath,
      )

      ffmpeg = spawn(
        ffmpegBin,
        [
          '-hide_banner',
          '-loglevel',
          'warning',
          '-re',
          '-f',
          'lavfi',
          '-i',
          `testsrc=size=${publisherProfile.width}x${publisherProfile.height}:rate=${publisherProfile.fps}`,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-tune',
          'zerolatency',
          // 1s GOP: libx264's default 250-frame keyint at 10fps = 25s between
          // IDRs, so a WebRTC reader joining mid-GOP can't decode a frame
          // before the test timeout. Match the production camera's short GOP.
          '-g',
          String(publisherProfile.gopFrames),
          '-keyint_min',
          String(publisherProfile.gopFrames),
          '-pix_fmt',
          'yuv420p',
          '-f',
          'rtsp',
          '-rtsp_transport',
          'tcp',
          `rtsp://127.0.0.1:${rtspPort}/synth`,
        ],
        { cwd: root, env: process.env },
      )
      ffmpeg.stdout?.pipe(ffmpegLog, { end: false })
      ffmpeg.stderr?.pipe(ffmpegLog, { end: false })

      await writeProxyApp(proxyModulePath)
      const dirs = {
        snapshots: path.join(root, 'snapshots'),
        recordings: path.join(root, 'recordings'),
        timelapses: path.join(root, 'timelapses'),
        backups: path.join(root, 'backups'),
        faceCaptures: path.join(root, 'face_captures'),
        personCaptures: path.join(root, 'person_captures'),
      }
      await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))

      const env = {
        ...process.env,
        HOMECAM_SIMULATOR: '1',
        HOMECAM_LOG_LEVEL: 'INFO',
        HOMECAM_CAMERAS: JSON.stringify([
          { id: 'front_door', name: 'Front Door', path: 'cam' },
          { id: 'synth', name: 'Synth', path: 'synth' },
        ]),
        HOMECAM_E2E_MEDIAMTX_WEBRTC_PORT: String(webrtcPort),
        PORT: String(appPort),
        CLIENT_DIST: clientDist,
        USERS_DB_PATH: path.join(root, 'users.db'),
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

      uvicorn = spawn(
        pythonBin,
        [
          '-m',
          'uvicorn',
          'multicam_proxy_app:app',
          '--host',
          '127.0.0.1',
          '--port',
          String(appPort),
          '--log-level',
          'info',
        ],
        { cwd: serverRoot, env },
      )
      uvicorn.stdout?.pipe(uvicornLog, { end: false })
      uvicorn.stderr?.pipe(uvicornLog, { end: false })

      await waitForHttp(`${baseURL}/healthz`, logPath)
      await use({ baseURL, logPath, mediamtxLogPath, ffmpegLogPath, root, webrtcPort })
    } finally {
      testInfo.attachments.push({
        name: 'multicam-uvicorn-log',
        path: logPath,
        contentType: 'text/plain',
      })
      testInfo.attachments.push({
        name: 'multicam-mediamtx-log',
        path: mediamtxLogPath,
        contentType: 'text/plain',
      })
      testInfo.attachments.push({
        name: 'multicam-ffmpeg-log',
        path: ffmpegLogPath,
        contentType: 'text/plain',
      })
      if (uvicorn) {
        terminate(uvicorn)
        await waitForExit(uvicorn)
      }
      if (ffmpeg) {
        terminate(ffmpeg)
        await waitForExit(ffmpeg)
      }
      terminate(mediamtx)
      await waitForExit(mediamtx)
      uvicornLog.end()
      mediamtxLog.end()
      ffmpegLog.end()
      if (process.env.HOMECAM_E2E_KEEP_TMP !== '1') {
        await rm(root, { recursive: true, force: true })
      }
    }
  },

  baseURL: async ({ multicamServer }, use) => {
    await use(multicamServer.baseURL)
  },

  page: async ({ page, multicamLedger }, use) => {
    await installPeerConnectionProbe(page)
    await installFrameProbe(page)

    page.on('console', (message) => {
      const text = message.text()
      if (/(webrtc|whep|videoTile|multicam)/i.test(text)) {
        multicamLedger.consoleMarkers.push({
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
      multicamLedger.whepPosts.push({
        path: parsed.pathname,
        status: response.status(),
        timestamp: Date.now(),
      })
    })

    try {
      await use(page)
    } finally {
      try {
        multicamLedger.frameProbe = await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamMulticamFrameProbe?: BrowserFrameProbe
              }
            ).__homecamMulticamFrameProbe ?? { firstFrameAt: null, samples: [] }
          )
        })
        multicamLedger.pcProbe = await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamMulticamPcProbe?: BrowserPcProbe
              }
            ).__homecamMulticamPcProbe ?? { constructed: 0, closed: 0, active: 0 }
          )
        })
        multicamLedger.attemptLedger = await page.evaluate(() => {
          return (
            (
              window as unknown as {
                __homecamWhepLedgerDump?: () => readonly WhepAttemptLedgerEntry[]
              }
            ).__homecamWhepLedgerDump?.() ?? []
          )
        })
      } catch {
        multicamLedger.frameProbe = { firstFrameAt: null, samples: [] }
        multicamLedger.pcProbe = { constructed: 0, closed: 0, active: 0 }
        multicamLedger.attemptLedger = []
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

export { expect, type Page }
