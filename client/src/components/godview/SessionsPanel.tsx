import { useCallback, useEffect, useState } from 'react'
import { CatEmptyState } from '../CatEmptyState'
import { Button } from '../primitives/Button'
import { listSessions, revokeSession } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { formatError } from '../../lib/format'
import { identityForName } from '../../lib/identity'
import { isOwner } from '../../lib/roles'
import type { Session, User } from '../../lib/types'
import { useReportError, useToast } from '../../lib/toast'
import { ErrorState } from '../states/ErrorState'
import { LoadingState } from '../states/LoadingState'

type LoadState =
  | { status: 'loading'; sessions: Session[]; error: null }
  | { status: 'ready'; sessions: Session[]; error: null }
  | { status: 'error'; sessions: Session[]; error: unknown }

const LOCATION_LABELS: Record<Session['ip_class'], string> = {
  lan: 'LAN',
  tailscale: 'Tailscale',
  cellular: 'Cellular / public',
  other: 'Unknown',
}

function relativeTime(ts: number, nowMs = Date.now()): string {
  const ageSeconds = Math.max(0, Math.round(nowMs / 1000 - ts))
  if (ageSeconds < 30) return 'active now'
  if (ageSeconds < 90) return '1 min ago'
  const minutes = Math.round(ageSeconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: Session
  onRevoke: (session: Session) => void
  revoking: boolean
}) {
  const identity = identityForName(session.username)
  const revoked = session.revoked
  return (
    <li
      className={`rounded-lg border-[1.5px] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-subtle)] ${
        session.is_current
          ? 'border-[var(--color-accent-default)]'
          : 'border-[var(--color-border)]'
      } ${revoked ? 'opacity-65' : ''}`}
      aria-label={`${session.device_label}, ${session.username}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-1 h-3 w-3 flex-shrink-0 rounded"
            style={{ backgroundColor: identity.colorVar }}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className={`font-semibold text-[var(--color-text-primary)] ${revoked ? 'line-through' : ''}`}>
                {session.device_label}
              </p>
              {session.is_current && (
                <span className="rounded-full border border-[var(--color-accent-border)] bg-[var(--color-accent-subtle)] px-2 py-0.5 text-xs font-semibold text-[var(--color-accent-default)]">
                  This device
                </span>
              )}
              {session.watching_now && !revoked && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-success-border)] bg-[var(--color-success-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--color-success)]">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
                  Watching now
                </span>
              )}
              {revoked && (
                <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-xs font-semibold text-[var(--color-text-secondary)]">
                  Revoked
                </span>
              )}
            </div>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-text-secondary)]">
              <div className="inline-flex gap-1">
                <dt className="sr-only">User</dt>
                <dd>{session.username}</dd>
              </div>
              <div className="inline-flex gap-1">
                <dt>Location</dt>
                <dd className="font-medium text-[var(--color-text-primary)]">
                  {LOCATION_LABELS[session.ip_class]}
                </dd>
              </div>
              <div className="inline-flex gap-1">
                <dt>Last seen</dt>
                <dd className="font-medium text-[var(--color-text-primary)]">
                  {relativeTime(session.last_seen_ts)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        {!session.is_current && !revoked && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => onRevoke(session)}
            loading={revoking}
            loadingText="Revoking"
            aria-label={`Revoke ${session.device_label}`}
          >
            Revoke
          </Button>
        )}
      </div>
    </li>
  )
}

export function SessionsPanel({ user }: { user: User | null | undefined }) {
  const [state, setState] = useState<LoadState>({
    status: 'loading',
    sessions: [],
    error: null,
  })
  const [revokingJti, setRevokingJti] = useState<string | null>(null)
  const confirm = useConfirm()
  const { showToast } = useToast()
  const reportError = useReportError()
  const canManage = isOwner(user)

  const load = useCallback(() => {
    if (!canManage) return
    setState((cur) => ({ status: 'loading', sessions: cur.sessions, error: null }))
    listSessions()
      .then((res) => {
        setState({ status: 'ready', sessions: res.sessions, error: null })
      })
      .catch((e) => {
        setState((cur) => ({ status: 'error', sessions: cur.sessions, error: e }))
      })
  }, [canManage])

  useEffect(() => {
    if (!canManage) return
    let cancelled = false
    listSessions()
      .then((res) => {
        if (cancelled) return
        setState({ status: 'ready', sessions: res.sessions, error: null })
      })
      .catch((e) => {
        if (cancelled) return
        setState((cur) => ({ status: 'error', sessions: cur.sessions, error: e }))
      })
    return () => {
      cancelled = true
    }
  }, [canManage])

  if (!canManage) return null

  const handleRevoke = async (session: Session) => {
    const ok = await confirm({
      title: 'Revoke this session?',
      body: `${session.username} will be signed out on ${session.device_label}.`,
      confirmLabel: 'Revoke',
      destructive: true,
    })
    if (!ok) return
    setRevokingJti(session.jti)
    try {
      await revokeSession(session.jti)
      showToast('Session revoked', 'success')
      load()
    } catch (e) {
      reportError('sessions:revoke-failed', 'Could not revoke session', {
        error: formatError(e),
      })
    } finally {
      setRevokingJti(null)
    }
  }

  return (
    <section aria-labelledby="active-sessions-heading" className="space-y-3">
      <div>
        <h2 id="active-sessions-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">
          Active sessions
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Signed-in devices. Watching now is based on live app presence.
        </p>
      </div>

      {state.status === 'error' ? (
        <ErrorState
          title="Could not load sessions"
          message="Check the server and try again."
          retry={load}
          technicalDetail={formatError(state.error)}
        />
      ) : state.status === 'loading' && state.sessions.length === 0 ? (
        <LoadingState shape="list" />
      ) : state.sessions.length === 0 ? (
        <div className="rounded-lg border-[1.5px] border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-subtle)]">
          <CatEmptyState
            heading="No devices signed in"
            body="New logins will appear here."
            mood="watching"
            ariaLabel="No active sessions"
          />
        </div>
      ) : (
        <ul className="space-y-2" aria-label="Signed-in sessions">
          {state.sessions.map((session) => (
            <SessionRow
              key={session.jti}
              session={session}
              onRevoke={handleRevoke}
              revoking={revokingJti === session.jti}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
