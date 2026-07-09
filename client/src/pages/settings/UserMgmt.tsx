import { useEffect, useState } from 'react'
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminResetPassword,
  changePassword,
  HttpError,
  type AdminRole,
  type AdminUserRow,
} from '../../lib/api'
import { isOwnerRole } from '../../lib/roles'

// iter-279 (code-scalability-auditor T2): replace 4 inline
// `as { status?: number }` casts in this file with a typed
// helper. HttpError is the only path that carries `.status` —
// any other thrown value (TypeError from a buggy fetch shim,
// strings, etc.) falls through. Single source of truth for the
// "is this an HTTP-level rejection with this code?" check.
function _httpErrorStatus(e: unknown): number | undefined {
  return e instanceof HttpError ? e.status : undefined
}
import { useAuth } from '../../lib/auth'
import { useConfirm } from '../../lib/confirm'
import { formatError } from '../../lib/format'
import { log, errFields } from '../../lib/log'
import { useReportError, useToast } from '../../lib/toast'
import { Button } from '../../components/primitives/Button'
import { Row } from './parts'

// iter-268: extracted from Settings.tsx (1969 → ~1480 lines after this
// pull-out, removing ChangePasswordRow + ManageUsersPanel + AddUserForm
// + InlineResetPasswordForm — all four lived inline). Refactor only;
// no behavior change. iter-265 + iter-266 history preserved in the
// per-component leading comments.

