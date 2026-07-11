import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listIncidents: vi.fn(),
  getIncident: vi.fn(),
  createIncident: vi.fn(),
  updateIncident: vi.fn(),
  deleteIncident: vi.fn(),
  removeIncidentEvent: vi.fn(),
  exportIncident: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  ...api,
  listIncidents: () => api.listIncidents(),
  getIncident: (...args: unknown[]) => api.getIncident(...args),
}))

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { username: 'family-user', role: 'family' },
  }),
}))

vi.mock('../lib/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../lib/confirm', () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}))

import { Incidents } from './Incidents'
import { IncidentDetail } from './IncidentDetail'

const summary = {
  id: 'inc-1',
  title: 'Porch activity',
  notes: 'Keep for review',
  created_ts: 1,
  updated_ts: 2,
  event_count: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listIncidents.mockResolvedValue({ v: 1, items: [summary], total: 1 })
  api.getIncident.mockResolvedValue({
    ...summary,
    events: [{
      v: 1,
      type: 'detection',
      id: 'evt-1',
      ts: 1,
      camera_id: 'front_door',
      label: 'person',
      score: 0.9,
      boxes: [],
      thumb_url: null,
    }],
  })
})

describe('incident household read access', () => {
  it('lets family browse incidents without exposing creation controls', async () => {
    render(
      <MemoryRouter>
        <Incidents />
      </MemoryRouter>,
    )

    expect(await screen.findByText('Porch activity')).toBeInTheDocument()
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('New incident title')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New incident' })).not.toBeInTheDocument()
    expect(api.createIncident).not.toHaveBeenCalled()
  })

  it('shows family read-only notes and evidence without mutation or export controls', async () => {
    render(
      <MemoryRouter initialEntries={['/events/incidents/inc-1']}>
        <Routes>
          <Route path="/events/incidents/:id" element={<IncidentDetail />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Keep for review')).toBeInTheDocument()
    expect(screen.getByText('Read-only incident access')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export evidence' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete incident' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove person event/i })).not.toBeInTheDocument()
    expect(api.updateIncident).not.toHaveBeenCalled()
    expect(api.deleteIncident).not.toHaveBeenCalled()
    expect(api.removeIncidentEvent).not.toHaveBeenCalled()
    expect(api.exportIncident).not.toHaveBeenCalled()
  })
})
