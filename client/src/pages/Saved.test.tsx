import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listIncidents = vi.fn()
const getSavedSearches = vi.fn()
vi.mock('../lib/api', () => ({
  listIncidents: () => listIncidents(),
  getSavedSearches: () => getSavedSearches(),
}))

import { Saved } from './Saved'

describe('Saved', () => {
  beforeEach(() => {
    listIncidents.mockResolvedValue({ v: 1, items: [{ id: 'inc-1', title: 'Porch', event_count: 1 }] })
    getSavedSearches.mockResolvedValue({ v: 1, items: [{ id: 'search-1', name: 'Night visitors', query: 'unknown people after 10 PM', semantic: false }] })
  })

  it('Given saved evidence exists, When Saved opens, Then incidents, exports and searches are reachable at a glance', async () => {
    render(<MemoryRouter><Saved /></MemoryRouter>)
    expect(await screen.findByRole('link', { name: /incident cases/i })).toHaveAttribute('href', '/events/incidents')
    expect(screen.getByRole('link', { name: /timeline and exports/i })).toHaveAttribute('href', '/events/playback')
    expect(screen.getByRole('link', { name: /night visitors/i })).toHaveAttribute('href', expect.stringContaining('/events/search?q='))
  })
})
