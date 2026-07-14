import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listVisitStories = vi.fn()

vi.mock('../lib/api', () => ({
  listVisitStories: () => listVisitStories(),
}))

import { Visits } from './Visits'

describe('Visits', () => {
  beforeEach(() => {
    listVisitStories.mockReset().mockResolvedValue({
      items: [
        {
          id: 'person:alice:evt-1',
          start_ts: 100,
          end_ts: 175,
          camera_ids: ['front_door'],
          people: ['Alice'],
          labels: ['person'],
          events: [{ id: 'evt-1' }, { id: 'evt-2' }],
        },
      ],
    })
  })

  it('lists visit stories as reachable links to VisitViewer', async () => {
    render(
      <MemoryRouter>
        <Visits />
      </MemoryRouter>,
    )

    expect(
      await screen.findByRole('heading', { name: 'Visits' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Open visit: Alice' }),
    ).toHaveAttribute('href', '/events/visits/person%3Aalice%3Aevt-1')
    expect(screen.getByText(/2 moments/i)).toBeInTheDocument()
  })
})
