import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const getNotificationInbox = vi.fn()
const markNotificationSeen = vi.fn()
const retainNotificationEvent = vi.fn()
const snoozeNotification = vi.fn()
const createIncident = vi.fn()
const showToast = vi.fn()

vi.mock('../../lib/api', () => ({
  getNotificationInbox: (...args: unknown[]) => getNotificationInbox(...args),
  markNotificationSeen: (...args: unknown[]) => markNotificationSeen(...args),
  retainNotificationEvent: (...args: unknown[]) => retainNotificationEvent(...args),
  snoozeNotification: (...args: unknown[]) => snoozeNotification(...args),
  createIncident: (...args: unknown[]) => createIncident(...args),
}))
vi.mock('../../lib/toast', () => ({ useToast: () => ({ showToast }) }))

import { NotificationInbox } from './NotificationInbox'

describe('NotificationInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getNotificationInbox.mockResolvedValue({
      v: 1,
      unread: 1,
      items: [{
        id: 'notice-1', created_ts: 2_000_000_000, title: 'Unknown person',
        body: 'Unknown person at the door', kind: 'unknown_person', event_id: 'event-1',
        url: '/events/event-1', importance: 'urgent', seen: false,
        delivery_state: 'gateway_failed', displayed_ts: null,
      }],
    })
    markNotificationSeen.mockResolvedValue({ seen: true })
    retainNotificationEvent.mockResolvedValue({ event_id: 'event-1', retention_class: 'permanent' })
    createIncident.mockResolvedValue({ id: 'incident-1' })
  })

  it('shows truthful delivery and actionable evidence controls', async () => {
    render(<MemoryRouter><NotificationInbox canRetain /></MemoryRouter>)
    expect(await screen.findByText(/delivery failed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Identify person' })).toHaveAttribute('href', '/training')
    fireEvent.click(screen.getByRole('button', { name: 'Create incident' }))
    await waitFor(() => expect(createIncident).toHaveBeenCalledWith(
      'Alert: Unknown person',
      'Unknown person at the door',
      'event-1',
    ))
    fireEvent.click(screen.getByRole('button', { name: 'Save permanently' }))
    await waitFor(() => expect(retainNotificationEvent).toHaveBeenCalledWith('notice-1', 'permanent'))
  })
})
