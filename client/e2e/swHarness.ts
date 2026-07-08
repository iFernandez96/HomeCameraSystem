import { test as base, expect } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

type SwBuild = {
  marker: string
  dist: string
}

type SwHarnessServer = {
  baseURL: string
  buildA: SwBuild
  buildB: SwBuild
  healthzStatus: number
  logPath: string
  root: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(clientRoot, '..')
const serverRoot = path.join(repoRoot, 'server')
const pythonBin = '/tmp/homecam-venv/bin/python'
const markerA = 'h6-a'
const markerB = 'h6-b'

function cachedBuildPath(marker: string): string {
  return path.join(tmpdir(), 'homecam-sw-e2e-builds', marker, 'dist')
}

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

async function buildDist(marker: string): Promise<SwBuild> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['./e2e/build-sw-dist.mjs', marker],
      { cwd: clientRoot, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `SANDBOX-HANG sw build marker=${marker} failed\n${stdout}\n${stderr}`,
            ),
          )
          return
        }
        if (!stdout.trim()) {
          resolve({ marker, dist: cachedBuildPath(marker) })
          return
        }
        try {
          const jsonLine = stdout
            .trim()
            .split('\n')
            .findLast((line) => line.trim().startsWith('{'))
          if (!jsonLine) {
            throw new Error('missing JSON line')
          }
          resolve(JSON.parse(jsonLine) as SwBuild)
        } catch (parseError) {
          reject(
            new Error(
              `failed to parse sw build helper output: ${String(parseError)}\n${stdout}`,
            ),
          )
        }
      },
    )
  })
}

export const test = base.extend<
  { swServer: SwHarnessServer },
  { swBuilds: { buildA: SwBuild; buildB: SwBuild } }
>({
  swBuilds: [
    async ({}, use) => {
      try {
        const buildA = await buildDist(markerA)
        const buildB = await buildDist(markerB)
        await use({ buildA, buildB })
      } catch (error) {
        console.error(`SANDBOX-HANG ${String(error)}`)
        throw error
      }
    },
    { scope: 'worker' },
  ],

  swServer: async ({ swBuilds }, use, testInfo) => {
    const root = await mkdtemp(path.join(tmpdir(), 'homecam-sw-e2e-'))
    const logPath = path.join(root, 'sw-harness.log')
    const log = createWriteStream(logPath, { flags: 'a' })

    const dirs = {
      snapshots: path.join(root, 'snapshots'),
      recordings: path.join(root, 'recordings'),
      timelapses: path.join(root, 'timelapses'),
      backups: path.join(root, 'backups'),
      faceCaptures: path.join(root, 'face_captures'),
      personCaptures: path.join(root, 'person_captures'),
    }
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))

    let proc: ReturnType<typeof spawn> | null = null
    try {
      const port = await getFreePort()
      const baseURL = `http://127.0.0.1:${port}`
      const env = {
        ...process.env,
        HOMECAM_SIMULATOR: '1',
        HOMECAM_LOG_LEVEL: 'INFO',
        PORT: String(port),
        CLIENT_DIST: swBuilds.buildA.dist,
        USERS_DB_PATH: path.join(root, 'users.db'),
        JWT_SECRET_PATH: path.join(root, 'jwt_secret.bin'),
        ACCESS_TOKEN_TTL_S: '30',
        REFRESH_TOKEN_TTL_S: '300',
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
      proc = spawn(
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

      const healthzStatus = await waitForHealthz(baseURL, logPath)
      await use({
        baseURL,
        buildA: swBuilds.buildA,
        buildB: swBuilds.buildB,
        healthzStatus,
        logPath,
        root,
      })
    } catch (error) {
      console.error(`SANDBOX-HANG ${String(error)}`)
      throw error
    } finally {
      testInfo.attachments.push({
        name: 'sw-harness-log',
        path: logPath,
        contentType: 'text/plain',
      })
      if (proc && !proc.killed) {
        proc.kill('SIGTERM')
      }
      if (proc) {
        await new Promise<void>((resolve) => {
          proc?.once('exit', () => resolve())
          setTimeout(() => {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL')
            }
            resolve()
          }, 5_000)
        })
      }
      log.end()
      if (process.env.HOMECAM_E2E_KEEP_TMP !== '1') {
        await rm(root, { recursive: true, force: true })
      }
    }
  },

  baseURL: async ({ swServer }, use) => {
    await use(swServer.baseURL)
  },
})

export { expect }
