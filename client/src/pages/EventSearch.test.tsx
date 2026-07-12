import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const getSavedSearches = vi.fn()
const searchSecurityEvents = vi.fn()
const semanticSearch = vi.fn()
const createSavedSearch = vi.fn()

vi.mock('../lib/api', () => ({
  getSavedSearches: (...args: unknown[]) => getSavedSearches(...args),
  searchSecurityEvents: (...args: unknown[]) => searchSecurityEvents(...args),
  semanticSearch: (...args: unknown[]) => semanticSearch(...args),
  createSavedSearch: (...args: unknown[]) => createSavedSearch(...args),
}))
vi.mock('../lib/toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../components/EventRow', () => ({ EventRow: ({ event }: { event: { id: string } }) => <div>{event.id}</div> }))
vi.mock('../components/ClipModal', () => ({ ClipModal: () => null }))
vi.mock('../components/CatEmptyState', () => ({ CatEmptyState: ({ heading }: { heading: string }) => <p>{heading}</p> }))

import { EventSearch } from './EventSearch'

const localResult = {
  v: 1 as const,
  query: 'unknown person after 10 PM',
  items: [],
  index_status: { mode: 'local_metadata', status: 'ready', indexed_events: 4 },
}

describe('EventSearch collections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSavedSearches.mockResolvedValue({
      v: 1,
      items: [{ id: 'saved-1', name: 'Late visitors', query: 'unknown person after 10 PM', semantic: false, created_ts: 1 }],
    })
    searchSecurityEvents.mockResolvedValue(localResult)
    semanticSearch.mockResolvedValue({
      v: 1,
      mode: 'companion',
      items: [{ id: 'evt-semantic', label: 'person', camera_id: 'cam1', ts: 1 }],
    })
  })

  it('runs a collection encoded in the URL immediately', async () => {
    render(
      <MemoryRouter initialEntries={['/events/search?q=unknown%20person%20after%2010%20PM']}>
        <EventSearch />
      </MemoryRouter>,
    )

    await waitFor(() => expect(searchSecurityEvents).toHaveBeenCalledWith('unknown person after 10 PM'))
    expect(await screen.findByRole('heading', { name: 'Results' })).toBeInTheDocument()
  })

  it('runs a saved collection when selected', async () => {
    render(<MemoryRouter><EventSearch /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Late visitors' }))
    await waitFor(() => expect(searchSecurityEvents).toHaveBeenCalledWith('unknown person after 10 PM'))
  })

  it('does not invent a semantic similarity percentage', async () => {
    render(
      <MemoryRouter initialEntries={['/events/search?q=red%20coat&semantic=1']}>
        <EventSearch />
      </MemoryRouter>,
    )
    expect(await screen.findByText(/similarity score unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
  })
})
