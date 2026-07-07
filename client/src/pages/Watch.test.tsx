import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { DetectionEvent } from '../lib/types'

// ── Mock surface ─────────────────────────────────────────────────
const searchEvents = vi.fn()
const captureSnapshot = vi.fn()
const getStatusM = vi.fn()

vi.mock('../lib/api', () => {
  // Defined inside the factory — vi.mock hoists above imports, so a
  // top-level class would be referenced before initialization.
  class HttpError extends Error {
    status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return {
    searchEvents: (...a: unknown[]) => searchEvents(...a),
    captureSnapshot: (...a: unknown[]) => captureSnapshot(...a),
    getStatus: (...a: unknown[]) => getStatusM(...a),
    HttpError,
  }
})

// The WebRTC tile owns WHEP wiring that jsdom can't exercise — stub
// it; Watch's job is the chrome AROUND it.
vi.mock('../components/VideoTile', () => ({
  VideoTile: () => <div data-testid="video-tile-stub" />,
}))
// ClipModal drags in <video> + tracks fetching; Watch only needs to
// know it opened with the right event.
vi.mock('../components/ClipModal', () => ({
  ClipModal: ({ event }: { event: DetectionEvent }) => (
    <div role="dialog" aria-label={`clip:${event.id}`} />
  ),
}))
vi.mock('../components/SnapshotPreview', () => ({
  SnapshotPreview: ({ url }: { url: string }) => (
    <div role="dialog" aria-label={`snapshot:${url}`} />
  ),
}))

import { ToastProvider } from '../lib/toast'
import { Watch } from './Watch'

const HEALTHY = {
  ok: true,
  uptime_s: 100,
  camera: 'ok',
  camera_label: 'Front Door',
  detection_active: true,
  worker_alive: true,
  worker_last_seen_s: 1,
  seconds_since_last_frame: 2,
  worker_metrics: null,
}

function ev(partial: Partial<DetectionEvent>): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: partial.id ?? 'e1',
    ts: partial.ts ?? Date.now() / 1000 - 60,
    camera_id: 'cam',
    label: partial.label ?? 'person',
    score: 0.9,
    boxes: [],
    thumb_url: null,
    ...partial,
  }
}

function renderWatch() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Watch />
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getStatusM.mockResolvedValue(HEALTHY)
  searchEvents.mockResolvedValue({ items: [], next_cursor: null })
})

describe('Watch — Home screen (Playroom Modern)', () => {
  it('Given a healthy armed camera, When the page renders, Then the heading reads Home and both the on-video scrim and the glance card show the armed state', async () => {
    // arrange / act
    renderWatch()

    // assert — page heading, on-video scrim, glance card copy
    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('On watch')).toBeInTheDocument()
    })
    expect(screen.getByText('Watching')).toBeInTheDocument()
    expect(screen.getByText(/is on watch · alerts on/)).toBeInTheDocument()
  })

  it("Given events today, When the timeline loads, Then rows show who appeared and tapping one opens the clip", async () => {
    // arrange
    const known = ev({ id: 'k1', person_name: 'Israel' })
    const stranger = ev({ id: 's1', ts: Date.now() / 1000 - 120 })
    searchEvents.mockResolvedValue({ items: [known, stranger], next_cursor: null })
    const user = userEvent.setup()

    // act
    renderWatch()
    await waitFor(() => {
      expect(screen.getByText('Israel at cam')).toBeInTheDocument()
    })

    // assert — unrecognized row renders too + clip opens for the tapped row
    expect(screen.getByText('Person at cam')).toBeInTheDocument()
    await user.click(screen.getByText('Israel at cam'))
    expect(screen.getByRole('dialog', { name: 'clip:k1' })).toBeInTheDocument()
  })

  it('Given no events yet today, When the timeline loads, Then the cat empty state explains the quiet', async () => {
    // arrange / act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('All quiet so far')).toBeInTheDocument()
    })
  })

  it('Given the snapshot button, When tapped and the API resolves, Then the snapshot preview opens', async () => {
    // arrange
    captureSnapshot.mockResolvedValue({ ok: true, url: '/snapshots/x.jpg' })
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Snapshot' }))

    // assert
    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: 'snapshot:/snapshots/x.jpg' }),
      ).toBeInTheDocument()
    })
  })

  it('Given the docked viewport, When Full screen is tapped, Then the viewport goes full-bleed and Exit restores it', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()
    const viewport = screen.getByTestId('live-viewport')
    expect(viewport.className).toMatch(/relative/)

    // act — enter full screen
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — fixed overlay + thumb rail present
    expect(viewport.className).toMatch(/fixed inset-0/)
    expect(screen.getByRole('button', { name: /Talk · soon/ })).toBeDisabled()

    // act — exit
    await user.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(viewport.className).toMatch(/relative/)
  })

  it('Given the worker is offline, When the page renders, Then the verdict says the camera is offline (whimsy never masks danger)', async () => {
    // arrange
    getStatusM.mockResolvedValue({
      ...HEALTHY,
      worker_alive: false,
      detection_active: true,
    })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getAllByText(/Camera offline/).length).toBeGreaterThan(0)
    })
  })

  it('Given the worker is offline, When the page renders, Then the Watching glance headline reads "Offline" (not "Paused") — final review fix batch #8', async () => {
    // arrange — pre-fix the glance card said "Paused" for offline,
    // which reads as "detection is paused" rather than "the camera
    // itself is unreachable." Danger styling + the existing detail
    // line ("Check its power, then see Settings.") are unchanged.
    getStatusM.mockResolvedValue({
      ...HEALTHY,
      worker_alive: false,
      detection_active: true,
    })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('Offline')).toBeInTheDocument()
    })
    expect(screen.queryByText('Paused')).not.toBeInTheDocument()
    expect(
      screen.getByText('Check its power, then see Settings.'),
    ).toBeInTheDocument()
  })
})
