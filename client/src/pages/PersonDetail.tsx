import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { EventRow } from '../components/EventRow'
import { ClipModal } from '../components/ClipModal'
import { Button } from '../components/primitives/Button'
import { ErrorState } from '../components/states/ErrorState'
import { Toggle } from './settings/parts'
import {
  getFacePreferences,
  listFaceCaptureDirs,
  mergeFaces,
  searchEvents,
  setFacePreference,
  type FaceMergeResponse,
} from '../lib/api'
import type { DetectionEvent } from '../lib/types'
import { useConfirm } from '../lib/confirm'
import { useAuth } from '../lib/auth'
import { isOwner } from '../lib/roles'
import { useToast } from '../lib/toast'

export function PersonDetail() {
  const { name: encodedName = '' } = useParams()
  const name = decodeURIComponent(encodedName)
  const [events, setEvents] = useState<DetectionEvent[] | null>(null)
  const [knownNames, setKnownNames] = useState<string[]>([])
  const [alertsEnabled, setAlertsEnabled] = useState(true)
  const [mergeTarget, setMergeTarget] = useState('')
  const [selected, setSelected] = useState<DetectionEvent | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [mergeResult, setMergeResult] = useState<FaceMergeResponse | null>(null)
  const confirm = useConfirm()
  const { user } = useAuth()
  const canManage = isOwner(user)
  const { showToast } = useToast()
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    const ownerDetails = canManage
      ? Promise.all([listFaceCaptureDirs(), getFacePreferences()]).then(
          ([dirResult, preferenceResult]) => ({
            names: dirResult.dirs
              .map((dir) => dir.name)
              .filter((value) => value !== '__unknown__' && value !== name),
            alertsEnabled:
              preferenceResult.items.find((item) => item.name === name)
                ?.alerts_enabled ?? true,
          }),
        )
      : Promise.resolve(null)
    Promise.all([
      searchEvents({ person_name: name, limit: 50 }),
      ownerDetails,
    ])
      .then(([eventResult, details]) => {
        if (cancelled) return
        setEvents(eventResult.items)
        if (details) {
          setKnownNames(details.names)
          setAlertsEnabled(details.alertsEnabled)
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [canManage, name])

  const sortedEvents = useMemo(() => [...(events ?? [])].sort((a, b) => b.ts - a.ts), [events])

  const toggleAlerts = async (enabled: boolean) => {
    const previous = alertsEnabled
    setAlertsEnabled(enabled)
    try {
      const saved = await setFacePreference(name, enabled)
      setAlertsEnabled(saved.alerts_enabled)
    } catch {
      setAlertsEnabled(previous)
      showToast('Could not change face alerts', 'error')
    }
  }

  const merge = async () => {
    if (!mergeTarget || busy) return
    const ok = await confirm({
      title: `Merge ${name} into ${mergeTarget}?`,
      body: `Historical events and saved training photos will move to ${mergeTarget}. The camera must be retrained before future recognition uses the merged identity. This cannot be automatically split later.`,
      confirmLabel: 'Merge faces',
      destructive: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const result = await mergeFaces(name, mergeTarget)
      setMergeResult(result)
      showToast(
        result.retrain_required
          ? `Merged into ${mergeTarget}; retraining required`
          : `Merged into ${mergeTarget}`,
        'success',
      )
    } catch {
      showToast('Could not merge faces', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="p-4"><ErrorState title="Could not load person" message="Check the connection and try again." technicalDetail={error instanceof Error ? error.message : String(error)} /></div>

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl capitalize text-[var(--color-text-primary)]">{name}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Recognition, alerts, and recent visits.</p>
        </div>
        <Link to="/people" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">Back</Link>
      </header>

      {canManage ? (
      <section className="card-paper divide-y divide-[var(--color-border-subtle)]" aria-labelledby="person-options-h2">
        <h2 id="person-options-h2" className="p-4 text-lg font-semibold">Person settings</h2>
        <div className="flex items-center justify-between gap-3 p-4">
          <span>Alert when {name} arrives</span>
          <Toggle checked={alertsEnabled} onChange={(enabled) => void toggleAlerts(enabled)} ariaLabel={`Alert when ${name} arrives`} />
        </div>
        {knownNames.length > 0 ? (
          <div className="space-y-2 p-4">
            <label className="block text-sm text-[var(--color-text-secondary)]">
              Merge duplicate identity into
              <select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]">
                <option value="">Choose person…</option>
                {knownNames.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <Button variant="destructive" disabled={!mergeTarget} loading={busy} loadingText="Merging…" onClick={() => void merge()}>Merge identity</Button>
          </div>
        ) : null}
      </section>
      ) : null}

      {canManage && mergeResult ? (
        <section
          role="status"
          className="space-y-2 rounded-[var(--radius-xl)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-4"
        >
          <h2 className="font-semibold">Identity merged into {mergeResult.target_name}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Updated {mergeResult.events_updated} historical events and moved {mergeResult.files_moved} saved training photos.
          </p>
          {mergeResult.retrain_required ? (
            <p className="text-sm font-semibold">
              Retraining is required before the camera can recognize future visits as {mergeResult.target_name}.
            </p>
          ) : null}
          <Button onClick={() => navigate(`/people/${encodeURIComponent(mergeResult.target_name)}`, { replace: true })}>
            Open {mergeResult.target_name}
          </Button>
        </section>
      ) : null}

      <section aria-labelledby="person-events-h2" className="space-y-3">
        <h2 id="person-events-h2" className="text-lg font-semibold">Recent events</h2>
        {events === null ? <p role="status">Loading events…</p> : (
          <ol className="space-y-2">
            {sortedEvents.map((event) => <li key={event.id}><EventRow event={event} subline={event.rule_name ?? event.source ?? 'Recognized'} onOpen={() => setSelected(event)} /></li>)}
          </ol>
        )}
      </section>
      {selected ? <ClipModal event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
