#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function usage() {
  console.error(
    'usage: node client/e2e/whep-parity-diff.mjs --ledgers <dir> --mediamtx <log> --window-start <iso> --window-end <iso>',
  )
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (!key?.startsWith('--') || !value) {
      usage()
      process.exit(2)
    }
    args[key.slice(2)] = value
  }
  for (const key of ['ledgers', 'mediamtx', 'window-start', 'window-end']) {
    if (!args[key]) {
      usage()
      process.exit(2)
    }
  }
  return args
}

function parseInstant(value, label) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid ${label}: ${value}`)
  }
  return ms
}

function normalizeRungPath(value) {
  if (!value || typeof value !== 'string') return '<unknown>'
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  const whepPrefix = trimmed.match(/^\/whep\/([^/]+)\/whep\/?$/)
  if (whepPrefix) return whepPrefix[1]
  const directWhep = trimmed.match(/^\/?([^/]+)\/whep\/?$/)
  if (directWhep) return directWhep[1]
  return trimmed.replace(/^\/+/, '')
}

function extractTimestamp(line) {
  const iso = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/)
  if (iso) return Date.parse(iso[0])

  const slash = line.match(/\b(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\b/)
  if (slash) {
    const [, year, month, day, hour, minute, second, fraction = '0'] = slash
    // mediamtx logs LOCAL wall-clock with no offset; parse as local (no Z) so
    // comparisons against the ledger's true-UTC epoch ms line up. Assumes the
    // analyzing machine shares the Jetson's TZ (both America/Los_Angeles).
    return Date.parse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0').slice(0, 3)}`,
    )
  }

  return Number.NaN
}

function sessionIdFromLine(line) {
  return (
    line.match(/\[session ([^\]]+)\]/i)?.[1] ??
    line.match(/\bsession=([^\s,]+)/i)?.[1] ??
    line.match(/\bWebRTC session ([^\s:]+)/i)?.[1] ??
    null
  )
}

function lineEvent(line) {
  if (/\bcreated\b/i.test(line)) return 'created'
  if (/\bestablished\b/i.test(line)) return 'established'
  if (/\bis reading from path\b/i.test(line)) return 'reading'
  if (/\bclosed\b/i.test(line)) return 'closed'
  return null
}

