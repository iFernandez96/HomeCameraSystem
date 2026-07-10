import { act, render as rtlRender, screen, waitFor, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../lib/confirm'
import type { DetectionEvent } from '../lib/types'

// Event-view jank fix (2026-07-08): honest clip states. The modal
// probes the clip route directly (probeEventClip) instead of waiting
// for <video> to error on a 404, fetches the authoritative ledger
// state, and keeps polling inside the fresh-event window so the player
// swaps in on its own when the visit's clip finalizes. This file pins
// that state machine; ClipModal.test.tsx keeps the older error-path pins.

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
const fetchEventClipStatus = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ...actual,
    probeEventClip: (id: string) => probeEventClip(id),
    fetchEventClipStatus: (id: string) => fetchEventClipStatus(id),
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

beforeEach(() => {
  probeEventClip.mockReset()
  fetchEventClipStatus.mockReset()
  fetchEventClipStatus.mockResolvedValue({
    event_id: 'evt-probe',
    state: 'unknown',
    source: 'missing',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ClipModal honest clip states', () => {
  it('given an OLD event whose clip probe 404s and ledger is unknown, when the modal opens, then an honest no-video frame replaces the player', async () => {
    // arrange — default ts is years in the past
    probeEventClip.mockResolvedValue(false)

    // act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert — honest copy, snapshot still shown, player unmounted
    await waitFor(() =>
      expect(screen.getAllByText(/video status unknown/i).length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/no video is available/i).length).toBeGreaterThan(0)
    expect(screen.getByAltText(/snapshot of person event/i)).toHaveAttribute(
      'src',
      '/snapshots/thumb_1.jpg',
    )
    expect(screen.queryByLabelText(/clip of person event/i)).not.toBeInTheDocument()
  })

  it('given a FRESH event whose ledger says recording, when the modal opens, then the viewer says "Recording now"', async () => {
    // arrange — event fired 30s ago: visit plausibly still recording
    probeEventClip.mockResolvedValue(false)
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'recording',
      source: 'ledger',
    })
    const ev = makeEvent({ ts: Math.floor(Date.now() / 1000) - 30 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    await waitFor(() =>
      expect(screen.getAllByText(/recording now/i).length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/recorder is still writing/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no video was saved/i)).not.toBeInTheDocument()
  })

  it('given a clip is already available, when the modal opens, then no video-status pill is shown', async () => {
    probeEventClip.mockResolvedValue(true)
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'available',
      source: 'disk',
    })

    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    await waitFor(() =>
      expect(screen.getByLabelText(/clip of person event/i)).toBeInTheDocument(),
    )
    expect(screen.queryByText(/video available/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/video status/i)).not.toBeInTheDocument()
  })

  it('given a fresh missing clip, when a later probe finds the file, then the player mounts by itself (no close/reopen)', async () => {
    // arrange — fake timers FIRST so the poll interval is created
    // under fake time; first probe misses, every later probe hits
    vi.useFakeTimers()
    let clipExists = false
    probeEventClip.mockImplementation(() => Promise.resolve(clipExists))
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'recording',
      source: 'ledger',
    })
    const ev = makeEvent({ ts: Math.floor(Date.now() / 1000) - 30 })
    render(<ClipModal event={ev} onClose={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0) // flush the initial probe
    })
    expect(screen.getAllByText(/recording now/i).length).toBeGreaterThan(0)

    // act — the clip finalizes server-side; the poll (8s cadence)
    // discovers it
    clipExists = true
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'available',
      source: 'disk',
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })

    // assert — player is back, status frame gone
    expect(screen.getByLabelText(/clip of person event/i)).toBeInTheDocument()
    expect(screen.queryByText(/recording now/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/video available/i)).not.toBeInTheDocument()
  })

  it('given the ledger says finalizing, when the clip is missing, then the viewer says the server is publishing video', async () => {
    probeEventClip.mockResolvedValue(false)
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'finalizing',
      source: 'ledger',
    })

    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    await waitFor(() =>
      expect(screen.getAllByText(/publishing video/i).length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/server is assembling the clip/i).length).toBeGreaterThan(0)
  })

  it('given the ledger says failed, when the clip is missing, then the viewer makes the failure explicit', async () => {
    probeEventClip.mockResolvedValue(false)
    fetchEventClipStatus.mockResolvedValue({
      event_id: 'evt-probe',
      state: 'failed',
      source: 'ledger',
      reason: 'finalize_failed',
    })

    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    await waitFor(() =>
      expect(screen.getAllByText(/video failed/i).length).toBeGreaterThan(0),
    )
    expect(screen.getAllByText(/finalize_failed/i).length).toBeGreaterThan(0)
  })

  it('given a coalesced event (clip_url null, worker says no clip by design), when the modal opens, then the covering-recording copy shows instantly and nothing is probed', async () => {
    // arrange — worker marked this event clipless at emit time
    probeEventClip.mockResolvedValue(true)

    // act
    render(
      <ClipModal event={makeEvent({ clip_url: null })} onClose={() => {}} />,
    )

    // assert — instant honest state: no player, no probe, no poll
    expect(screen.getAllByText(/no separate video/i).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(/clip of person event/i)).not.toBeInTheDocument()
    expect(probeEventClip).not.toHaveBeenCalled()
    expect(fetchEventClipStatus).not.toHaveBeenCalled()
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
