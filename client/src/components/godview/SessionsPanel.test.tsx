import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../lib/types'

const listSessions = vi.fn()
const revokeSession = vi.fn()
const confirmFn = vi.fn()
const showToast = vi.fn()
const reportError = vi.fn()

vi.mock('../../lib/api', () => ({
  listSessions: () => listSessions(),
  revokeSession: (jti: string) => revokeSession(jti),
}))

vi.mock('../../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))

vi.mock('../../lib/toast', () => ({
  useToast: () => ({ showToast }),
  useReportError: () => reportError,
}))

import { SessionsPanel } from './SessionsPanel'

const owner = { username: 'owner-user', role: 'owner' }

function makeRows(): Session[] {
  const now = Date.now() / 1000
  return [
    {
      jti: 'current-secret-jti',
      username: 'owner-user',
      device_label: 'Chrome on Pixel',
      ip_class: 'lan',
      created_ts: now - 1000,
      last_seen_ts: now,
      is_current: true,
      watching_now: true,
      revoked: false,
    },
    {
      jti: 'other-secret-jti',
      username: 'sheenal',
      device_label: 'Safari on iPhone',
      ip_class: 'cellular',
      created_ts: now - 2000,
      last_seen_ts: now - 120,
      is_current: false,
      watching_now: false,
      revoked: false,
    },
  ]
}

describe('SessionsPanel', () => {
  beforeEach(() => {
    listSessions.mockReset().mockResolvedValue({ v: 1, sessions: makeRows() })
    revokeSession.mockReset().mockResolvedValue({ ok: true })
    confirmFn.mockReset().mockResolvedValue(true)
    showToast.mockReset()
    reportError.mockReset()
  })

  it('Given an owner and session rows, When the panel loads, Then it renders human-readable devices without exposing jti bytes', async () => {
    // arrange / act
    render(<SessionsPanel user={owner} />)

    // assert
    expect(
      await screen.findByRole('heading', { name: /active sessions/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('Chrome on Pixel')).toBeInTheDocument()
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument()
    expect(screen.getByText('LAN')).toBeInTheDocument()
    expect(screen.getByText('Cellular / public')).toBeInTheDocument()
    expect(screen.getByText('Watching now')).toBeInTheDocument()
    expect(screen.getByText('This device')).toBeInTheDocument()
    expect(screen.getByText('2 min ago')).toBeInTheDocument()
    expect(screen.queryByText('current-secret-jti')).not.toBeInTheDocument()
    expect(screen.queryByText('other-secret-jti')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /revoke chrome on pixel/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /revoke safari on iphone/i }),
    ).toBeInTheDocument()
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('Given an owner confirms revoke, When Revoke is pressed, Then the jti is used only for the API call and sessions refetch', async () => {
    // arrange
    const user = userEvent.setup()
    const rows = makeRows()
    listSessions
      .mockResolvedValueOnce({ v: 1, sessions: rows })
      .mockResolvedValueOnce({ v: 1, sessions: rows.filter((s) => s.jti !== 'other-secret-jti') })
    render(<SessionsPanel user={owner} />)
    const revoke = await screen.findByRole('button', {
      name: /revoke safari on iphone/i,
    })

    // act
    await user.click(revoke)

    // assert
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1))
    expect(confirmFn).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Revoke this session?',
        confirmLabel: 'Revoke',
        destructive: true,
      }),
    )
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('other-secret-jti'))
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2))
    expect(showToast).toHaveBeenCalledWith('Session revoked', 'success')
    expect(screen.queryByText('other-secret-jti')).not.toBeInTheDocument()
  })

  it('Given no session rows, When the panel loads, Then CatEmptyState announces the empty state', async () => {
    // arrange
    listSessions.mockResolvedValueOnce({ v: 1, sessions: [] })

    // act
    render(<SessionsPanel user={owner} />)

    // assert
    expect(
      await screen.findByRole('status', { name: /no active sessions/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('No devices signed in')).toBeInTheDocument()
  })

  it('Given a non-owner user, When the panel renders, Then it stays hidden and does not fetch sessions', () => {
    // arrange / act
    render(<SessionsPanel user={{ username: 'alice', role: 'viewer' }} />)

    // assert
    expect(screen.queryByRole('heading', { name: /active sessions/i })).not.toBeInTheDocument()
    expect(listSessions).not.toHaveBeenCalled()
  })
})
