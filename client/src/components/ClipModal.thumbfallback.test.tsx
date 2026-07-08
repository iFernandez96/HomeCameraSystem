import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../lib/confirm'
import { ClipModal } from './ClipModal'
import type { DetectionEvent } from '../lib/types'

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ConfirmProvider>{children}</ConfirmProvider>
    </MemoryRouter>
  )
}

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: Wrapper, ...options })
}

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { username: 'testuser', role: 'admin' },
    logout: vi.fn(),
  }),
}))

vi.mock('../lib/log', () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  errFields: (e: unknown) => ({
    status: (e as { status?: number })?.status,
    value: String(e),
  }),
}))

function makeEvent(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: 'evt-1',
    ts: 1700000000,
    camera_id: 'cam1',
    label: 'person',
    score: 0.91,
    boxes: [],
    thumb_url: '/snapshots/thumb_1700000000.jpg',
    ...over,
  }
}

describe('ClipModal thumbnail fallback', () => {
  it('given an event with thumb_url, when ClipModal renders and the clip errors, then poster and still fallback use the exact thumb_url', () => {
    // arrange
    const thumbUrl = '/snapshots/thumb_1700000000.jpg'

    // act
    render(<ClipModal event={makeEvent({ thumb_url: thumbUrl })} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)

    // assert
    expect(video).toHaveAttribute('poster', thumbUrl)

    // act
    fireEvent.error(video)

    // assert
    expect(screen.getByAltText(/snapshot of person event/i)).toHaveAttribute(
      'src',
      thumbUrl,
    )
  })
})
