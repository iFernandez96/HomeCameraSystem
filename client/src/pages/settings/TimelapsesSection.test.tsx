import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// docs/logging_plan.md §2 (Daily timelapse) + §5: failure-point
// logging coverage for TimelapsesSection. The inline <video> had NO
// onError today, so a playback failure (file swept, range 404, codec
// reject) left a black box with zero signal. These tests pin that the
// onError logs, and that the list-fail path logs the reason before
// the empty-array fallback hides any existing rows.

const listTimelapses = vi.fn()
const triggerTimelapse = vi.fn()
const deleteTimelapse = vi.fn()
const getTimelapseStatus = vi.fn()
const getTimelapseManifest = vi.fn()

vi.mock('../../lib/api', () => ({
  listTimelapses: (...a: unknown[]) => listTimelapses(...a),
  triggerTimelapse: (...a: unknown[]) => triggerTimelapse(...a),
  deleteTimelapse: (...a: unknown[]) => deleteTimelapse(...a),
  getTimelapseStatus: (...a: unknown[]) => getTimelapseStatus(...a),
  // TimelapseVideo fetches the timestamp sidecar lazily on first play.
  getTimelapseManifest: (...a: unknown[]) => getTimelapseManifest(...a),
}))

const confirmFn = vi.fn().mockResolvedValue(false)
vi.mock('../../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))

const showToast = vi.fn()
// Mock the toast module: useToast returns our spy, and useReportError
// reproduces the real pairing (log.error via the real lib/log + the
// error toast). Under vitest (MODE === 'test') lib/log's ship() is
// disabled, so log.error only hits console.error — which the spies
// below observe.
vi.mock('../../lib/toast', async () => {
  const { log } = await vi.importActual<typeof import('../../lib/log')>(
    '../../lib/log',
  )
  return {
    useToast: () => ({ showToast }),
    useReportError:
      () =>
      (event: string, message: string, fields: Record<string, unknown> = {}) => {
        log.error(event, fields)
        showToast(message, 'error')
      },
  }
})

import { TimelapsesSection } from './TimelapsesSection'

beforeEach(() => {
  listTimelapses.mockReset()
  triggerTimelapse.mockReset()
  deleteTimelapse.mockReset()
  getTimelapseStatus.mockReset()
  getTimelapseManifest.mockReset()
  showToast.mockReset()
  confirmFn.mockReset().mockResolvedValue(false)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TimelapsesSection — video playback failure logging (docs/logging_plan.md §2)', () => {
  it('Given a timelapse row, When its <video> fires onError, Then a warn log records the date + MediaError code (no longer silent)', async () => {
    // arrange — one timelapse row; spy console.warn (lib/log warn sink
    // under vitest).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listTimelapses.mockResolvedValue({
      items: [{ date: '2026-06-18', url: '/timelapses/2026-06-18.mp4', size_bytes: 1234 }],
    })

    render(<TimelapsesSection />)
    const video = await screen.findByLabelText(/timelapse video for 2026-06-18/i)

    // act — simulate a playback error on the media element.
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4 },
    })
    fireEvent.error(video)

    // assert — the previously-missing onError now logs the reason.
    expect(warnSpy).toHaveBeenCalledWith(
      '[timelapses:video-error]',
      expect.objectContaining({ date: '2026-06-18', mediaErrorCode: 4 }),
    )
  })
})

describe('TimelapsesSection — list-fail logging (docs/logging_plan.md §2)', () => {
  it('Given the list load rejects, When the empty-array fallback hides existing rows, Then a warn log records the reason', async () => {
    // arrange
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = Object.assign(new Error('boom'), { status: 503 })
    listTimelapses.mockRejectedValue(err)

    // act
    render(<TimelapsesSection />)

    // assert — the swallow-to-empty path still logs WHY.
    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        '[timelapses:list-failed]',
        expect.objectContaining({ status: 503 }),
      ),
    )
  })
})

describe('TimelapsesSection — build-fail logging (docs/logging_plan.md §2)', () => {
  it('Given the build request rejects, When the error toast fires, Then it is paired with an error log carrying the date + status', async () => {
    // arrange
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    listTimelapses.mockResolvedValue({ items: [] })
    const err = Object.assign(new Error('nope'), { status: 500 })
    triggerTimelapse.mockRejectedValue(err)

    render(<TimelapsesSection />)
    await screen.findByLabelText(/timelapse date/i)

    // act — Build video (date defaults to yesterday, a valid value).
    fireEvent.click(screen.getByLabelText(/generate timelapse/i))

    // assert — toast + paired structured log naming the day + status.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/timelapse failed/i),
        'error',
      ),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      '[timelapses:build-failed]',
      expect.objectContaining({ status: 500 }),
    )
  })
})

