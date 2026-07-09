import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAdminAudit = vi.fn()
const listSessions = vi.fn()
const useStatus = vi.fn()
let authUser: { username: string; role: string } | null = {
  username: 'owner-user',
  role: 'owner',
}

vi.mock('../lib/api', () => ({
  getAdminAudit: (...a: unknown[]) => getAdminAudit(...a),
  listSessions: () => listSessions(),
  revokeSession: (jti: string) => Promise.resolve({ ok: true, jti }),
}))

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: authUser ? 'authed' : 'anon',
    user: authUser,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

vi.mock('../lib/useStatus', () => ({
  useStatus: () => useStatus(),
}))

import { GodView } from './GodView'

function renderGodView() {
  return render(
    <MemoryRouter initialEntries={['/god']}>
      <GodView />
    </MemoryRouter>,
  )
}

describe('GodView page', () => {
  beforeEach(() => {
    authUser = { username: 'owner-user', role: 'owner' }
    useStatus.mockReturnValue(null)
    listSessions.mockReset().mockResolvedValue({ v: 1, sessions: [] })
    getAdminAudit.mockReset().mockResolvedValue({
      v: 1,
      logins: [
        { ts: 1714000000, username: 'admin', action: 'login', ua: 'Chrome' },
        { ts: 1714000300, username: 'alice', action: 'refresh', ua: 'Firefox' },
      ],
      views: [
        { ts: 1714000100, username: 'admin', kind: 'page', name: '/events', dwell_ms: 65000 },
        { ts: 1714000200, username: 'alice', kind: 'event', name: 'evt_1', dwell_ms: 8000 },
      ],
      summary: {
        by_user: {
          admin: {
            logins: 1,
            page_dwell_ms: 65000,
            event_views: 0,
            top: [['/events', 65000]],
          },
          alice: {
            logins: 1,
            page_dwell_ms: 0,
            event_views: 1,
            top: [['evt_1', 8000]],
          },
        },
      },
    })
  })

  it('Given an owner user, When the audit wrapper returns data, Then crash-cart, aggregates, sessions, and views render', async () => {
    // arrange / act
    renderGodView()

    // assert
    expect(
      await screen.findByRole('heading', { level: 1, name: /god view/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('form', { name: /audit date filters/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /crash cart/i })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: /can't reach the jetson/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /active sessions/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /sessions timeline/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /per user/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^views$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'admin' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'alice' })).toBeInTheDocument()
    expect(screen.getAllByText('/events').length).toBeGreaterThan(0)
    expect(screen.getAllByText('evt_1').length).toBeGreaterThan(0)
    await waitFor(() => expect(getAdminAudit).toHaveBeenCalledTimes(1))
  })

  it('Given a viewer user, When the page is visited directly, Then the page stays hidden and does not fetch audit data', () => {
    // arrange
    authUser = { username: 'alice', role: 'viewer' }

    // act
    renderGodView()

    // assert
    expect(screen.queryByRole('heading', { name: /god view/i })).not.toBeInTheDocument()
    expect(getAdminAudit).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
  })
})
