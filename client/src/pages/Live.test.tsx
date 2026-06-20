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
  // useReportError pairs an error log with a toast; route it through the
  // same showToast spy so existing error-toast assertions still hold.
  useReportError: () => (_event: string, message: string) =>
    showToast(message, 'error'),
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

  it('given the Live page renders, when AT users query for the page heading, then a level-1 sr-only "Live camera" heading is present (iter-356.63: Slice D a11y — sr-only h1 per route)', () => {
    // arrange / act
    render(<Live />)

    // assert — the visible camera-label is now h2 (section heading
    // "which camera am I looking at"); the route-level h1 is the
    // sr-only "Live camera" anchor for AT document outline.
    expect(
      screen.getByRole('heading', { level: 1, name: /live camera/i }),
    ).toBeInTheDocument()
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

  it('Given the two-way audio feature is unfinished, When the Talk button renders, Then it is disabled with a "Coming soon" caption so it reads as a placeholder, not a trap (premium-launch slice — Frank top #3 supersedes iter-356.18)', async () => {
    // arrange — premium-launch slice / Frank top #3: pre-fix the
    // Talk button fired a "this won't work yet" toast on every tap;
    // Frank's wife tapped it twice expecting it to work the second
    // time. A button that fires a "doesn't work" toast is a trap.
    // Now: disabled with a visible "Coming soon" caption so the
    // affordance reads as "this is the future home for talk, it
    // isn't ready, don't tap it" — the standard premium-SaaS
    // pattern (Stripe / Linear / Cron disable + tooltip placeholder
    // features rather than wiring them to apology toasts).
    const user = userEvent.setup()
    render(<Live />)

    // act
    // iter-356.58: rendered twice (mobile strip + desktop overlay).
    const talkButtons = screen.getAllByRole('button', { name: /talk/i })
    expect(talkButtons.length).toBeGreaterThan(0)

    // assert — every Talk surface is disabled.
    for (const btn of talkButtons) {
      expect(btn).toBeDisabled()
    }

    // act — clicking the disabled button does nothing (browsers
    // suppress click events on disabled buttons; userEvent respects
    // that).
    showToast.mockClear()
    await user.click(talkButtons[0])

    // assert — no toast fired (the trap that Frank flagged).
    expect(showToast).not.toHaveBeenCalled()
  })

  it('Given the Talk button is disabled, When the user reads the surface, Then a "Coming soon" caption sits below the mobile strip variant so the affordance is honestly labeled', () => {
    // arrange / act
    render(<Live />)

    // assert — "Coming soon" caption is present (mobile strip
    // variant). Aria-describedby ties the caption to the button so
    // SR users get the same explanation sighted users do.
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument()
  })

  it('Given a notched landscape iPhone PWA, When the video gradient strip renders, Then it carries lateral safe-area-inset padding so the trust cluster never sits under the home-indicator (premium-launch slice — mobile-view-auditor G3)', () => {
    // arrange — Pre-fix the strip used `px-4 sm:px-6` fixed
    // gutters. In landscape PWA standalone the home-indicator
    // strip eats ~21 px from the right; the trust cluster
    // (ArmedBadge / RecordingIndicator / CaptureSavingPill) on
    // the right could be partially occluded. The fix: inline
    // max(1rem, env(safe-area-inset-{side})) so the gutter
    // expands to clear OS-reported insets while preserving the
    // 16 px gutter on unnotched devices.
    const { container } = render(<Live />)

    // act — find the gradient strip by its hallmark classes
    // (gradient + absolute + inset-x-0 anchor).
    const strips = container.querySelectorAll<HTMLElement>(
      'div.absolute.inset-x-0.bottom-0.bg-gradient-to-t',
    )
    expect(strips.length).toBe(1)
    const strip = strips[0]

    // assert — read from the raw `style` attribute string. jsdom's
    // CSSStyleDeclaration drops `env()` and `max(env(...))` values
    // it can't parse; the attribute string preserves them.
    const styleAttr = strip.getAttribute('style') ?? ''
    expect(styleAttr).toMatch(
      /padding-left:\s*max\(1rem,\s*env\(safe-area-inset-left\)\)/,
    )
    expect(styleAttr).toMatch(
      /padding-right:\s*max\(1rem,\s*env\(safe-area-inset-right\)\)/,
    )
  })
})
