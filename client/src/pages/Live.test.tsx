import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpError } from '../lib/api'

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

vi.mock('../lib/useStatus', () => ({
  useStatus: () => null,
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
  })
  afterEach(() => {
    vi.clearAllMocks()
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
    await user.click(screen.getByRole('button', { name: /snapshot/i }))
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
    await user.click(screen.getByRole('button', { name: /snapshot/i }))
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
    await user.click(screen.getByRole('button', { name: /snapshot/i }))
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
    await user.click(screen.getByRole('button', { name: /snapshot/i }))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Snapshot failed', 'error'),
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
    await user.click(
      screen.getByRole('button', { name: /tap to (resume|pause) detection/i }),
    )
    expect(toggleDetection).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Detection on', 'success'),
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
    const talk = screen.getByRole('button', { name: /talk/i })
    expect(talk).not.toBeDisabled()
    await user.click(talk)
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/talking through the camera will work/i),
        'info',
      ),
    )
  })

  it('given Talk button without audio wired, when rendered, then "Soon" caption is announced via aria-describedby (iter-280/356.3a)', () => {
    // arrange + act
    render(<Live />)

    // assert: caption still wired via aria-describedby for SR users
    // even though the button is no longer disabled (iter-356.18).
    const talkButton = screen.getByRole('button', { name: /talk/i })
    const describedById = talkButton.getAttribute('aria-describedby')
    expect(describedById).toBeTruthy()
    const caption = describedById ? document.getElementById(describedById) : null
    expect(caption).toHaveTextContent(/soon/i)
  })
})
