import { useEffect, useState } from 'react'
import { getServerVersion, type SystemVersion } from '../../lib/api'
import { log, errFields } from '../../lib/log'
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { isGodModeUser, isOwner } from '../../lib/roles'
import { Mono, Row, Section } from './parts'
import { ChangePasswordRow, ManageUsersPanel } from './UserMgmt'
import { MfaControls } from './MfaControls'

// iter-294: extracted from Settings.tsx (~35 lines of inline JSX +
// serverVersion state + getServerVersion mount effect). Owns the
// "Logged in as", "Server version", ChangePasswordRow, ManageUsersPanel
// (owner-only), and Sign out button. Settings.tsx is now a pure
// shell — tabs + section composition only.

export function AccountSection() {
  const { user, logout } = useAuth()
  const confirm = useConfirm()
  const canManageUsers = isOwner(user)

  // iter-356.12 (Frank Round-2 #7): wife accidentally tapped Sign Out
  // and locked out the household until Frank entered the password.
  // Confirm dialog converts a 1-tap accident into a 2-step intent.
  async function handleSignOut() {
    const ok = await confirm({
      title: 'Sign out?',
      body: "You'll need your password to sign back in.",
      confirmLabel: 'Sign out',
      destructive: true,
    })
    if (ok) logout()
  }
  const roleLabel = user?.role
    ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
    : null

  // iter-234 (Feature #12 OTA slice 3b): server version pulled from
  // the iter-232 GET route. null = not loaded yet OR error fetching;
  // UI shows em-dash so the row never appears empty.
  const [serverVersion, setServerVersion] = useState<SystemVersion | null>(null)
  // iter-356.10 (Frank #5): per-device toggle for the ambient cat
  // layer. Default on; flipping persists to localStorage and
  // immediately hides/shows the layer in App.tsx.
  useEffect(() => {
    let cancelled = false
    getServerVersion()
      .then((r) => {
        if (cancelled) return
        setServerVersion(r)
      })
      .catch((e) => {
        // docs/logging_plan.md §2: version is informational and stays
        // fail-quiet (em-dash) in the UI, but log at DEBUG so an
        // always-failing version probe is diagnosable without adding
        // noise at the default level. Logged before the cancelled guard.
        log.debug('account:version-fetch-failed', errFields(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Section title="Account">
      <Row
        label="Logged in as"
        right={
          <span className="text-sm text-[var(--color-text-primary)]">
            {user
              ? roleLabel
                ? `${user.username} (${roleLabel})`
                : user.username
              : '—'}
          </span>
        }
      />
      {/* iter-234 (Feature #12 slice 3b): server version. Em-dash
          while loading or on error; informational only. */}
      <Row
        // iter-356.56 (Settings redesign brief): "Server version" is
        // developer vocabulary. The user installed "the app"; the
        // version they see IS the running server build, but mapping
        // it to "App version" is closer to what they expect.
        label="App version"
        right={<Mono>{serverVersion?.version ?? '—'}</Mono>}
      />
      <Row label="Client bundle" right={<Mono>{typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}</Mono>} />
      <Row label="Server build" right={<Mono>{serverVersion?.source_fingerprint ?? '—'}</Mono>} />
      <Row label="Android wrapper" right={<Mono>{navigator.userAgent.match(/HomeCamNative\/([^\s]+)/)?.[1] ?? 'Browser'}</Mono>} />
      {isGodModeUser(user) ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--color-border-subtle)] p-3">
          <a href="/control" className="inline-flex min-h-11 items-center rounded-full px-3 font-semibold text-[var(--color-accent-deep)]">Control Center</a>
          <a href="/god" className="inline-flex min-h-11 items-center rounded-full px-3 font-semibold text-[var(--color-accent-deep)]">God View</a>
        </div>
      ) : null}
      <ChangePasswordRow />
      {canManageUsers ? <MfaControls /> : null}
      {/* Bug sweep (2026-07-02): the "Show ambient cats" toggle was
          removed — the CatLayer it controlled is unmounted since the
          Watch structural overhaul (sprites walked over the today-
          timeline). The catPref plumbing stays for a future surface
          with real floor space. */}
      {/* iter-265: owner-only Manage Users panel. Family/viewer
          roles never see this. */}
      {canManageUsers ? <ManageUsersPanel /> : null}
      {/* iter-355ac (Maya Major): Sign out from someone else's
          session is destructive-adjacent on a shared device.
          iter-356.56 (Frank S4 + light-theme contrast): swept from
          dark-theme red-300/red-900 (illegible on cream) to the
          token-driven danger surface that the destructive Button
          variant uses. Same tinted surface family used by
          confirm-dialog destructive button. */}
      <button
        type="button"
        onClick={handleSignOut}
        className="w-full text-sm border border-[var(--color-danger-muted)] text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] hover:border-[var(--color-danger-border)] rounded-lg px-3 py-2 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-danger)] focus-visible:outline-offset-2 transition-colors font-medium"
      >
        Sign out
      </button>
    </Section>
  )
}
