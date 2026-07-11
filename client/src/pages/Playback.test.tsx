import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../lib/toast'

const mocks = vi.hoisted(() => {
  let playbackTime = 0
  const seekWrites = vi.fn()
  const video = {
    readyState: 4,
    get currentTime() {
      return playbackTime
    },
    set currentTime(value: number) {
      playbackTime = value
      seekWrites(value)
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  return {
    getCameras: vi.fn(),
    getDetectionConfig: vi.fn(),
    getTimeline: vi.fn(),
    getTimelineExport: vi.fn(),
    startTimelineExport: vi.fn(),
    downloadTimelineExport: vi.fn(),
    seekWrites,
    video,
    setPlaybackTime(value: number) {
      playbackTime = value
    },
  }
})

vi.mock('../lib/api', () => ({
  getCameras: () => mocks.getCameras(),
  getDetectionConfig: () => mocks.getDetectionConfig(),
  getTimeline: (...args: unknown[]) => mocks.getTimeline(...args),
  getTimelineExport: (...args: unknown[]) => mocks.getTimelineExport(...args),
  startTimelineExport: (...args: unknown[]) => mocks.startTimelineExport(...args),
  downloadTimelineExport: (...args: unknown[]) => mocks.downloadTimelineExport(...args),
}))

vi.mock('../components/VideoPlayer', () => ({
  VideoPlayer: ({
    onVideoEl,
    onTimeUpdate,
  }: {
    onVideoEl?: (video: HTMLVideoElement | null) => void
    onTimeUpdate?: (video: HTMLVideoElement) => void
  }) => {
    onVideoEl?.(mocks.video as unknown as HTMLVideoElement)
    return (
      <button
        type="button"
        onClick={() => onTimeUpdate?.(mocks.video as unknown as HTMLVideoElement)}
      >
        Emit playback progress
      </button>
    )
  },
}))

import {
  Playback,
  TIMELINE_EXPORT_MAX_RANGE_S,
  isValidDayKey,
  localDayBounds,
  splitTimelineBounds,
} from './Playback'

function renderPlayback(path = '/events/playback?day=2026-01-15') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Playback />
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.setPlaybackTime(0)
  mocks.getCameras.mockResolvedValue({
    cameras: [{ id: 'front_door', name: 'Front Door', path: 'cam' }],
  })
  mocks.getDetectionConfig.mockResolvedValue({ operating_mode: 'home' })
  mocks.getTimeline.mockImplementation(async (bounds: {
    camera_id: string
    since_ts: number
    until_ts: number
  }) => ({
    v: 1,
    camera_id: bounds.camera_id,
    since_ts: bounds.since_ts,
    until_ts: bounds.until_ts,
    spans: [{
      id: `span-${bounds.since_ts}`,
      camera_id: bounds.camera_id,
      start_ts: bounds.since_ts,
      end_ts: Math.min(bounds.until_ts, bounds.since_ts + 8 * 60 * 60),
      url: '/segment.mp4',
      size_bytes: 100,
    }],
    gaps: [],
    markers: [],
  }))
  mocks.startTimelineExport.mockResolvedValue({
    v: 1,
    id: 'export-1',
    status: 'pending',
    created_ts: 1,
    updated_ts: 1,
    requested: {},
    coverage: { recorded_s: 0, gap_s: 0 },
    size_bytes: null,
    sha256: null,
    error: null,
    status_url: '/status',
    file_url: null,
  })
})

describe('Playback time and range safety', () => {
  it('splits a 25-hour fall-back DST day into server-safe timeline windows', () => {
    const bounds = localDayBounds('2026-11-01')
    expect(bounds.until - bounds.since).toBe(25 * 60 * 60)

    const windows = splitTimelineBounds({
      camera_id: 'front_door',
      since_ts: bounds.since,
      until_ts: bounds.until,
    })

    expect(windows).toHaveLength(2)
    expect(windows[0].until_ts - windows[0].since_ts).toBe(24 * 60 * 60)
    expect(windows[1].until_ts - windows[1].since_ts).toBe(60 * 60)
  })

  it('rejects empty and rolled-over calendar keys', () => {
    expect(isValidDayKey('')).toBe(false)
    expect(isValidDayKey('2026-02-30')).toBe(false)
    expect(isValidDayKey('2026-02-28')).toBe(true)
  })

  it('does not turn video timeupdate progress into a new seek', async () => {
    const user = userEvent.setup()
    const bounds = localDayBounds('2026-01-15')
    renderPlayback(`/events/playback?day=2026-01-15&at=${bounds.since + 30}`)
    await screen.findByRole('button', { name: 'Emit playback progress' })
    await waitFor(() => expect(mocks.seekWrites).toHaveBeenCalled())
    const initialSeekCount = mocks.seekWrites.mock.calls.length
    mocks.setPlaybackTime(45)

    await user.click(screen.getByRole('button', { name: 'Emit playback progress' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Playback time')).toHaveValue(
        String(bounds.since + 45),
      )
    })
    expect(mocks.seekWrites).toHaveBeenCalledTimes(initialSeekCount)
  })

  it('ignores an empty date input and keeps the existing finite request bounds', async () => {
    renderPlayback()
    await screen.findByRole('button', { name: 'Emit playback progress' })
    expect(mocks.getTimeline).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '' } })

    expect(mocks.getTimeline).toHaveBeenCalledTimes(1)
    const request = mocks.getTimeline.mock.calls[0][0]
    expect(Number.isFinite(request.since_ts)).toBe(true)
    expect(Number.isFinite(request.until_ts)).toBe(true)
  })

  it('starts exports inside the selected day and never above the six-hour server maximum', async () => {
    const user = userEvent.setup()
    const bounds = localDayBounds('2026-01-15')
    renderPlayback()
    await screen.findByRole('button', { name: 'Emit playback progress' })

    await user.click(screen.getByRole('button', { name: 'Export range' }))

    await waitFor(() => expect(mocks.startTimelineExport).toHaveBeenCalled())
    const request = mocks.startTimelineExport.mock.calls[0][0]
    expect(request.since_ts).toBeGreaterThanOrEqual(bounds.since)
    expect(request.until_ts).toBeLessThanOrEqual(bounds.until)
    expect(request.until_ts - request.since_ts).toBeLessThanOrEqual(
      TIMELINE_EXPORT_MAX_RANGE_S,
    )
  })
})
