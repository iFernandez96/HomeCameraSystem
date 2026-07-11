import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { EventRow } from '../components/EventRow'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import {
  deleteIncident,
  exportIncident,
  getIncident,
  removeIncidentEvent,
  updateIncident,
  type IncidentDetail as IncidentDetailModel,
} from '../lib/api'
import type { DetectionEvent } from '../lib/types'
import { useConfirm } from '../lib/confirm'
import { useToast } from '../lib/toast'
import { useAuth } from '../lib/auth'
import { isOwner } from '../lib/roles'

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function IncidentDetail() {
  const { id = '' } = useParams()
  const [incident, setIncident] = useState<IncidentDetailModel | null>(null)
  const [selected, setSelected] = useState<DetectionEvent | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const confirm = useConfirm()
  const { user } = useAuth()
  const canManage = isOwner(user)
  const navigate = useNavigate()
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    getIncident(id)
      .then((value) => {
        if (!cancelled) setIncident(value)
      })
      .catch((reason) => {
        if (!cancelled) setError(reason)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const save = async () => {
    if (!incident || busy || !canManage) return
    setBusy(true)
    try {
      setIncident(await updateIncident(incident.id, { title: incident.title, notes: incident.notes }))
      showToast('Incident saved', 'success')
    } catch {
      showToast('Could not save incident', 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeEvent = async (event: DetectionEvent) => {
    if (!incident || !canManage) return
    try {
      setIncident(await removeIncidentEvent(incident.id, event.id))
      showToast('Event removed from incident', 'success')
    } catch {
      showToast('Could not remove event', 'error')
    }
  }

  const download = async () => {
    if (!incident || !canManage) return
    setBusy(true)
    try {
      saveBlob(await exportIncident(incident.id), `homecam-incident-${incident.id}.zip`)
    } catch {
      showToast('Could not export incident', 'error')
    } finally {
      setBusy(false)
    }
  }

  const removeIncident = async () => {
    if (!incident || !canManage) return
    const ok = await confirm({
      title: 'Delete this incident?',
      body: 'The incident notes and grouping will be removed. Original events are not deleted.',
      confirmLabel: 'Delete incident',
      destructive: true,
    })
    if (!ok) return
    await deleteIncident(incident.id)
    navigate('/events/incidents', { replace: true })
  }

  if (error) {
    return <div className="p-4"><ErrorState title="Could not load incident" message="It may have been removed." technicalDetail={error instanceof Error ? error.message : String(error)} /></div>
  }
  if (!incident) return <div className="p-4" role="status">Loading incident…</div>

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl text-[var(--color-text-primary)]">Incident details</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{incident.event_count} evidence events</p>
        </div>
        <Link to="/events/incidents" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">Back</Link>
      </header>

      <section className="card-paper space-y-3 p-4" aria-label="Incident notes">
        {canManage ? (
        <>
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          Title
          <input
            value={incident.title}
            onChange={(event) => setIncident({ ...incident, title: event.target.value })}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base text-[var(--color-text-primary)]"
          />
        </label>
        <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
          Notes
          <textarea
            value={incident.notes}
            onChange={(event) => setIncident({ ...incident, notes: event.target.value })}
            rows={4}
            className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-base text-[var(--color-text-primary)]"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} loading={busy} loadingText="Saving…">Save</Button>
          <Button variant="secondary" onClick={() => void download()} disabled={busy || incident.events.length === 0}>Export evidence</Button>
          <Button variant="destructive" onClick={() => void removeIncident()}>Delete incident</Button>
        </div>
        </>
        ) : (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{incident.title}</h2>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-text-secondary)]">
              {incident.notes || 'No notes have been added.'}
            </p>
            <p className="text-xs font-semibold text-[var(--color-text-tertiary)]">Read-only incident access</p>
          </div>
        )}
      </section>

      <section aria-labelledby="incident-evidence-h2" className="space-y-3">
        <h2 id="incident-evidence-h2" className="text-lg font-semibold">Evidence</h2>
        {incident.events.length === 0 ? (
          <CatEmptyState heading="No evidence added" body="Open Events, select activity, and add it to this incident." />
        ) : (
          <ol className="space-y-2">
            {incident.events.map((event) => (
              <li key={event.id} className="card-paper p-2">
                <EventRow event={event} subline={event.rule_name ?? event.source ?? 'Recorded event'} onOpen={() => setSelected(event)} />
                {canManage ? <Button variant="ghost" size="sm" onClick={() => void removeEvent(event)} aria-label={`Remove ${event.label} event from incident`}>Remove</Button> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
      {selected ? <ClipModal event={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}
