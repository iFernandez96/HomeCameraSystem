import { useEffect, useState, type MouseEvent } from 'react'
import { Button } from '../../components/primitives/Button'
import {
  createIncident,
  getNotificationInbox,
  markNotificationSeen,
  retainNotificationEvent,
  snoozeNotification,
  type NotificationInboxItem,
} from '../../lib/api'
import { useToast } from '../../lib/toast'
import { Section } from './parts'

const deliveryCopy: Record<NotificationInboxItem['delivery_state'], string> = {
  queued: 'Sending',
  gateway_accepted: 'Push accepted · display unconfirmed',
  gateway_failed: 'Delivery failed',
  gateway_unavailable: 'Push unavailable',
  displayed: 'Displayed on at least one device',
  display_failed: 'Could not display',
  snoozed: 'Snoozed',
}

export function NotificationInbox({ canRetain = false }: { canRetain?: boolean }) {
  const [items, setItems] = useState<NotificationInboxItem[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    const load = () => {
      getNotificationInbox(50)
        .then((value) => {
          if (!cancelled) {
            setItems(value.items)
            setLoadError(false)
          }
        })
        .catch(() => {
          if (!cancelled) setLoadError(true)
        })
    }
    load()
    const interval = window.setInterval(load, 30_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const markSeen = async (item: NotificationInboxItem) => {
    if (item.seen) return
    setItems((current) => current?.map((row) => row.id === item.id ? { ...row, seen: true } : row) ?? current)
    try {
      await markNotificationSeen(item.id)
    } catch {
      setItems((current) => current?.map((row) => row.id === item.id ? item : row) ?? current)
    }
  }

  const snooze = async (item: NotificationInboxItem) => {
    try {
      await snoozeNotification(item.id, 3600)
      showToast(`${item.kind} alerts snoozed for one hour`, 'info')
    } catch {
      showToast('Could not snooze this alert type', 'error')
    }
  }

  const savePermanently = async (item: NotificationInboxItem) => {
    try {
      await retainNotificationEvent(item.id, 'permanent')
      showToast('Event saved permanently', 'success')
    } catch {
      showToast('Could not save this event', 'error')
    }
  }

  const startIncident = async (item: NotificationInboxItem) => {
    if (!item.event_id) return
    try {
      await createIncident(`Alert: ${item.title}`, item.body, item.event_id)
      showToast('Incident created with this event', 'success')
    } catch {
      showToast('Could not create an incident', 'error')
    }
  }

  const viewAlert = async (event: MouseEvent<HTMLAnchorElement>, item: NotificationInboxItem) => {
    event.preventDefault()
    await markSeen(item)
    const destination = item.url.startsWith('/') && !item.url.startsWith('//')
      ? item.url
      : '/events'
    window.location.assign(destination)
  }

  return (
    <Section title="Notification inbox" subtitle="Every alert keeps an honest delivery state and useful actions.">
      <div className="space-y-2 p-3">
        {items === null ? <p role="status" className="text-sm text-[var(--color-text-secondary)]">Loading alerts…</p> : null}
        {loadError ? <p role="alert" className="text-sm text-[var(--color-danger)]">Alerts could not be refreshed. The last confirmed list remains below.</p> : null}
        {items?.length === 0 && !loadError ? <p className="text-sm text-[var(--color-text-secondary)]">New alerts will appear here, even when a phone cannot display them.</p> : null}
        {items?.map((item) => (
          <article
            key={`${item.id}:${item.created_ts}`}
            className={`rounded-xl border p-3 ${item.seen ? 'border-[var(--color-border-subtle)]' : 'border-[var(--color-accent-border)] bg-[var(--color-accent-subtle)]'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-semibold text-[var(--color-text-primary)]">{item.title}</h3>
                <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{item.body}</p>
                <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
                  {deliveryCopy[item.delivery_state]} · {new Date(item.created_ts * 1000).toLocaleString()}
                </p>
              </div>
              {!item.seen ? <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-accent-default)]" aria-label="Unread" /> : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={item.url || '/events'}
                onClick={(event) => void viewAlert(event, item)}
                className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]"
              >
                View
              </a>
              {item.event_id && canRetain ? <Button size="sm" variant="secondary" onClick={() => void savePermanently(item)}>Save permanently</Button> : null}
              {item.event_id && canRetain ? <Button size="sm" variant="secondary" onClick={() => void startIncident(item)}>Create incident</Button> : null}
              {item.event_id && /unknown/i.test(`${item.kind} ${item.title} ${item.body}`) ? <a href="/training" className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-[var(--color-accent-deep)]">Identify person</a> : null}
              <Button size="sm" variant="ghost" onClick={() => void snooze(item)}>Snooze 1 hour</Button>
            </div>
          </article>
        ))}
      </div>
    </Section>
  )
}
