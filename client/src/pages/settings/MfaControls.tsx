import { useEffect, useState } from 'react'
import { Button } from '../../components/primitives/Button'
import {
  beginMfaSetup,
  confirmMfaSetup,
  disableMfa,
  getMfaStatus,
  HttpError,
} from '../../lib/api'
import type { MfaSetup } from '../../lib/types'
import { errFields, log } from '../../lib/log'
import { useReportError, useToast } from '../../lib/toast'

export function MfaControls() {
  const { showToast } = useToast()
  const reportError = useReportError()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'closed' | 'setup-password' | 'confirm' | 'disable'>('closed')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<MfaSetup | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getMfaStatus()
      .then((value) => {
        if (!cancelled) setEnabled(value.enabled)
      })
      .catch((error) => {
        if (!cancelled) {
          setEnabled(null)
          log.debug('mfa:status-failed', errFields(error))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function startSetup() {
    setBusy(true)
    try {
      const value = await beginMfaSetup(password)
      setSetup(value)
      setPassword('')
      setMode('confirm')
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        showToast('Current password is incorrect', 'error')
      } else {
        reportError('mfa:setup-failed', 'Could not start two-step verification', {
          status: error instanceof HttpError ? error.status : null,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function confirmSetup() {
    setBusy(true)
    try {
      await confirmMfaSetup(code)
      setEnabled(true)
      setCode('')
      setSetup(null)
      setMode('closed')
      showToast('Two-step verification enabled', 'success')
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        showToast('That verification code is incorrect or expired', 'error')
      } else {
        reportError('mfa:confirm-failed', 'Could not confirm two-step verification', {
          status: error instanceof HttpError ? error.status : null,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  async function turnOff() {
    setBusy(true)
    try {
      await disableMfa(password, code)
      setEnabled(false)
      setPassword('')
      setCode('')
      setMode('closed')
      showToast('Two-step verification turned off', 'info')
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        showToast('Password or verification code is incorrect', 'error')
      } else {
        reportError('mfa:disable-failed', 'Could not turn off two-step verification', {
          status: error instanceof HttpError ? error.status : null,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-[var(--color-border-subtle)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-[var(--color-text-primary)]">Two-step verification</p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {enabled == null ? 'Checking…' : enabled ? 'Authenticator required at sign-in' : 'Protect this admin account'}
          </p>
        </div>
        {mode === 'closed' && enabled != null ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setMode(enabled ? 'disable' : 'setup-password')}
          >
            {enabled ? 'Turn off' : 'Set up'}
          </Button>
        ) : null}
      </div>

      {mode === 'setup-password' ? (
        <div className="space-y-2">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Current password"
            aria-label="Current password for two-step verification"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base"
          />
          <Button size="sm" onClick={startSetup} disabled={busy || !password}>
            Continue
          </Button>
        </div>
      ) : null}

      {mode === 'confirm' && setup ? (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <p className="text-sm text-[var(--color-text-primary)]">
            Add this key to your authenticator app, then enter its six-digit code.
          </p>
          <code className="block break-all rounded bg-[var(--color-surface)] p-2 text-sm select-all">
            {setup.secret}
          </code>
          <a
            href={setup.provisioning_uri}
            className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-accent-default)] underline underline-offset-2"
          >
            Open authenticator app
          </a>
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-primary)]">Save these one-time recovery codes</p>
            <ul className="mt-1 grid grid-cols-2 gap-1" aria-label="Recovery codes">
              {setup.recovery_codes.map((recoveryCode) => (
                <li key={recoveryCode}><code className="text-xs select-all">{recoveryCode}</code></li>
              ))}
            </ul>
          </div>
          <input
            type="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            placeholder="Six-digit code"
            aria-label="Authenticator verification code"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base"
          />
          <Button size="sm" onClick={confirmSetup} disabled={busy || code.length < 6}>
            Verify and enable
          </Button>
        </div>
      ) : null}

      {mode === 'disable' ? (
        <div className="space-y-2">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Current password"
            aria-label="Current password to disable two-step verification"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base"
          />
          <input
            type="text"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.trim())}
            placeholder="Authenticator or recovery code"
            aria-label="Code to disable two-step verification"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base"
          />
          <Button variant="destructive" size="sm" onClick={turnOff} disabled={busy || !password || code.length < 6}>
            Confirm turn off
          </Button>
        </div>
      ) : null}
    </div>
  )
}
