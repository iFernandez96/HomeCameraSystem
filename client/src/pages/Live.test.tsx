import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpError } from '../lib/api'
import { sentryCatAt, sentryOnWatchLabel } from '../lib/sentryCat'
import type { ServerStatus } from '../lib/types'

const captureSnapshot = vi.fn()
const toggleDetection = vi.fn()

vi.mock('../components/VideoTile', () => ({
  VideoTile: () => <div data-testid="video-tile" />,
}))

vi.mock('../components/SnapshotPreview', () => ({
  SnapshotPreview: ({ url, onClose }: { url: string; onClose: () => void }) => (
    <div role="dialog" aria-label="Snapshot preview">
      <img src={url} alt="Snapshot" />
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

// iter-356.64 / Slice B: useStatus returns a mutable ref so individual
// tests can swap a real ServerStatus in without re-mocking the
// module. Default = null (matches pre-Slice-B behavior so existing
// tests don't drift).
const statusRef: { current: ServerStatus | null } = { current: null }
vi.mock('../lib/useStatus', () => ({
  useStatus: () => statusRef.current,
}))

const showToast = vi.fn()
vi.mock('../lib/toast', () => ({
  useToast: () => ({ showToast }),
}))

// Stub out the network functions but pass through the real HttpError
// class — the page's `e instanceof HttpError` check has to narrow
// against the same constructor the mock rejects with. `vi.mock` is
// hoisted to the top of the file, so the factory can't reference any
// module-scope variables; redefine the class inline.
// iter-305: Live now imports getDetectionConfig to read camera_label.
// Stub it to never resolve (so the default fallback "Front Door" is
// what tests see at render time). Individual tests that care about
// the label override.
const getDetectionConfig = vi.fn().mockReturnValue(new Promise(() => {}))
vi.mock('../lib/api', () => {
  class HttpError extends Error {
    readonly status: number
    readonly path: string
    constructor(path: string, status: number, detail = '') {
      super(`${path} ${status}${detail}`)
      this.name = 'HttpError'
      this.path = path
      this.status = status
    }
  }
  return {
    captureSnapshot: (...a: unknown[]) => captureSnapshot(...a),
    toggleDetection: (...a: unknown[]) => toggleDetection(...a),
    getDetectionConfig: (...a: unknown[]) => getDetectionConfig(...a),
    HttpError,
  }
})

import { Live } from './Live'

describe('Live page', () => {
  beforeEach(() => {
    captureSnapshot.mockReset()
    toggleDetection.mockReset()
    showToast.mockReset()
    statusRef.current = null
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('sentry rotation (iter-356.64 / Slice B)', () => {
    it('given armed status, when rendered, then armed headline matches sentryOnWatchLabel for the current slot', () => {
      // arrange — fully armed status: worker alive + detection active.
      statusRef.current = {
        ok: true,
        uptime_s: 600,
        camera: 'ok',
        detection_active: true,
        worker_alive: true,
        worker_last_seen_s: 1,
        worker_metrics: null,
        cpu_temp_c: 50,
        gpu_temp_c: 47,
        cpu_freq_pct: 100,
        load_avg: [0.5, 0.6, 0.7],
        memory_used_mb: 1400,
        memory_total_mb: 1979,
        disk_free_gb: 28,
        fps: 5.0,
        push_subs_count: 0,
        seconds_since_last_frame: 1,
        camera_label: 'Front Door',
        audio_enabled: false,
      } as ServerStatus

      // act
      render(<Live />)

      // assert — the cat-named "X on watch" headline renders. Use the
      // shared sentryOnWatchLabel helper so the test stays correct as
      // the slot rotates between Panther / Mushu / Coco.
      const expected = sentryOnWatchLabel(sentryCatAt(Date.now()))
      // The label appears inside CameraSubtitle. It can occur in
      // multiple surfaces (overlay + future placements); use
      // getAllByText so we don't break if a second mount is added.
      expect(screen.getAllByText(expected).length).toBeGreaterThan(0)
    })
  })

  it('renders the heading and video tile', () => {
    render(<Live />)
    expect(screen.getByRole('heading', { name: /front door/i })).toBeInTheDocument()
    expect(screen.getByTestId('video-tile')).toBeInTheDocument()
  })

  it('snapshot button calls captureSnapshot and opens the preview modal', async () => {
    captureSnapshot.mockResolvedValue({ url: '/snapshots/snap_123.jpg' })
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.58 (LAYOUT REBUILD): Live now renders Snapshot/Talk
    // in two places (desktop overlay + mobile strip) so jsdom finds
    // multiple matches. Click the first; both wire to the same handler.
    await user.click(screen.getAllByRole('button', { name: /snapshot/i })[0])
    expect(captureSnapshot).toHaveBeenCalledTimes(1)
    const dialog = await screen.findByRole('dialog', { name: /snapshot preview/i })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /snapshot/i })).toHaveAttribute(
      'src',
      '/snapshots/snap_123.jpg',
    )
    // No toast on success — the modal IS the feedback.
    expect(showToast).not.toHaveBeenCalled()
  })

  it('preview can be dismissed via the modal Close button', async () => {
    captureSnapshot.mockResolvedValue({ url: '/snapshots/snap_456.jpg' })
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.58 (LAYOUT REBUILD): Live now renders Snapshot/Talk
    // in two places (desktop overlay + mobile strip) so jsdom finds
    // multiple matches. Click the first; both wire to the same handler.
    await user.click(screen.getAllByRole('button', { name: /snapshot/i })[0])
    await screen.findByRole('dialog', { name: /snapshot preview/i })
    await user.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /snapshot preview/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('emits a friendly toast when /api/capture returns 503', async () => {
    // Reject with the typed HttpError post-iter-122 so the page's
    // `e instanceof HttpError` check narrows correctly.
    captureSnapshot.mockRejectedValue(new HttpError('/api/capture', 503, ''))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.58 (LAYOUT REBUILD): Live now renders Snapshot/Talk
    // in two places (desktop overlay + mobile strip) so jsdom finds
    // multiple matches. Click the first; both wire to the same handler.
    await user.click(screen.getAllByRole('button', { name: /snapshot/i })[0])
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/no recent frame/i),
        'error',
      ),
    )
    errorSpy.mockRestore()
  })

  it('emits a generic error toast when snapshot fails for other reasons', async () => {
    // Plain Error (not an HttpError) → generic-error path. Pre-iter-122
    // a string-match on '500' fed into the error branch; iter-122
    // correctly distinguishes "any-non-HttpError" from the typed 503.
    captureSnapshot.mockRejectedValue(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.58 (LAYOUT REBUILD): Live now renders Snapshot/Talk
    // in two places (desktop overlay + mobile strip) so jsdom finds
    // multiple matches. Click the first; both wire to the same handler.
    await user.click(screen.getAllByRole('button', { name: /snapshot/i })[0])
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        // iter-356.56 (Frank L2): copy upgraded from terse "Snapshot
        // failed" to actionable plain-English with a recovery hint.
        expect.stringMatching(/couldn't take the snapshot/i),
        'error',
      ),
    )
    errorSpy.mockRestore()
  })

  it('detection status toggle fires toggleDetection and emits a toast (iter-356.18)', async () => {
    toggleDetection.mockResolvedValue({ active: true })
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.18: replaced the Detect ActionButton with a status-
    // pill toggle. Match by aria-label which contains "tap to ...
    // detection" in either state.
    // iter-356.58: also rendered twice (overlay + mobile strip).
    await user.click(
      screen.getAllByRole('button', { name: /tap to (resume|pause) detection/i })[0],
    )
    expect(toggleDetection).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        // iter-356.56 (Frank L2): success toast spells out what
        // changed instead of a one-word ack.
        expect.stringMatching(/detection on — the camera is watching/i),
        'success',
      ),
    )
  })

  it('Talk button is enabled but fires the iter-308 placeholder toast when audio not wired (iter-356.18 Maya MAJOR #1)', async () => {
    // iter-356.18: Talk is no longer disabled when audio_enabled is
    // false. Maya MAJOR: pre-iter-356.18 disabled-with-no-handler
    // was a "dead button" — Frank's wife saw grey + no response on
    // tap = "broken." Now: always wire onTalk; tap fires the
    // explanatory toast when audio isn't wired.
    const user = userEvent.setup()
    render(<Live />)
    // iter-356.58: rendered twice; test the first.
    const talk = screen.getAllByRole('button', { name: /talk/i })[0]
    expect(talk).not.toBeDisabled()
    await user.click(talk)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/talking through the camera will work/i),
        'info',
      ),
    )
  })

  it('given Talk button without audio wired, when rendered, then no "Soon" caption is shown (iter-356.56 caption drop)', () => {
    // arrange + act
    render(<Live />)

    // assert: caption was dropped per Maya Major + Frank L3 — the
    // toast on tap explains state. Button still tappable (not disabled);
    // accessible name is still 'Talk'.
    // iter-356.58: rendered twice (overlay + strip); first is the
    // canonical accessible name for SR users.
    const talkButton = screen.getAllByRole('button', { name: /talk/i })[0]
    expect(talkButton).toBeInTheDocument()
    expect(talkButton).not.toBeDisabled()
    // No visible "Soon" tier under the button.
    expect(screen.queryByText(/^Soon$/i)).not.toBeInTheDocument()
  })
})
