import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchEvents = vi.fn()
const listFaceCaptureDirs = vi.fn()
const getFacePreferences = vi.fn()
let role: 'owner' | 'family' = 'family'

vi.mock('../lib/api', () => ({
  searchEvents: (...args: unknown[]) => searchEvents(...args),
  listFaceCaptureDirs: () => listFaceCaptureDirs(),
  getFacePreferences: () => getFacePreferences(),
  setFacePreference: vi.fn(),
  mergeFaces: vi.fn(),
}))

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { username: 'viewer', role } }),
}))

vi.mock('../lib/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../lib/confirm', () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}))

import { PersonDetail } from './PersonDetail'

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/people/Alice']}>
      <Routes>
        <Route path="/people/:name" element={<PersonDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  role = 'family'
  searchEvents.mockResolvedValue({ items: [], next_cursor: null })
  listFaceCaptureDirs.mockResolvedValue({ dirs: [] })
  getFacePreferences.mockResolvedValue({ v: 1, items: [], total: 0 })
})

describe('PersonDetail role boundaries', () => {
  it('lets family load read-only event details without calling owner-only capture APIs', async () => {
    renderDetail()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Alice' }),
    ).toBeInTheDocument()
    await waitFor(() => expect(searchEvents).toHaveBeenCalled())
    expect(listFaceCaptureDirs).not.toHaveBeenCalled()
    expect(getFacePreferences).not.toHaveBeenCalled()
    expect(screen.queryByText('Person settings')).not.toBeInTheDocument()
  })

  it('loads identity-management data and controls for an owner', async () => {
    role = 'owner'
    renderDetail()

    expect(await screen.findByText('Person settings')).toBeInTheDocument()
    expect(listFaceCaptureDirs).toHaveBeenCalledTimes(1)
    expect(getFacePreferences).toHaveBeenCalledTimes(1)
  })
})
