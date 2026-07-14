import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/primitives/Button'
import {
  configureExternalArchive,
  configureSemanticCompanion,
  deleteSavedSearch,
  getDailyBriefing,
  getHealthHistory,
  getOperationsState,
  getRecordingIntegrity,
  getRecoverStatus,
  runRecordingTest,
  setHomeProfile,
  setModeSchedules,
  syncExternalArchive,
  type DailyBriefing,
  type HealthHistorySample,
  type HomeProfile,
  type ModeSchedule,
  type OperationsState,
  type RecordingIntegrity,
} from '../../lib/api'
import { formatBytes } from '../../lib/format'
import { useToast } from '../../lib/toast'
import { Row, Section, Toggle } from './parts'
import { RecordingIntegrityPanel } from '../control/RecordingIntegrityPanel'

const profiles: Array<{ id: HomeProfile; label: string; description: string }> = [
  { id: 'home', label: 'Home', description: 'Routine household alerts' },
  { id: 'away', label: 'Away', description: 'Unknown people become urgent' },
  { id: 'sleep', label: 'Sleep', description: 'Nighttime alert policy' },
  { id: 'vacation', label: 'Vacation', description: 'Away protection until you change it' },
  { id: 'privacy', label: 'Privacy', description: 'Mask every recording surface and stop inference' },
]

const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000
const HEALTH_GAP_MS = 23 * 60 * 1000

function formatDateTime(value: number | null | undefined): string {
  return value ? new Date(value * 1000).toLocaleString() : 'Never'
}

