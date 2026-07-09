import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// docs/logging_plan.md §2 (Auth/RBAC client) + §4 guardrails:
// UserMgmt failure-point logging. The generic-fallback catch branches
// were silent; they must now log the status. CRITICAL guardrail: the
// new-user / reset password values are in scope at the failure site
// and MUST NEVER appear in the logged fields.

import { HttpError } from '../../lib/api'

const adminCreateUser = vi.fn()
const adminDeleteUser = vi.fn()
const adminListUsers = vi.fn()
const adminResetPassword = vi.fn()
const changePassword = vi.fn()

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>(
    '../../lib/api',
  )
  return {
    HttpError: actual.HttpError,
    adminCreateUser: (...a: unknown[]) => adminCreateUser(...a),
    adminDeleteUser: (...a: unknown[]) => adminDeleteUser(...a),
    adminListUsers: (...a: unknown[]) => adminListUsers(...a),
    adminResetPassword: (...a: unknown[]) => adminResetPassword(...a),
    changePassword: (...a: unknown[]) => changePassword(...a),
  }
})

vi.mock('../../lib/auth', () => ({
  useAuth: () => ({ user: { username: 'owner1', role: 'owner' } }),
}))

const confirmFn = vi.fn().mockResolvedValue(true)
vi.mock('../../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))

const showToast = vi.fn()
vi.mock('../../lib/toast', async () => {
  const { log } = await vi.importActual<typeof import('../../lib/log')>(
    '../../lib/log',
  )
  return {
    useToast: () => ({ showToast }),
    useReportError:
      () =>
      (event: string, message: string, fields: Record<string, unknown> = {}) => {
        log.error(event, fields)
        showToast(message, 'error')
      },
  }
})

import { ManageUsersPanel } from './UserMgmt'

beforeEach(() => {
  adminCreateUser.mockReset()
  adminDeleteUser.mockReset()
  adminListUsers
    .mockReset()
    .mockResolvedValue({ users: [{ username: 'owner1', role: 'owner' }] })
  adminResetPassword.mockReset()
  showToast.mockReset()
  confirmFn.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UserMgmt — create-user failure logging (docs/logging_plan.md §2 + §4)', () => {
  it('Given create rejects with a 5xx, When the generic fallback fires, Then it logs username + role + status but NEVER the password', async () => {
    // arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    adminCreateUser.mockRejectedValue(new HttpError('/api/admin/users', 500, 'boom'))
    const user = userEvent.setup()
    render(<ManageUsersPanel />)
    await screen.findByLabelText(/user accounts/i)

    // act — open the Add user form, fill it, submit.
    await user.click(screen.getByRole('button', { name: /add user/i }))
    await user.type(screen.getByLabelText(/new username/i), 'alice')
    await user.type(
      screen.getByLabelText(/new user password/i),
      'sup3rSecretPw',
    )
    await user.click(screen.getByRole('button', { name: /create user/i }))

    // assert — log fired with the diagnostic fields.
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[userMgmt:create-user-failed]',
        expect.objectContaining({ username: 'alice', role: 'family', status: 500 }),
      ),
    )
    // assert — the password NEVER appears in any logged field.
    const createCalls = errorSpy.mock.calls.filter(
      (c) => c[0] === '[userMgmt:create-user-failed]',
    )
    expect(JSON.stringify(createCalls)).not.toContain('sup3rSecretPw')
  })

  it('Given delete rejects with a 5xx, When the generic fallback fires, Then it logs the target username + status', async () => {
    // arrange — two users so the delete button is enabled (not last owner).
    adminListUsers.mockResolvedValue({
      users: [
        { username: 'owner1', role: 'owner' },
        { username: 'bob', role: 'family' },
      ],
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    adminDeleteUser.mockRejectedValue(
      new HttpError('/api/admin/users/bob', 500, 'boom'),
    )
    const user = userEvent.setup()
    render(<ManageUsersPanel />)
    await screen.findByText('bob')

    // act — bob's row Delete button (owner1's is disabled — self).
    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i })
    await user.click(deleteButtons[deleteButtons.length - 1])

    // assert
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[userMgmt:delete-user-failed]',
        expect.objectContaining({ username: 'bob', status: 500 }),
      ),
    )
  })

  it("Given owner/admin peer rows, When rendered, Then their Delete is disabled and only family/viewer stay deletable", async () => {
    // 2026-07-09 policy: admin/owner accounts can't be deleted via the UI.
    // arrange — a peer owner, a legacy admin, and a deletable family member.
    adminListUsers.mockResolvedValue({
      users: [
        { username: 'owner1', role: 'owner' }, // self
        { username: 'boss2', role: 'owner' }, // peer owner → protected
        { username: 'legacy', role: 'admin' }, // legacy admin → protected
        { username: 'kid', role: 'family' }, // family → deletable
      ],
    })
    render(<ManageUsersPanel />)
    await screen.findByText('kid')

    const rowOf = (name: string) =>
      screen.getByText(name).closest('li') as HTMLElement
    const deleteIn = (name: string) =>
      within(rowOf(name)).getByRole('button', { name: /^delete$/i })

    // assert — privileged peers disabled with the protected hint; family enabled.
    expect(deleteIn('boss2')).toBeDisabled()
    expect(deleteIn('legacy')).toBeDisabled()
    expect(deleteIn('kid')).toBeEnabled()
    expect(
      within(rowOf('boss2')).getByText(/can't be deleted/i),
    ).toBeInTheDocument()
  })
})
