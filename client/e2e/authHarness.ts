import { test as base, expect, type Page } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

type AuthHarnessServer = {
  baseURL: string
  healthzStatus: number
  jwtSecretPath: string
  logPath: string
  root: string
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

export const test = base.extend<
  { authServer: AuthHarnessServer },
  Record<string, never>
>({
  authServer: async ({}, use, testInfo) => {
    const root = await mkdtemp(path.join(tmpdir(), 'homecam-auth-e2e-'))
    const runName = safeTitle(testInfo.title) || 'auth-harness'
    const logPath = path.join(root, `${runName}.log`)
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
      await use({ baseURL, healthzStatus, jwtSecretPath, logPath, root })
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
      await rm(root, { recursive: true, force: true })
    }
  },

  baseURL: async ({ authServer }, use) => {
    await use(authServer.baseURL)
  },
})

export { expect, type Page }