describe('TimelapsesSection — background build polling (client polling UX)', () => {
  it('Given a build that finishes, When status polls to ready, Then a success toast fires and the list refreshes', async () => {
    // arrange — fake timers to drive the 3 s poll loop deterministically.
    // System time pinned so the component's "yesterday" default matches
    // the hardcoded 2026-06-19 fixtures (was flaking on real-clock days).
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 20, 12, 0, 0))
    listTimelapses
      .mockResolvedValueOnce({ items: [] }) // initial mount load
      .mockResolvedValueOnce({
        items: [
          { date: '2026-06-19', url: '/api/timelapses/2026-06-19.mp4', size_bytes: 9 },
        ],
      }) // post-ready refresh
    triggerTimelapse.mockResolvedValue({
      ok: true, building: true, date: '2026-06-19', url: '/api/timelapses/2026-06-19.mp4',
    })
    getTimelapseStatus
      .mockResolvedValueOnce({
        date: '2026-06-19', building: true, ready: false, error: null, url: null,
      }) // still building
      .mockResolvedValueOnce({
        date: '2026-06-19', building: false, ready: true, error: null,
        url: '/api/timelapses/2026-06-19.mp4',
      }) // ready

    try {
      render(<TimelapsesSection />)
      await vi.advanceTimersByTimeAsync(0) // flush mount load
      fireEvent.click(screen.getByLabelText(/generate timelapse/i))
      await vi.advanceTimersByTimeAsync(0) // flush trigger POST + building toast

      // act — two poll ticks: building, then ready.
      await vi.advanceTimersByTimeAsync(3000)
      await vi.advanceTimersByTimeAsync(3000)

      // assert — ready surfaced as success (not a generic "requested").
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/ready/i),
        'success',
      )
      // the finished video was pulled into the list.
      expect(listTimelapses).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given a build that fails server-side, When status settles not-ready, Then the error toast carries the server reason', async () => {
    // arrange — system time pinned so "yesterday" = 2026-06-19 (see above).
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 20, 12, 0, 0))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    listTimelapses.mockResolvedValue({ items: [] })
    triggerTimelapse.mockResolvedValue({
      ok: true, building: true, date: '2026-06-19', url: '/api/timelapses/2026-06-19.mp4',
    })
    getTimelapseStatus.mockResolvedValueOnce({
      date: '2026-06-19', building: false, ready: false,
      error: 'No recorded events on that day yet — nothing to build.', url: null,
    })

    try {
      render(<TimelapsesSection />)
      await vi.advanceTimersByTimeAsync(0)
      fireEvent.click(screen.getByLabelText(/generate timelapse/i))
      await vi.advanceTimersByTimeAsync(0)

      // act — one poll tick → failure.
      await vi.advanceTimersByTimeAsync(3000)

      // assert — the SERVER's reason is surfaced, paired with a log.
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/no recorded events/i),
        'error',
      )
      expect(errorSpy).toHaveBeenCalledWith(
        '[timelapses:build-failed]',
        expect.objectContaining({ date: '2026-06-19' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TimelapsesSection — wall-clock timestamp overlay', () => {
  it('Given a reel with a timestamp sidecar, When it plays, Then the corner shows the footage’s local capture time', async () => {
    // arrange — one row WITH a manifest_url; the sidecar maps reel offset 0
    // to a known local capture time. Build the epoch from local components so
    // the assertion is timezone-independent.
    const captureTs = new Date(2026, 5, 18, 14, 30, 0).getTime() / 1000
    listTimelapses.mockResolvedValue({
      items: [
        {
          date: '2026-06-18',
          url: '/api/timelapses/2026-06-18.mp4',
          size_bytes: 1234,
          manifest_url: '/api/timelapses/2026-06-18.json',
        },
      ],
    })
    getTimelapseManifest.mockResolvedValue({
      v: 1,
      date: '2026-06-18',
      segments: [{ offset_s: 0, capture_ts: captureTs }],
    })

    render(<TimelapsesSection />)
    const video = await screen.findByLabelText(/timelapse video for 2026-06-18/i)

    // act — first play lazily fetches the sidecar; a timeupdate 2 s in maps
    // the playhead to capture time.
    fireEvent.play(video)
    await waitFor(() => expect(getTimelapseManifest).toHaveBeenCalledTimes(1))
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 2 })

    // assert — overlay shows 14:30:00 + 2 s = 14:30:02 (retry the timeupdate
    // until the async sidecar state has applied).
    await waitFor(() => {
      fireEvent.timeUpdate(video)
      expect(screen.getByText('14:30:02')).toBeInTheDocument()
    })
  })

  it('Given a reel with NO sidecar, When it plays, Then no overlay is fetched or shown', async () => {
    // arrange — older reel: manifest_url absent.
    listTimelapses.mockResolvedValue({
      items: [
        { date: '2026-06-17', url: '/api/timelapses/2026-06-17.mp4', size_bytes: 9 },
      ],
    })

    render(<TimelapsesSection />)
    const video = await screen.findByLabelText(/timelapse video for 2026-06-17/i)

    // act — play + a timeupdate.
    fireEvent.play(video)
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 5 })
    fireEvent.timeUpdate(video)

    // assert — no sidecar fetch, and nothing that looks like a clock renders.
    expect(getTimelapseManifest).not.toHaveBeenCalled()
    expect(screen.queryByText(/^\d{2}:\d{2}:\d{2}$/)).toBeNull()
  })
})