// iter-264 + iter-258: self-service password change. Form opens
// inline under "Account → Password". 8-char floor matches
// `/api/auth/change_password`'s server-side Pydantic min.
export function ChangePasswordRow() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()
  const reportError = useReportError()
  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirmPw('')
  }
  const onSubmit = async () => {
    if (next !== confirmPw) {
      showToast('New passwords do not match', 'error')
      return
    }
    if (next.length < 8) {
      // iter-264 (security-auditor B1 client mirror): server rejects
      // new passwords shorter than 8 chars. Pre-check on the client
      // so the user gets an inline error instead of a generic 422.
      showToast('New password must be at least 8 characters', 'error')
      return
    }
    setSubmitting(true)
    try {
      await changePassword(current, next)
      showToast('Password changed', 'success')
      reset()
      setOpen(false)
    } catch (e) {
      const status = _httpErrorStatus(e)
      if (status === 401) {
        // 401 = wrong current password; user-recoverable, expected.
        // Toast only — no log (would be noise on a routine typo).
        showToast('Current password is incorrect', 'error')
      } else {
        // docs/logging_plan.md §2 + §4: the generic fallback was
        // silent. Log the status — NEVER the password values, which
        // are in `current`/`next` scope here.
        reportError(
          'userMgmt:change-password-failed',
          `Could not change password: ${formatError(e)}`,
          errFields(e),
        )
      }
    } finally {
      setSubmitting(false)
    }
  }
  if (!open) {
    return (
      <Row
        label="Password"
        right={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOpen(true)}
          >
            Change
          </Button>
        }
      />
    )
  }
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="text-sm text-[var(--color-text-primary)]">Change password</div>
      <input
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        placeholder="Current password"
        autoComplete="current-password"
        aria-label="Current password"
        className="w-full bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="New password (8+ characters)"
        autoComplete="new-password"
        aria-label="New password"
        className="w-full bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <input
        type="password"
        value={confirmPw}
        onChange={(e) => setConfirmPw(e.target.value)}
        placeholder="Confirm new password"
        autoComplete="new-password"
        aria-label="Confirm new password"
        className="w-full bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size="md"
          fullWidth
          loading={submitting}
          loadingText="Saving…"
          onClick={onSubmit}
          disabled={!current || !next || !confirmPw}
        >
          Save
        </Button>
        <Button
          variant="secondary"
          size="md"
          fullWidth
          onClick={() => {
            reset()
            setOpen(false)
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

// iter-265: owner-only Manage Users panel. Lists every account with
// per-row reset + delete + an Add User form. Owner-only at the route
// (`require_role('owner')`); the parent Settings.tsx hides this
// component for non-owners.
export function ManageUsersPanel() {
  const { user } = useAuth()
  const { showToast } = useToast()
  const reportError = useReportError()
  const confirm = useConfirm()
  const [users, setUsers] = useState<AdminUserRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  // Track which row's reset form is open (one at a time).
  const [resetOpenFor, setResetOpenFor] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const r = await adminListUsers()
      setUsers(r.users)
      setLoadError(null)
    } catch (e) {
      // docs/logging_plan.md §2: the user-list load showed an inline
      // error string but never logged the status — a 403 (lost owner
      // role mid-session) reads the same as a 5xx to the operator.
      log.warn('userMgmt:list-load-failed', errFields(e))
      setLoadError(formatError(e))
    }
  }

  // CLAUDE.md sharp edge: react-hooks/set-state-in-effect under React
  // 19 + eslint-plugin-react-hooks v7 trips when a helper that
  // synchronously calls `setState` is invoked from inside `useEffect`.
  // Inline the fetch with a `cancelled` flag and put setState calls
  // in then/catch.
  useEffect(() => {
    let cancelled = false
    adminListUsers()
      .then((r) => {
        if (cancelled) return
        setUsers(r.users)
        setLoadError(null)
      })
      .catch((e) => {
        // Logged before the cancelled guard so an unmount mid-load is
        // still recorded.
        log.warn('userMgmt:list-load-failed', errFields(e))
        if (cancelled) return
        setLoadError(formatError(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onCreated = async () => {
    setAddOpen(false)
    await refresh()
  }

  const onResetSaved = async () => {
    setResetOpenFor(null)
    await refresh()
  }

  const onDelete = async (target: AdminUserRow) => {
    const ok = await confirm({
      title: `Delete ${target.username}?`,
      // iter-266 (UX-auditor #1): destructive copy mirrors voice
      // used by reboot/restore confirms ("This cannot be undone…").
      body: `This cannot be undone. ${target.username} will lose access to the cameras and any push notifications they had set up. Their next page load will return them to the login screen.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      await adminDeleteUser(target.username)
      showToast(`Deleted ${target.username}`, 'success')
      await refresh()
    } catch (e) {
      const status = _httpErrorStatus(e)
      if (status === 400) {
        // Server-side guard: self-delete or last-owner delete. Expected
        // user error — toast only.
        showToast(formatError(e), 'error')
      } else if (status === 404) {
        showToast('User no longer exists', 'error')
        await refresh()
      } else {
        // docs/logging_plan.md §2: the generic fallback was silent. Log
        // the target username (NOT a password — none in scope here) +
        // status so a failed delete on a household account is traceable.
        reportError(
          'userMgmt:delete-user-failed',
          `Could not delete: ${formatError(e)}`,
          { username: target.username, ...errFields(e) },
        )
      }
    }
  }

  return (
    <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--color-text-primary)]">Manage users</div>
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="text-sm text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
        >
          {addOpen ? 'Cancel' : 'Add user'}
        </button>
      </div>
      {addOpen ? (
        <AddUserForm onCreated={onCreated} onCancel={() => setAddOpen(false)} />
      ) : null}
      {loadError ? (
        <p className="text-xs text-[var(--color-danger)]">
          Could not load users: {loadError}
        </p>
      ) : users === null ? (
        <p className="text-xs text-[var(--color-text-secondary)]">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-xs text-[var(--color-text-secondary)]">No users yet.</p>
      ) : (
        <ul className="space-y-2" aria-label="User accounts">
          {users.map((u) => {
            const isSelf = u.username === user?.username
            // 2026-07-09 policy ("users shouldn't be able to delete admin"):
            // owner/admin-tier accounts are protected entirely — only
            // family/viewer users are deletable. Mirrors the server guard
            // (users_db.CannotDeletePrivilegedUser). Subsumes the old
            // last-owner-only disable.
            const isPrivileged = isOwnerRole(u.role)
            const resetOpen = resetOpenFor === u.username
            return (
              <li
                key={u.username}
                // Sunroom sweep: /opacity-on-var surface → solid raised
                // paper so user rows read as tiles inside the card.
                className="rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-3 py-2 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--color-text-primary)] truncate">
                      {u.username}
                      {isSelf ? (
                        <span className="ml-2 text-[11px] text-[var(--color-text-secondary)]">
                          (you)
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-secondary)]">{u.role}</div>
                  </div>
                  {/* iter-285 (mobile-view-auditor B1) +
                      iter-287 (desktop-view-auditor E1): the per-row
                      Set/Delete buttons need a thumb-friendly target
                      on mobile (44 px via `px-3 py-2 -my-1`) but
                      that padding looks crowded at cursor precision.
                      `lg:px-1 lg:py-0.5 lg:my-0` shrinks back to a
                      tight underline-link on lg+, restoring the
                      desktop visual rhythm. Same on the gap: gap-3
                      (12 px) on mobile to avoid mis-taps; gap-2
                      (8 px) on desktop where cursor precision is
                      higher. */}
                  <div className="flex items-center gap-3 lg:gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setResetOpenFor(resetOpen ? null : u.username)
                      }
                      className="text-xs text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded px-3 py-2 -my-1 lg:px-1 lg:py-0.5 lg:my-0"
                    >
                      {/* iter-266 (UX-auditor #4): match label to the
                          act ("type a new one, save it"). */}
                      {resetOpen ? 'Close' : 'Set new password'}
                    </button>
                    {/* Sunroom fix: destructive action uses the Button
                        primitive (solid danger-strong fill) instead of a
                        hand-rolled danger link with a hover:opacity
                        cheat. */}
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void onDelete(u)}
                      disabled={isSelf || isPrivileged}
                      aria-describedby={
                        isSelf || isPrivileged
                          ? `delete-disabled-${u.username}`
                          : undefined
                      }
                      title={
                        isSelf
                          ? "You can't delete your own account"
                          : isPrivileged
                            ? "Admin and owner accounts can't be deleted"
                            : undefined
                      }
                    >
                      Delete
                    </Button>
                  </div>
                </div>
                {/* iter-266 (UX-auditor #3): `title=` tooltips never
                    show on touch. Inline hint mirrors the disabled
                    reason on every form factor. */}
                {(isSelf || isPrivileged) ? (
                  <p
                    id={`delete-disabled-${u.username}`}
                    className="text-[11px] text-[var(--color-text-tertiary)]"
                  >
                    {isSelf
                      ? "You can't delete your own account."
                      : "Admin and owner accounts can't be deleted."}
                  </p>
                ) : null}
                {resetOpen ? (
                  <InlineResetPasswordForm
                    username={u.username}
                    onDone={onResetSaved}
                    onCancel={() => setResetOpenFor(null)}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function AddUserForm(props: {
  onCreated: () => void | Promise<void>
  onCancel: () => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<AdminRole>('family')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()
  const reportError = useReportError()
  const onSubmit = async () => {
    if (!username) {
      showToast('Username is required', 'error')
      return
    }
    if (password.length < 8) {
      showToast('Password must be at least 8 characters', 'error')
      return
    }
    setSubmitting(true)
    try {
      await adminCreateUser(username, password, role)
      showToast(`Created ${username}`, 'success')
      setUsername('')
      setPassword('')
      setRole('family')
      await props.onCreated()
    } catch (e) {
      const status = _httpErrorStatus(e)
      if (status === 409) {
        // Username-taken — expected user error, toast only.
        showToast(`Username "${username}" is already taken`, 'error')
      } else {
        // docs/logging_plan.md §2 + §4: the generic fallback was
        // silent. Log the username + role + status. CRITICAL: the new
        // user's `password` is in scope here — it MUST NOT appear in
        // the fields. Only username/role/status are passed.
        reportError(
          'userMgmt:create-user-failed',
          `Could not create user: ${formatError(e)}`,
          { username, role, ...errFields(e) },
        )
      }
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div
      className="rounded-lg bg-[var(--color-surface-raised)] border border-[var(--color-border)] px-3 py-3 space-y-2"
      aria-label="Add user form"
    >
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
        autoComplete="off"
        aria-label="New username"
        className="w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password (8+ characters)"
        autoComplete="new-password"
        aria-label="New user password"
        className="w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <label className="block text-xs text-[var(--color-text-secondary)]">
        Role
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as AdminRole)}
          aria-label="Role for new user"
          className="mt-1 w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-sm border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          <option value="owner">Owner — full control</option>
          <option value="family">Family — view + push</option>
          <option value="viewer">Viewer — read-only</option>
        </select>
      </label>
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          size="md"
          fullWidth
          loading={submitting}
          loadingText="Creating…"
          onClick={onSubmit}
          disabled={!username || !password}
        >
          Create user
        </Button>
        <Button
          variant="secondary"
          size="md"
          fullWidth
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

function InlineResetPasswordForm(props: {
  username: string
  onDone: () => void | Promise<void>
  onCancel: () => void
}) {
  const [next, setNext] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { showToast } = useToast()
  const reportError = useReportError()
  const onSubmit = async () => {
    if (next.length < 8) {
      showToast('Password must be at least 8 characters', 'error')
      return
    }
    setSubmitting(true)
    try {
      await adminResetPassword(props.username, next)
      showToast(`Reset password for ${props.username}`, 'success')
      setNext('')
      await props.onDone()
    } catch (e) {
      const status = _httpErrorStatus(e)
      if (status === 404) {
        // User vanished between list + reset — expected, toast only.
        showToast(`No user named "${props.username}"`, 'error')
      } else {
        // docs/logging_plan.md §2 + §4: log username + status. The new
        // password in `next` MUST NOT be logged — only the shape.
        reportError(
          'userMgmt:reset-password-failed',
          `Could not reset password: ${formatError(e)}`,
          { username: props.username, ...errFields(e) },
        )
      }
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="space-y-2">
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder="New password (8+ characters)"
        autoComplete="new-password"
        aria-label={`New password for ${props.username}`}
        // iter-356.66 (iOS oddities sweep): was text-sm (14 px), which
        // triggers iOS Safari's auto-zoom-on-focus (anything < 16 px
        // pixel-sizes the input and reflows the page). Bumped to
        // text-base so the inline reset form stops jumping the page
        // when the operator focuses it on a phone.
        className="w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] px-3 py-2 rounded-lg text-base border border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
      />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="md"
          fullWidth
          loading={submitting}
          loadingText="Saving…"
          onClick={onSubmit}
          disabled={!next}
        >
          Save
        </Button>
        <Button
          variant="secondary"
          size="md"
          fullWidth
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
