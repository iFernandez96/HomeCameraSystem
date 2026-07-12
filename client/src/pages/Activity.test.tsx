import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listVisitStories = vi.fn()
vi.mock('../lib/api', () => ({ listVisitStories: () => listVisitStories() }))

import { Activity } from './Activity'

describe('Activity', () => {
  beforeEach(() => {
    listVisitStories.mockResolvedValue({ v: 1, items: [] })
  })

  it('Given the Activity tab opens, When visits load, Then visit-first navigation and the advanced detection path are clear', async () => {
    render(<MemoryRouter><Activity /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Activity sections' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /individual detections/i })).toHaveAttribute('href', '/events/detections')
  })
})
