import { act, render as rtlRender, screen, waitFor, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../lib/confirm'
import type { DetectionEvent } from '../lib/types'

// Event-view jank fix (2026-07-08): honest clip states. The modal
// probes the clip route directly (probeEventClip) instead of waiting
// for <video> to error on a 404, branches the copy by event age
// ("still recording" vs "no video was saved"), and keeps polling
// inside the still-writing window so the player swaps in on its own
// when the visit's clip finalizes. This file pins that state machine;
// ClipModal.test.tsx keeps the older error-path pins.

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
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  errFields: (e: unknown) => ({ value: String(e) }),
}))

// Partial api mock: the probe is the unit under test; the sibling
// fetches (More from tonight, bbox tracks) resolve empty so the modal
// renders without network noise.
const probeEventClip = vi.fn<(id: string) => Promise<boolean>>()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    probeEventClip: (id: string) => probeEventClip(id),
    searchEvents: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    fetchEventTracks: vi.fn().mockResolvedValue(null),
  }
})

import { ClipModal } from './ClipModal'

function makeEvent(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: 'evt-probe',
    ts: 1700000000,
    camera_id: 'cam1',
    label: 'person',
    score: 0.91,
    boxes: [],
    thumb_url: '/snapshots/thumb_1.jpg',
    ...over,
  }
}

afterEach(() => {
  probeEventClip.mockReset()
  vi.useRealTimers()
})

describe('ClipModal honest clip states', () => {
  it('given an OLD event whose clip probe 404s, when the modal opens, then the "no video was saved" frame replaces the player', async () => {
    // arrange — default ts is years in the past
    probeEventClip.mockResolvedValue(false)

    // act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert — honest copy, snapshot still shown, player unmounted
    await waitFor(() =>
      expect(screen.getByText(/no video was saved/i)).toBeInTheDocument(),
    )
    expect(screen.getByAltText(/snapshot of person event/i)).toHaveAttribute(
      'src',
      '/snapshots/thumb_1.jpg',
    )
    expect(screen.queryByLabelText(/clip of person event/i)).not.toBeInTheDocument()
  })

  it('given a FRESH event whose clip probe 404s, when the modal opens, then the "still recording" status shows instead of a false promise', async () => {
    // arrange — event fired 30s ago: visit plausibly still recording
    probeEventClip.mockResolvedValue(false)
    const ev = makeEvent({ ts: Math.floor(Date.now() / 1000) - 30 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    await waitFor(() =>
      expect(screen.getByText(/still recording/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/no video was saved/i)).not.toBeInTheDocument()
  })

  it('given a fresh missing clip, when a later probe finds the file, then the player mounts by itself (no close/reopen)', async () => {
    // arrange — fake timers FIRST so the poll interval is created
    // under fake time; first probe misses, every later probe hits
    vi.useFakeTimers()
    let clipExists = false
    probeEventClip.mockImplementation(() => Promise.resolve(clipExists))
    const ev = makeEvent({ ts: Math.floor(Date.now() / 1000) - 30 })
    render(<ClipModal event={ev} onClose={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0) // flush the initial probe
    })
    expect(screen.getByText(/still recording/i)).toBeInTheDocument()

    // act — the clip finalizes server-side; the poll (8s cadence)
    // discovers it
    clipExists = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })

    // assert — player is back, status frame gone
    expect(screen.getByLabelText(/clip of person event/i)).toBeInTheDocument()
    expect(screen.queryByText(/still recording/i)).not.toBeInTheDocument()
  })

  it('given a coalesced event (clip_url null, worker says no clip by design), when the modal opens, then the covering-recording copy shows instantly and nothing is probed', async () => {
    // arrange — worker marked this event clipless at emit time
    probeEventClip.mockResolvedValue(true)

    // act
    render(
      <ClipModal event={makeEvent({ clip_url: null })} onClose={() => {}} />,
    )

    // assert — instant honest state: no player, no probe, no poll
    expect(screen.getByText(/no video of its own/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/clip of person event/i)).not.toBeInTheDocument()
    expect(probeEventClip).not.toHaveBeenCalled()
  })

  it('given the clip probe errors (network blip), when the modal opens, then the optimistic player stays mounted', async () => {
    // arrange
    probeEventClip.mockRejectedValue(new Error('offline'))

    // act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert — a flaky probe must never hide a playable clip
    await waitFor(() =>
      expect(screen.getByLabelText(/clip of person event/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/no video was saved/i)).not.toBeInTheDocument()
  })
})