function fetchControlCenter() {
  return Promise.all([
    getOperationsState(),
    getDailyBriefing(),
    getHealthHistory(24),
    getRecordingIntegrity(),
  ])
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

function HealthTimeline({ samples, nowMs }: { samples: HealthHistorySample[]; nowMs: number }) {
  const end = nowMs
  const start = end - HEALTH_WINDOW_MS
  const ordered = [...samples].sort((a, b) => a.ts - b.ts)
  const values = ordered.map((sample) => sample.fps ?? 0)
  const ceiling = Math.max(1, ...values)
  const xFor = (ts: number) => Math.max(0, Math.min(100, ((ts * 1000 - start) / HEALTH_WINDOW_MS) * 100))
  const segments: HealthHistorySample[][] = []
  const gaps: Array<[number, number]> = []
  let segment: HealthHistorySample[] = []
  let previousMs = start
  for (const sample of ordered) {
    const sampleMs = sample.ts * 1000
    if (sampleMs - previousMs > HEALTH_GAP_MS) {
      gaps.push([previousMs, sampleMs])
      if (segment.length) segments.push(segment)
      segment = []
    }
    segment.push(sample)
    previousMs = sampleMs
  }
  if (segment.length) segments.push(segment)
  if (end - previousMs > HEALTH_GAP_MS) gaps.push([previousMs, end])
  return (
    <figure className="px-4 pb-4" aria-label="Camera frame rate and availability over the last 24 hours">
      <svg viewBox="0 0 100 32" role="img" className="h-24 w-full overflow-visible" preserveAspectRatio="none">
        <title>Camera health timeline; shaded gaps mean HomeCam could not take a sample, and red marks mean the worker was confirmed offline</title>
        <line x1="0" y1="28" x2="100" y2="28" stroke="var(--color-border)" strokeWidth="0.6" />
        {gaps.map(([gapStart, gapEnd]) => (
          <rect key={`${gapStart}:${gapEnd}`} x={xFor(gapStart / 1000)} y="2" width={Math.max(0.5, xFor(gapEnd / 1000) - xFor(gapStart / 1000))} height="27" fill="var(--color-border-subtle)" opacity="0.7" />
        ))}
        {segments.map((rows) => (
          <polyline key={rows[0].ts} points={rows.map((sample) => `${xFor(sample.ts).toFixed(2)},${(28 - ((sample.fps ?? 0) / ceiling) * 24).toFixed(2)}`).join(' ')} fill="none" stroke="var(--color-accent-default)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
        ))}
        {ordered.map((sample) => sample.worker_alive ? null : (
          <line key={sample.ts} x1={xFor(sample.ts)} y1="2" x2={xFor(sample.ts)} y2="29" stroke="var(--color-danger)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <figcaption className="flex justify-between text-xs text-[var(--color-text-tertiary)]"><span>24 hours ago</span><span>Now</span></figcaption>
    </figure>
  )
}

export function OperationsSection() {
  const [state, setState] = useState<OperationsState | null>(null)
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null)
  const [health, setHealth] = useState<HealthHistorySample[]>([])
  const [healthNowMs, setHealthNowMs] = useState(() => Date.now())
  const [integrity, setIntegrity] = useState<RecordingIntegrity | null>(null)
  const [profileDraft, setProfileDraft] = useState<HomeProfile>('sleep')
  const [timeDraft, setTimeDraft] = useState('22:00')
  const [daysDraft, setDaysDraft] = useState<'daily' | 'weekdays'>('daily')
  const [companionUrl, setCompanionUrl] = useState('')
  const [companionToken, setCompanionToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { showToast } = useToast()

  const load = async () => {
    try {
      const [operations, daily, history, recording] = await fetchControlCenter()
      setState(operations)
      setCompanionUrl(operations.semantic_companion.base_url)
      setBriefing(daily)
      setHealth(history.items)
      setIntegrity(recording)
      setHealthNowMs(Date.now())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Control center unavailable')
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchControlCenter()
      .then(([operations, daily, history, recording]) => {
        if (cancelled) return
        setState(operations)
        setCompanionUrl(operations.semantic_companion.base_url)
        setBriefing(daily)
        setHealth(history.items)
        setIntegrity(recording)
        setHealthNowMs(Date.now())
        setError(null)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Control center unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const healthSummary = useMemo(() => {
    const offline = health.filter((row) => !row.worker_alive).length
    const quality = health.filter((row) => (row.camera_quality_status ?? 1) > 1).length
    const last = health.at(-1)
    const ordered = [...health].sort((a, b) => a.ts - b.ts)
    const end = healthNowMs
    const start = end - HEALTH_WINDOW_MS
    let previous = start
    let gaps = 0
    for (const row of ordered) {
      if (row.ts * 1000 - previous > HEALTH_GAP_MS) gaps += 1
      previous = row.ts * 1000
    }
    if (end - previous > HEALTH_GAP_MS) gaps += 1
    return { offline, quality, last, gaps }
  }, [health, healthNowMs])

  const applyProfile = async (profile: HomeProfile) => {
    if (!state) return
    const previous = state
    setState({ ...state, active_profile: profile })
    setBusy(`profile:${profile}`)
    try {
      const saved = await setHomeProfile(profile)
      setState((current) => current ? { ...current, active_profile: saved.active_profile, effective_mode: saved.effective_mode as OperationsState['effective_mode'] } : current)
      showToast(`${profiles.find((item) => item.id === profile)?.label} mode active`, 'success')
    } catch {
      setState(previous)
      showToast('Could not change household mode', 'error')
    } finally {
      setBusy(null)
    }
  }

  const persistSchedules = async (items: ModeSchedule[]) => {
    if (!state || busy !== null) return
    const previous = state.mode_schedules
    setState({ ...state, mode_schedules: items })
    setBusy('schedule')
    try {
      const saved = await setModeSchedules(items)
      setState((current) => current ? { ...current, mode_schedules: saved.items } : current)
    } catch {
      setState((current) => current ? { ...current, mode_schedules: previous } : current)
      showToast('Could not save mode schedule', 'error')
    } finally {
      setBusy(null)
    }
  }

  const addSchedule = () => {
    if (!state) return
    const next: ModeSchedule = {
      id: `mode_${Date.now().toString(36)}`.slice(0, 32),
      profile: profileDraft,
      time: timeDraft,
      days: daysDraft === 'weekdays' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5, 6],
      enabled: true,
    }
    void persistSchedules([...state.mode_schedules, next])
  }

  const toggleArchive = async (enabled: boolean) => {
    if (!state) return
    setBusy('archive')
    try {
      const archive = await configureExternalArchive(enabled)
      setState({ ...state, archive })
    } catch {
      showToast('Could not change archive setting', 'error')
    } finally {
      setBusy(null)
    }
  }

  const syncArchive = async () => {
    if (!state) return
    setBusy('archive-sync')
    try {
      const archive = await syncExternalArchive()
      setState({ ...state, archive: { ...state.archive, ...archive } })
      showToast('Independent archive verified', 'success')
    } catch {
      showToast('Archive target is unavailable or could not be verified', 'error')
    } finally {
      setBusy(null)
    }
  }

  const saveCompanion = async (enabled: boolean) => {
    if (!state) return
    setBusy('companion')
    try {
      const companion = await configureSemanticCompanion(
        enabled,
        companionUrl,
        companionToken || undefined,
      )
      setCompanionToken('')
      setState({ ...state, semantic_companion: companion })
      showToast(enabled ? 'Search companion enabled' : 'Search companion disabled', 'success')
    } catch {
      showToast('Use a private-network IP address for the companion', 'error')
    } finally {
      setBusy(null)
    }
  }

  const runCameraTest = async () => {
    const startedAt = Date.now() / 1000
    setBusy('recording-test')
    try {
      const job = await runRecordingTest()
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = await getRecoverStatus(job.request_id)
        if (status.status === 'failed' || status.status === 'expired') {
          throw new Error(status.status === 'failed' ? status.detail ?? 'Camera test failed' : 'Camera test timed out')
        }
        if (status.status === 'done') break
        await wait(1000)
      }
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const recording = await getRecordingIntegrity()
        setIntegrity(recording)
        if ((recording.assurance.checked_at ?? 0) >= startedAt) {
          if (recording.assurance.state !== 'ok') throw new Error('The end-to-end recording test failed')
          showToast('Camera test passed from RTSP capture through playable video', 'success')
          return
        }
        await wait(1000)
      }
      throw new Error('The camera test did not report a result in time')
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'Camera test failed', 'error')
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <div role="alert" className="card-paper space-y-3 p-4">
        <p className="font-semibold">Could not load the control center</p>
        <p className="text-sm text-[var(--color-text-secondary)]">{error}</p>
        <Button variant="secondary" onClick={() => void load()}>Retry</Button>
      </div>
    )
  }
  if (!state || !briefing) return <p role="status">Loading control center…</p>

  return (
    <div className="space-y-6">
      <Section title="Household mode" subtitle="One switch changes the existing recording and alert policy.">
        <div className="grid gap-2 p-3 sm:grid-cols-2">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              aria-pressed={state.active_profile === profile.id}
              disabled={busy !== null}
              onClick={() => void applyProfile(profile.id)}
              className={`min-h-16 rounded-xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] ${state.active_profile === profile.id ? 'border-[var(--color-accent-default)] bg-[var(--color-accent-subtle)]' : 'border-[var(--color-border)] bg-[var(--color-surface-raised)]'}`}
            >
              <span className="block font-semibold">{profile.label}</span>
              <span className="block text-xs text-[var(--color-text-secondary)]">{profile.description}</span>
            </button>
          ))}
        </div>
        <div className="space-y-3 p-3">
          <h3 className="font-semibold">Automatic changes</h3>
          {state.mode_schedules.map((schedule) => (
            <div key={schedule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-border)] p-3">
              <span className="text-sm capitalize">{schedule.profile} at {schedule.time} · {schedule.days.length === 7 ? 'Every day' : `${schedule.days.length} days`}</span>
              <div className="flex items-center gap-3">
                <Toggle checked={schedule.enabled} disabled={busy !== null} onChange={(enabled) => void persistSchedules(state.mode_schedules.map((row) => row.id === schedule.id ? { ...row, enabled } : row))} ariaLabel={`${schedule.enabled ? 'Disable' : 'Enable'} ${schedule.profile} schedule`} />
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void persistSchedules(state.mode_schedules.filter((row) => row.id !== schedule.id))}>Remove</Button>
              </div>
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <select value={profileDraft} onChange={(event) => setProfileDraft(event.target.value as HomeProfile)} aria-label="Scheduled mode" className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base">
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
            </select>
            <input type="time" value={timeDraft} onChange={(event) => setTimeDraft(event.target.value)} aria-label="Scheduled mode time" className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base" />
            <select value={daysDraft} onChange={(event) => setDaysDraft(event.target.value as 'daily' | 'weekdays')} aria-label="Scheduled days" className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base">
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
            </select>
            <Button variant="secondary" disabled={busy !== null} onClick={addSchedule}>Add schedule</Button>
          </div>
        </div>
      </Section>

      <Section title="Today’s security briefing" subtitle="A factual summary generated from local event and health records.">
        <div className="space-y-2 p-4">
          <p className="text-lg font-semibold">{briefing.headline}</p>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Recording now: {briefing.recording_state} · {briefing.camera_interruptions} camera interruption{briefing.camera_interruptions === 1 ? '' : 's'} · {briefing.protected_events} protected total
          </p>
          <p className="text-sm text-[var(--color-text-secondary)]">Today’s event videos: {briefing.video_counts.available} available · {briefing.video_counts.processing} processing · {briefing.video_counts.failed} failed · {briefing.video_counts.unknown} not yet confirmed</p>
          {briefing.known_people.length ? <p className="text-sm">Recognized: {briefing.known_people.join(', ')}</p> : null}
        </div>
      </Section>

      <RecordingIntegrityPanel integrity={integrity} running={busy === 'recording-test'} disabled={busy !== null} onRun={() => void runCameraTest()} />

      <Section title="Retention and protected evidence" subtitle="Ordinary footage expires first; incident and permanent evidence never does.">
        <Row label="Ordinary" right={<span>{state.retention.classes.ordinary} · {state.retention.ordinary_days} days</span>} />
        <Row label="Important" right={<span>{state.retention.classes.important} · {state.retention.important_days} days</span>} />
        <Row label="Incident / permanent" right={<span>{state.retention.protected_total}</span>} />
        <div className="space-y-2 p-3">
          <h3 className="text-sm font-semibold">What will be deleted next</h3>
          {state.retention.next_deletions.length === 0 ? <p className="text-sm text-[var(--color-text-secondary)]">No ordinary clips are awaiting age-based deletion.</p> : null}
          {state.retention.next_deletions.slice(0, 5).map((row) => (
            <p key={row.event_id} className="flex justify-between gap-3 text-xs text-[var(--color-text-secondary)]">
              <span className="truncate">{row.event_id}</span>
              <span className="shrink-0">{row.overdue ? 'Next cleanup' : formatDateTime(row.delete_after_ts)}</span>
            </p>
          ))}
        </div>
      </Section>

      <Section title="Camera health history" subtitle="Seven days of low-cadence measurements without touching the camera pipeline.">
        <Row label="Samples in the last 24 hours" right={<span>{health.length}</span>} />
        <Row label="Offline samples" right={<span>{healthSummary.offline}</span>} />
        <Row label="Unobserved intervals" right={<span>{healthSummary.gaps}</span>} />
        <Row label="Blur or freeze samples" right={<span>{healthSummary.quality}</span>} />
        <Row label="Latest frame rate" right={<span>{healthSummary.last?.fps == null ? 'Waiting' : `${healthSummary.last.fps.toFixed(1)} FPS`}</span>} />
        <HealthTimeline samples={health} nowMs={healthNowMs} />
      </Section>

      <Section title="Incidents and automations" subtitle="Existing evidence and rule engines, now part of one response workflow.">
        <div className="flex flex-wrap gap-2 p-3">
          <Link to="/events/incidents" className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-[var(--color-accent-deep)]">Open incident cases</Link>
          <Link to="/settings" onClick={() => window.localStorage.setItem('homecam:settingsTab', 'rules')} className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-[var(--color-accent-deep)]">Edit When → If → Then rules</Link>
        </div>
        <p className="px-4 pb-3 text-xs text-[var(--color-text-secondary)]">Incident exports include a printable PDF, event JSON, video files, audit history, and SHA-256 evidence hashes.</p>
      </Section>

      <Section title="Independent archive" subtitle="Copies protected clips only when a separately mounted target is explicitly marked.">
        <Row label="Archive automatically" right={<Toggle checked={state.archive.enabled} disabled={busy !== null || !state.archive.available} onChange={(enabled) => void toggleArchive(enabled)} ariaLabel="Archive protected events automatically" />} />
        <Row label="Target" right={<span className="max-w-52 break-all text-right text-xs">{state.archive.available ? state.archive.target : 'Not mounted'}</span>} />
        <Row label="Last verified" right={<span>{formatDateTime(state.archive.last_sync_ts)}</span>} />
        <Row label="Current status" right={<span>{state.archive.available ? state.archive.last_status : 'Unavailable'}</span>} />
        <Row label="Verified copy" right={<span>{state.archive.files_verified ?? 0} files · {formatBytes(state.archive.bytes_verified ?? 0)}</span>} />
        <div className="space-y-2 p-3">
          {!state.archive.available ? <p className="text-sm text-[var(--color-text-secondary)]">Mount an independent filesystem at {state.archive.target}, then create {state.archive.marker_required}. A directory on the recordings filesystem is deliberately rejected.</p> : null}
          {state.archive.last_error ? <p role="alert" className="text-sm text-[var(--color-danger)]">Last archive attempt failed: {state.archive.last_error}</p> : null}
          <Button variant="secondary" disabled={!state.archive.available || busy !== null} loading={busy === 'archive-sync'} loadingText="Verifying archive…" onClick={() => void syncArchive()}>Sync and verify now</Button>
        </div>
      </Section>

      <Section title="Optional semantic-search companion" subtitle="Heavy visual search stays off the 2 GB Jetson and is disabled by default.">
        <div className="space-y-3 p-3">
          <label className="block text-sm font-medium">Private companion URL
            <input value={companionUrl} onChange={(event) => setCompanionUrl(event.target.value)} placeholder="http://10.0.0.50:8090" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base" />
          </label>
          <label className="block text-sm font-medium">API token {state.semantic_companion.token_set ? '(already set)' : ''}
            <input type="password" value={companionToken} onChange={(event) => setCompanionToken(event.target.value)} autoComplete="new-password" className="mt-1 min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!companionUrl || busy !== null} onClick={() => void saveCompanion(true)}>Enable companion</Button>
            {state.semantic_companion.enabled ? <Button variant="secondary" disabled={busy !== null} onClick={() => void saveCompanion(false)}>Disable</Button> : null}
            <Link to="/events/search" className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold text-[var(--color-accent-deep)]">Open event search</Link>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">Only private IP literals are accepted. Queries are capped at 10 per minute, results are restricted to real local event IDs, and the token is never returned to the browser.</p>
        </div>
      </Section>

      <Section title="Saved searches" subtitle="Reusable smart collections for the questions you ask repeatedly.">
        <div className="space-y-2 p-3">
          {state.saved_searches.length === 0 ? <p className="text-sm text-[var(--color-text-secondary)]">Save a search from the Event Search page to create your first collection.</p> : null}
          {state.saved_searches.map((search) => (
            <div key={search.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] p-3">
              <Link to={`/events/search?q=${encodeURIComponent(search.query)}${search.semantic ? '&semantic=1' : ''}`} className="min-w-0 font-semibold text-[var(--color-accent-deep)]">{search.name}</Link>
              <Button variant="ghost" size="sm" onClick={async () => {
                try {
                  await deleteSavedSearch(search.id)
                  setState((current) => current ? { ...current, saved_searches: current.saved_searches.filter((item) => item.id !== search.id) } : current)
                } catch {
                  showToast('Could not delete this saved search', 'error')
                }
              }}>Delete</Button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  )
}
