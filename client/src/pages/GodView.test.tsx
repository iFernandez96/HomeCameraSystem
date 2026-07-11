import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAdminAudit = vi.fn()
const fetchLogs = vi.fn()
const getLogsResult = vi.fn()
const getRecoverStatus = vi.fn()
const listSessions = vi.fn()
const listOutages = vi.fn()
const recoverHost = vi.fn()
const useStatus = vi.fn()
let authUser: { username: string; role: string } | null = {
  username: 'owner-user',
  role: 'owner',
}

vi.mock('../lib/api', () => ({
  fetchLogs: (...a: unknown[]) => fetchLogs(...a),
  getAdminAudit: (...a: unknown[]) => getAdminAudit(...a),
  getLogsResult: (...a: unknown[]) => getLogsResult(...a),
  getRecoverStatus: (...a: unknown[]) => getRecoverStatus(...a),
  listSessions: () => listSessions(),
  listOutages: () => listOutages(),
  recoverHost: (...a: unknown[]) => recoverHost(...a),
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
import { ConfirmProvider } from '../lib/confirm'

function renderGodView() {
  return render(
    <MemoryRouter initialEntries={['/god']}>
      <ConfirmProvider>
        <GodView />
      </ConfirmProvider>
    </MemoryRouter>,
  )
}

describe('GodView page', () => {
  beforeEach(() => {
    authUser = { username: 'Israel', role: 'owner' }
    useStatus.mockReturnValue(null)
    recoverHost.mockReset().mockResolvedValue({
      ok: true,
      request_id: 'req-1',
      status: 'pending',
      worker_online: true,
      note: 'Queued.',
    })
    getRecoverStatus.mockReset().mockResolvedValue({
      request_id: 'req-1',
      action: 'nvargus',
      status: 'done',
      detail: null,
      requested_by: 'owner-user',
      requested_at: 1714000000,
      result_at: 1714000004,
      worker_online: true,
    })
    fetchLogs.mockReset().mockResolvedValue({
      request_id: 'logs-1',
      status: 'pending',
      worker_online: true,
    })
    getLogsResult.mockReset().mockResolvedValue({
      request_id: 'logs-1',
      unit: 'homecam-detect',
      status: 'done',
      lines: ['2026-07-08 worker ready', '2026-07-08 password=***'],
      detail: null,
    })
    listSessions.mockReset().mockResolvedValue({ v: 1, sessions: [] })
    listOutages.mockReset().mockResolvedValue({ items: [] })
    getAdminAudit.mockReset().mockResolvedValue({
      v: 2,
      logins: [
        { ts: 1714000000, username: 'admin', action: 'login', ua: 'Chrome' },
        { ts: 1714000300, username: 'alice', action: 'refresh', ua: 'Firefox' },
      ],
      views: [
        { ts: 1714000100, username: 'admin', session_id: 'session-admin', kind: 'page', name: '/events', dwell_ms: 65000 },
        { ts: 1714000200, username: 'alice', session_id: 'session-alice', kind: 'event', name: 'evt_1', dwell_ms: 8000 },
      ],
      actions: [
        { ts: 1714000210, username: 'alice', session_id: 'session-alice', name: 'PATCH /api/detection/config' },
      ],
      sessions: [
        {
          id: 'session-alice', username: 'alice', device_label: 'Firefox on Android', ip_class: 'lan',
          started_ts: 1714000000, last_activity_ts: 1714000210, screen_time_ms: 42000,
          page_view_count: 2, event_view_count: 1, action_count: 1, legacy: false,
          pages: [{ name: '/settings', dwell_ms: 42000, views: 2 }],
          events: [{ name: 'evt_1', dwell_ms: 8000, views: 1 }],
          actions: [{ name: 'PATCH /api/detection/config', count: 1 }],
          timeline: [
            { ts: 1714000210, kind: 'action', name: 'PATCH /api/detection/config', dwell_ms: 0 },
            { ts: 1714000200, kind: 'event', name: 'evt_1', dwell_ms: 8000 },
          ],
        },
      ],
      summary: {
        by_user: {
          admin: {
            logins: 1,
            page_dwell_ms: 65000,
            event_views: 0,
            actions: 0,
            top: [['/events', 65000]],
          },
          alice: {
            logins: 1,
            page_dwell_ms: 0,
            event_views: 1,
            actions: 1,
            top: [['evt_1', 8000]],
          },
        },
      },
    })
  })

  it('Given an owner user, When audit data loads, Then glanceable app sessions lead and raw rows stay collapsed', async () => {
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
    expect(screen.getByRole('heading', { name: /app usage sessions/i })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { name: 'alice' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Firefox on Android · LAN')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getAllByText('Changed detection settings').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'View event' })).toHaveAttribute(
      'href',
      '/events?event=evt_1',
    )
    expect(screen.getByRole('heading', { name: /recovery/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /logs/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/unit/i)).toBeInTheDocument()
    const rawDetails = screen.getByText('Raw audit tables').closest('details')
    expect(rawDetails).not.toHaveAttribute('open')
    await userEvent.click(screen.getByText('Raw audit tables'))
    expect(rawDetails).toHaveAttribute('open')
    expect(screen.getByRole('heading', { name: /sessions timeline/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /per user/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^views$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'admin' })).toBeInTheDocument()
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

  it('Given an owner confirms camera daemon reset, When the request settles, Then status polls to done', async () => {
    // arrange
    const user = userEvent.setup()
    renderGodView()
    await screen.findByRole('heading', { level: 1, name: /god view/i })

    // act
    await user.click(screen.getByRole('button', { name: /reset camera daemon/i }))
    expect(recoverHost).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: /start recovery/i }))

    // assert
    await waitFor(() => expect(recoverHost).toHaveBeenCalledWith('nvargus'))
    await waitFor(() => expect(getRecoverStatus).toHaveBeenCalledWith('req-1'))
    expect(await screen.findByRole('status', { name: /recovery status/i })).toHaveTextContent(/done/i)
  })

  it('Given an owner refreshes logs, When polling completes, Then the read-only log region renders monospace lines', async () => {
    const user = userEvent.setup()
    renderGodView()
    await screen.findByRole('heading', { level: 1, name: /god view/i })

    const controls = screen.getByRole('form', { name: /log controls/i })
    await user.click(within(controls).getByRole('button', { name: /^refresh$/i }))

    await waitFor(() =>
      expect(fetchLogs).toHaveBeenCalledWith('homecam-detect', { lines: 200 }),
    )
    await waitFor(() => expect(getLogsResult).toHaveBeenCalledWith('logs-1'))
    const logs = await screen.findByLabelText(/system logs/i)
    expect(logs.tagName).toBe('PRE')
    expect(logs).toHaveTextContent('worker ready')
    expect(logs).toHaveTextContent('password=***')
  })
})