function lineReadPath(line) {
  return (
    line.match(/\bis reading from path ['"]?([^'"\s,]+)/i)?.[1] ??
    line.match(/\bpath=['"]?([^'"\s,]+)/i)?.[1] ??
    null
  )
}

function inWindow(ms, startMs, endMs) {
  return Number.isFinite(ms) && ms >= startMs && ms <= endMs
}

async function loadAttempts(ledgerDir, startMs, endMs) {
  const entries = await readdir(ledgerDir, { withFileTypes: true })
  const attempts = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(ledgerDir, entry.name)
    const json = JSON.parse(await readFile(file, 'utf8'))
    const ledgerEntries = Array.isArray(json.attemptLedger) ? json.attemptLedger : []
    for (const attempt of ledgerEntries) {
      if (!inWindow(attempt.startedAt, startMs, endMs)) continue
      attempts.push({
        file: entry.name,
        attemptId: attempt.attemptId,
        rung: normalizeRungPath(attempt.rungPath),
        startedAt: attempt.startedAt,
        settledAt: Number.isFinite(attempt.settledAt) ? attempt.settledAt : attempt.startedAt,
        outcome: attempt.outcome ?? 'unsettled',
      })
    }
  }

  return attempts.sort((a, b) => a.startedAt - b.startedAt || a.attemptId - b.attemptId)
}

async function loadMediaMtxSessions(logFile, startMs, endMs) {
  const text = await readFile(logFile, 'utf8')
  const sessionsById = new Map()

  for (const line of text.split(/\r?\n/)) {
    const at = extractTimestamp(line)
    if (!inWindow(at, startMs, endMs)) continue
    const event = lineEvent(line)
    if (!event) continue
    const id = sessionIdFromLine(line)
    if (!id) continue

    const session = sessionsById.get(id) ?? {
      id,
      createdAt: null,
      establishedAt: null,
      readingAt: null,
      closedAt: null,
      rung: null,
    }

    if (event === 'created' && session.createdAt === null) session.createdAt = at
    if (event === 'established' && session.establishedAt === null) session.establishedAt = at
    if (event === 'reading') {
      session.readingAt = session.readingAt ?? at
      session.rung = session.rung ?? normalizeRungPath(lineReadPath(line))
    }
    if (event === 'closed') session.closedAt = session.closedAt ?? at

    sessionsById.set(id, session)
  }

  return [...sessionsById.values()]
}

function sessionReading(session) {
  return session.readingAt !== null && session.rung !== null
}

function attemptWindow(attempt) {
  return {
    start: attempt.startedAt,
    end: Math.max(attempt.startedAt, attempt.settledAt),
  }
}

function hasReadingDuringAttempt(attempt, sessions) {
  const window = attemptWindow(attempt)
  return sessions.some(
    (session) =>
      session.rung === attempt.rung &&
      sessionReading(session) &&
      session.readingAt >= window.start &&
      session.readingAt <= window.end,
  )
}

function summarizeByRung(attempts, sessions) {
  const rungs = new Set([
    ...attempts.map((attempt) => attempt.rung),
    ...sessions.filter(sessionReading).map((session) => session.rung),
  ])
  const perRung = {}
  for (const rung of [...rungs].sort()) {
    const rungAttempts = attempts.filter((attempt) => attempt.rung === rung)
    const connectedAttempts = rungAttempts.filter((attempt) => attempt.outcome === 'connected')
    const readingSessions = sessions.filter(
      (session) => session.rung === rung && sessionReading(session),
    )
    perRung[rung] = {
      attempts: rungAttempts.length,
      connectedAttempts: connectedAttempts.length,
      readingSessions: readingSessions.length,
      nonConnectedAttempts: rungAttempts.length - connectedAttempts.length,
    }
  }
  return perRung
}

function diffParity(attempts, sessions) {
  const drift = []
  const perRung = summarizeByRung(attempts, sessions)

  for (const [rung, summary] of Object.entries(perRung)) {
    // Phantom connect: the browser claimed media-connected but the server
    // never read the stream. Always drift.
    if (summary.connectedAttempts > summary.readingSessions) {
      drift.push({
        type: 'phantom-connect',
        rung,
        connectedAttempts: summary.connectedAttempts,
        readingSessions: summary.readingSessions,
      })
      continue
    }
    // Excess server reads are legitimate ONLY when explained by attempts the
    // browser aborted mid-handshake (rung switch races connectionState):
    // mediamtx starts reading server-side while the browser tears down.
    const abortedOnRung = attempts.filter(
      (attempt) => attempt.rung === rung && attempt.outcome === 'aborted',
    ).length
    const excess = summary.readingSessions - summary.connectedAttempts
    if (excess > abortedOnRung) {
      drift.push({
        type: 'unexplained-reading-sessions',
        rung,
        connectedAttempts: summary.connectedAttempts,
        readingSessions: summary.readingSessions,
        abortedAttempts: abortedOnRung,
      })
    }
  }

  for (const attempt of attempts) {
    if (attempt.outcome === 'connected' || attempt.outcome === 'aborted') continue
    if (!hasReadingDuringAttempt(attempt, sessions)) continue
    // A failure-outcome attempt (http-4xx, set-remote-failed, ice-failed,
    // error) overlapping a server read is a contradiction. Aborted is exempt:
    // browser-initiated teardown racing an established server read is
    // expected (see excess rule above).
    drift.push({
      type: 'non-connected-reading',
      rung: attempt.rung,
      attemptId: attempt.attemptId,
      outcome: attempt.outcome,
      startedAt: attempt.startedAt,
      settledAt: attempt.settledAt,
    })
  }

  return {
    parity: drift.length === 0,
    perRung,
    drift,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startMs = parseInstant(args['window-start'], '--window-start')
  const endMs = parseInstant(args['window-end'], '--window-end')
  if (endMs < startMs) {
    throw new Error('--window-end must be >= --window-start')
  }

  const [attempts, sessions] = await Promise.all([
    loadAttempts(args.ledgers, startMs, endMs),
    loadMediaMtxSessions(args.mediamtx, startMs, endMs),
  ])
  const verdict = diffParity(attempts, sessions)
  console.log(JSON.stringify(verdict, null, 2))
  process.exit(verdict.parity ? 0 : 1)
}

main().catch((error) => {
  console.error(JSON.stringify({ parity: false, error: error.message }))
  process.exit(2)
})
