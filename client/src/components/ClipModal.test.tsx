import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { ConfirmProvider } from '../lib/confirm'

// Playroom Modern (Task 7): ClipModal's "Name them" action now calls
// react-router's `useNavigate`, which throws outside a Router context.
// This shadows the RTL `render` import with one that always wraps in a
// MemoryRouter — every existing `render(<ClipModal .../>)` call (and the
// `rerender` it returns, per RTL's `wrapper` option contract) picks this
// up for free with no per-call changes needed.
//
// ConfirmProvider is ALSO wrapped unconditionally: without it,
// `useConfirm()`'s context default resolves every call to `false`
// (cancel), which would silently no-op the new Delete action in every
// test. ConfirmProvider renders nothing until a confirm() call is
// in flight, so pre-existing tests are unaffected.
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

// Mirrors People.test.tsx's pattern: mock just `useNavigate` (keep every
// other react-router export real) so "Name them" can be pinned against a
// plain spy instead of asserting on MemoryRouter's internal history.
const navigateSpy = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateSpy }
})

// Fix round (review finding): ClipModal's Delete pill is now gated by
// isOwner (parity with Events.tsx). Mirrors Events.test.tsx's auth mock
// idiom — default to 'admin' (owner-equivalent via the transitional
// carve-out) so pre-existing Delete-flow tests below keep passing
// unchanged; the new owner/non-owner tests override `_authUser.role`.
const _authUser: { username: string; role: 'owner' | 'admin' | 'viewer' } = {
  username: 'testuser',
  role: 'admin',
}
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: _authUser, logout: vi.fn() }),
}))

// docs/logging_plan.md §2/§5 (ClipModal): spy on the client log shim
// so the export-fail test can assert a structured ERROR (with the
// discarded HTTP status) fires at the swallow site. The real
// useReportError in lib/toast calls log.error under the hood, so
// mocking the log module captures it whether the report path is the
// direct log.error or the reportError pairing.
const logError = vi.fn()
const logWarn = vi.fn()
vi.mock('../lib/log', () => ({
  log: {
    error: (...a: unknown[]) => logError(...a),
    warn: (...a: unknown[]) => logWarn(...a),
    info: vi.fn(),
    debug: vi.fn(),
  },
  errFields: (e: unknown) => ({
    status: (e as { status?: number })?.status,
    value: String(e),
  }),
}))

import { ClipModal } from './ClipModal'
import { HttpError } from '../lib/api'
import type { DetectionEvent } from '../lib/types'


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
    thumb_url: '/snapshots/thumb_1.jpg',
    ...over,
  }
}


describe('ClipModal', () => {
  it('renders a video element pointing at the iter-201 clip route', () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe('/api/events/evt-1/clip')
  })

  it('uses the person_name in the video aria-label when present', () => {
    render(
      <ClipModal
        event={makeEvent({ person_name: 'alice' })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByLabelText(/clip of alice event/i)).toBeInTheDocument()
  })

  it('falls back to the snapshot when the video errors', () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    fireEvent.error(video)
    // Snapshot fallback img + the explanatory amber notice render.
    expect(
      screen.getByAltText(/snapshot of person event/i),
    ).toHaveAttribute('src', '/snapshots/thumb_1.jpg')
    expect(screen.getByText(/video not ready yet/i)).toBeInTheDocument()
  })

  it('shows "Clip unavailable" when both video and snapshot error', () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    fireEvent.error(video)
    const img = screen.getByAltText(/snapshot of person event/i)
    fireEvent.error(img)
    expect(screen.getByText(/clip unavailable/i)).toBeInTheDocument()
  })

  it('shows "Clip unavailable" immediately when no thumb_url is present', () => {
    render(
      <ClipModal
        event={makeEvent({ thumb_url: null })}
        onClose={() => {}}
      />,
    )
    const video = screen.getByLabelText(/clip of person event/i)
    fireEvent.error(video)
    expect(screen.getByText(/clip unavailable/i)).toBeInTheDocument()
  })

  it('given the header X is clicked, when the modal is open, then onClose fires (iter-356.63: single close surface)', () => {
    // arrange
    const onClose = vi.fn()
    render(<ClipModal event={makeEvent()} onClose={onClose} />)

    // act
    fireEvent.click(screen.getByRole('button', { name: /close clip viewer/i }))

    // assert
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('given the modal is open, when AT users query for close buttons, then exactly one is reachable (iter-356.63: a11y hygiene — was 3, now 1)', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // act
    const closes = screen.getAllByRole('button', { name: /close clip viewer/i })

    // assert — pre-iter-356.63 this returned 2 (header X + lg-only
    // evidence-pane X) plus a "Close" footer button. Now there is
    // exactly one dismiss surface, which avoids confusing
    // VoiceOver swipe order ("Close clip viewer, Close clip viewer,
    // Close").
    expect(closes).toHaveLength(1)
  })

  it('given the backdrop is clicked, when the modal is open, then onClose fires (iter-270)', () => {
    // arrange
    const onClose = vi.fn()
    render(<ClipModal event={makeEvent()} onClose={onClose} />)

    // act: the iter-270 a11y fix replaced the role="button" backdrop
    // with a div+onClick (aria-hidden so SR/keyboard skip it). Look
    // up by data-testid since the div has no accessible role.
    fireEvent.click(screen.getByTestId('clip-backdrop'))

    // assert
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ESC key calls onClose', () => {
    const onClose = vi.fn()
    render(<ClipModal event={makeEvent()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('given the backdrop has aria-hidden, when screen-readers query it, then it has no accessible role (iter-270)', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // act
    const backdrop = screen.getByTestId('clip-backdrop')

    // assert: aria-hidden hides from AT, no role to land on, no
    // tabindex so keyboard skips it. Pre-iter-270 it was a
    // role="button" with aria-label="Dismiss clip" — VoiceOver
    // landed on it FIRST and intercepted swipes.
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.getAttribute('role')).toBeNull()
    expect(backdrop.getAttribute('tabindex')).toBeNull()
  })

  it('clears the errored-clip state when a new event prop is passed', () => {
    const { rerender } = render(
      <ClipModal event={makeEvent()} onClose={() => {}} />,
    )
    fireEvent.error(screen.getByLabelText(/clip of person event/i))
    // Snapshot fallback should be visible now.
    expect(screen.getByText(/video not ready yet/i)).toBeInTheDocument()
    // New event → fallback clears, video re-renders.
    rerender(
      <ClipModal
        event={makeEvent({ id: 'evt-2', label: 'car' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/video not ready yet/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/clip of car event/i)).toBeInTheDocument()
  })

  it('when the modal renders, then a Download button is present (iter-330: Event Export ZIP)', () => {
    // arrange / act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert
    expect(
      screen.getByRole('button', { name: /save clip/i }),
    ).toBeInTheDocument()
  })

  it('given a clicked Download, when exportEvents resolves, then the browser is handed an object URL via an anchor click (iter-330)', async () => {
    // arrange
    const fakeBlob = new Blob(['fake-zip-bytes'], { type: 'application/zip' })
    const exportSpy = vi
      .spyOn(await import('../lib/api'), 'exportEvents')
      .mockResolvedValue(fakeBlob)
    // jsdom's URL.createObjectURL is undefined by default; stub it.
    const createObjectURLSpy = vi.fn().mockReturnValue('blob:fake')
    const revokeSpy = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', {
      value: createObjectURLSpy,
      configurable: true,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeSpy,
      configurable: true,
    })
    // Spy on anchor click so we can pin "download was triggered."
    const anchorClickSpy = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'a') {
        ;(el as HTMLAnchorElement).click = anchorClickSpy
      }
      return el
    })

    // act
    render(<ClipModal event={makeEvent({ id: 'evt-export' })} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /save clip/i }))

    // assert — exportEvents called with the single id; anchor click fired.
    expect(exportSpy).toHaveBeenCalledWith(['evt-export'])
    expect(createObjectURLSpy).toHaveBeenCalledWith(fakeBlob)
    expect(anchorClickSpy).toHaveBeenCalled()

    // cleanup
    vi.restoreAllMocks()
  })

  // docs/logging_plan.md §2/§5 (ClipModal): export failure must log a
  // structured ERROR carrying the discarded HTTP status (toast-only
  // before) so a 413 over-cap / 503 semaphore is diagnosable.
  it('given a clicked Download, when exportEvents rejects with a 413, then a structured ERROR is logged with the status (logging plan §2)', async () => {
    // arrange
    logError.mockReset()
    vi.spyOn(await import('../lib/api'), 'exportEvents').mockRejectedValue(
      new HttpError('/api/events/export', 413, 'too many'),
    )

    // act
    render(<ClipModal event={makeEvent({ id: 'evt-413' })} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /save clip/i }))

    // assert — export-failed ERROR with the event id + the 413 status.
    await vi.waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        'clipModal:export-failed',
        expect.objectContaining({ eventId: 'evt-413', status: 413 }),
      ),
    )

    // cleanup
    vi.restoreAllMocks()
  })

  it('given the in-player speed menu, when a speed is picked, then the video element playbackRate updates (YouTube-style)', async () => {
    // arrange — speed now lives in the VideoPlayer control bar's settings menu
    // (detailed behavior covered in VideoPlayer.test.tsx); this pins the
    // ClipModal integration.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i) as HTMLVideoElement
    expect(video.playbackRate).toBe(1)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act — native-controls era: speed is a <select> in the strip
    // under the video (the custom menu died with the hand-rolled bar).
    await user.selectOptions(screen.getByLabelText('Playback speed'), '2')

    // assert — the effect applied it to the element.
    expect(video.playbackRate).toBe(2)
  })

  it('given the user clicks the Loop button, when the click fires, then the video element receives loop=true (iter-331)', async () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i) as HTMLVideoElement
    expect(video.loop).toBe(false)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const loopBtn = screen.getByRole('button', { name: /repeat/i })
    expect(loopBtn).toHaveAttribute('aria-pressed', 'false')

    // act
    await user.click(loopBtn)

    // assert
    expect(video.loop).toBe(true)
    expect(loopBtn).toHaveAttribute('aria-pressed', 'true')
  })

  // Speed menu, scrub, play/pause, repeat and fullscreen are tested in
  // isolation in VideoPlayer.test.tsx. ClipModal keeps the integration tests
  // (player present, speed menu → playbackRate) and its focus-trap tests below.

  it('given Tab from the LAST focusable, then focus wraps to the FIRST focusable inside the dialog (iter-336 → iter-356.58 split-pane)', () => {
    // arrange — iter-356.58 (LAYOUT REBUILD) added the right-pane
    // evidence panel with its own desktop-Close button. The "last"
    // focusable is now the evidence pane's Close X (in DOM order),
    // not the footer Close. The trap contract is unchanged: Tab
    // from the LAST focusable wraps to the FIRST.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: /at the front door/i })
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getAttribute('tabindex') !== '-1')
    expect(focusables.length).toBeGreaterThan(1)
    const last = focusables[focusables.length - 1]
    const first = focusables[0]
    last.focus()

    // act
    fireEvent.keyDown(dialog, { key: 'Tab' })

    // assert — focus moved off `last` and is now on `first`.
    expect(document.activeElement).toBe(first)
  })

  it('given Shift+Tab from the FIRST focusable, then focus wraps to the LAST focusable inside the dialog (iter-336 → iter-356.58)', () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: /at the front door/i })
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getAttribute('tabindex') !== '-1')
    expect(focusables.length).toBeGreaterThan(1)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first.focus()

    // act
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })

    // assert — wrapped to last
    expect(document.activeElement).toBe(last)
  })

  it('given Download focused (mid-DOM), when Tab fires on the dialog, then focus stays inside dialog (iter-336: trap)', () => {
    // arrange — Download is mid-DOM. Tab from a non-last focusable
    // should NOT trigger the wrap; my handler only intercepts at
    // the boundaries. Browser-native Tab handles middle case.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const downloadBtn = screen.getByRole('button', { name: /save clip/i })
    downloadBtn.focus()
    // iter-356.17: dialog aria-label is now dynamic eventTitle.
    const dialog = screen.getByRole('dialog', { name: /at the front door/i })

    // act
    fireEvent.keyDown(dialog, { key: 'Tab' })

    // assert — focus did NOT escape (it stayed on Download since
    // my handler doesn't preventDefault on the mid case, and
    // jsdom doesn't simulate native Tab focus shift either way).
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('given the clip errored to the snapshot fallback, when the modal renders, then the player controls are gone (no video to control)', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    fireEvent.error(screen.getByLabelText(/clip of person event/i))

    // assert — the VideoPlayer (and its speed/repeat controls) is replaced by
    // the snapshot fallback, so its controls are absent.
    expect(
      screen.queryByRole('button', { name: /playback speed/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /repeat/i }),
    ).not.toBeInTheDocument()
  })

  it('given Download is in-flight, when the user clicks again, then a second exportEvents call is suppressed (iter-330: no double-trigger)', async () => {
    // arrange — return a promise that never resolves so the
    // in-flight state stays true.
    const exportSpy = vi
      .spyOn(await import('../lib/api'), 'exportEvents')
      .mockReturnValue(new Promise(() => {}))
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn().mockReturnValue('blob:fake'),
      configurable: true,
    })

    // act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const btn = screen.getByRole('button', { name: /save clip/i })
    await user.click(btn)
    // Second click while disabled — should be suppressed (button is
    // disabled by the in-flight state, AND the onDownload guard
    // is the second line of defense).
    await user.click(btn)

    // assert — exportEvents called exactly once.
    expect(exportSpy).toHaveBeenCalledTimes(1)

    vi.restoreAllMocks()
  })

  // iter-356.44 — bbox overlay on clip playback (Feature #1 follow-up).
  // The decision was "B" (Canvas overlay, not pixel burn-in): keeps
  // the worker's `-c copy` fast path, draws boxes via the same shape
  // as the live VideoTile, honors the same localStorage toggle.

  it('Given an event with a bbox, When ClipModal opens, Then a bbox-overlay canvas renders over the video', () => {
    // arrange
    const eventWithBox = makeEvent({
      boxes: [
        { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'person', score: 0.92 },
      ],
    })

    // act
    render(<ClipModal event={eventWithBox} onClose={() => {}} />)

    // assert
    const canvas = screen.getByTestId('clip-bbox-canvas')
    expect(canvas.tagName).toBe('CANVAS')
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    // The toggle button only renders when the event has at least one bbox.
    expect(screen.getByRole('button', { name: /hide detection boxes/i })).toBeInTheDocument()
  })

  it('Given an event with no bboxes, When ClipModal opens, Then the canvas mounts but the toggle button does not', () => {
    // arrange
    const eventNoBoxes = makeEvent({ boxes: [] })

    // act
    render(<ClipModal event={eventNoBoxes} onClose={() => {}} />)

    // assert — canvas still mounts (cheap, lets the live tile-style
    // resize logic stay simple) but the toggle button is suppressed
    // when there is nothing to overlay.
    expect(screen.getByTestId('clip-bbox-canvas')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /(show|hide) detection boxes/i }),
    ).not.toBeInTheDocument()
  })

  it('Given the boxes toggle was off in localStorage, When ClipModal opens, Then the toggle is unchecked and aria-pressed=false', () => {
    // arrange — share the iter-246 VideoTile localStorage key so the
    // live + clip toggles stay in lockstep.
    window.localStorage.setItem('homecam:boxesVisible', '0')
    try {
      const eventWithBox = makeEvent({
        boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'cat', score: 0.7 }],
      })

      // act
      render(<ClipModal event={eventWithBox} onClose={() => {}} />)

      // assert
      const toggle = screen.getByRole('button', { name: /show detection boxes/i })
      expect(toggle.getAttribute('aria-pressed')).toBe('false')
    } finally {
      window.localStorage.removeItem('homecam:boxesVisible')
    }
  })

  it('Given a clip mounts, Then the bbox overlay registers seeking/seeked/play/pause listeners on the video so it redraws when the user scrubs the seek bar (iter-356.59)', () => {
    // arrange — pre-iter-356.59 the overlay only listened for
    // `timeupdate`, which fires at ~4 Hz and never during a manual
    // scrub gesture on the native <video controls> seek bar. The
    // result was: bbox stuck while user dragged the scrubber, and
    // the post-roll region looked like the box was frozen. The fix
    // adds seeking/seeked/play/pause/ended event listeners + a
    // requestVideoFrameCallback per-frame redraw.
    const seen = new Set<string>()
    const origAdd = HTMLVideoElement.prototype.addEventListener
    HTMLVideoElement.prototype.addEventListener = function (
      this: HTMLVideoElement,
      type: string,
      listener: any,
      options?: any,
    ) {
      seen.add(type)
      return origAdd.call(this, type, listener, options)
    }
    try {
      // act
      render(
        <ClipModal
          event={makeEvent({
            boxes: [
              { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'person', score: 0.9 },
            ],
          })}
          onClose={() => {}}
        />,
      )

      // assert — the new listeners are wired. timeupdate stays as
      // a defensive net for browsers that don't fire rVFC during
      // seek-without-play, but the load-bearing additions are
      // seeking/seeked (scrubber wiring) + play/pause (frame loop).
      expect(seen.has('seeking')).toBe(true)
      expect(seen.has('seeked')).toBe(true)
      expect(seen.has('play')).toBe(true)
      expect(seen.has('pause')).toBe(true)
      expect(seen.has('timeupdate')).toBe(true)
    } finally {
      HTMLVideoElement.prototype.addEventListener = origAdd
    }
  })

  it('Given the boxes toggle is clicked, When the user toggles, Then aria-pressed flips and the localStorage key persists', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    window.localStorage.setItem('homecam:boxesVisible', '1')
    try {
      const eventWithBox = makeEvent({
        boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5, label: 'person', score: 0.8 }],
      })
      render(<ClipModal event={eventWithBox} onClose={() => {}} />)
      const toggle = screen.getByRole('button', { name: /hide detection boxes/i })

      // act
      await user.click(toggle)

      // assert — aria-label flips from "Hide" to "Show", aria-pressed
      // false, and the iter-246 localStorage key now reads '0'.
      expect(
        screen.getByRole('button', { name: /show detection boxes/i }),
      ).toBeInTheDocument()
      expect(window.localStorage.getItem('homecam:boxesVisible')).toBe('0')
    } finally {
      window.localStorage.removeItem('homecam:boxesVisible')
    }
  })

  it('Given the modal mounts, When the video has not fired play, Then requestVideoFrameCallback is not invoked yet (iter-356.63 Slice F)', () => {
    // arrange — monkey-patch rVFC onto HTMLVideoElement.prototype so
    // our spy is observed by the actual <video> the modal mounts.
    const rVFC = vi.fn().mockReturnValue(1)
    const cancelRVFC = vi.fn()
    type VideoProto = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (h: number) => void
    }
    const proto = HTMLVideoElement.prototype as VideoProto
    const prevRVFC = proto.requestVideoFrameCallback
    const prevCancel = proto.cancelVideoFrameCallback
    proto.requestVideoFrameCallback = rVFC
    proto.cancelVideoFrameCallback = cancelRVFC

    try {
      // act — give the event a bbox so the rVFC overlay loop is wired.
      const ev = makeEvent({
        boxes: [{ label: 'person', score: 0.9, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      })
      render(<ClipModal event={ev} onClose={() => {}} />)

      // assert — pre-Slice-F the loop kicked off eagerly inside the
      // useEffect body. After Slice F the loop only starts on `play`.
      expect(rVFC).not.toHaveBeenCalled()

      // act — fire the play event on the underlying <video>.
      const video = screen.getByLabelText(/clip of person event/i) as HTMLVideoElement
      fireEvent.play(video)

      // assert — now the loop has been kicked.
      expect(rVFC).toHaveBeenCalled()
    } finally {
      proto.requestVideoFrameCallback = prevRVFC
      proto.cancelVideoFrameCallback = prevCancel
    }
  })

  // Bug: non-person detections (e.g. cat) rendered the WHO panel as
  // "Unknown person" with a stray border-b divider, and surfaced the
  // object-detection score as "Face match: N%". Evidence pane should
  // only show identity fields when there is an actual recognized
  // person on the event.
  it('given a cat event, when the modal renders, then no WHO header, no Face match, and no orphan divider show', () => {
    // arrange
    const ev = makeEvent({ label: 'cat', score: 0.59, person_name: null })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — identity surfaces are absent
    expect(screen.queryByText(/^who$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/unknown person/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/face match/i)).not.toBeInTheDocument()
    // assert — object surfaces are present
    expect(screen.getByText(/^what$/i)).toBeInTheDocument()
    expect(screen.getAllByText(/^cat$/i).length).toBeGreaterThan(0)
    expect(screen.getByText('59%')).toBeInTheDocument()
  })

  it('given a recognized-person event, when the modal renders, then WHO and Face match still surface', () => {
    // arrange
    const ev = makeEvent({ label: 'person', person_name: 'alice', score: 0.87 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/^who$/i)).toBeInTheDocument()
    expect(screen.getAllByText(/alice/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/face match: 87%/i)).toBeInTheDocument()
  })

  it('Given the modal opens, When the dialog mounts, Then the wrapper carries the animate-modal-in entrance class so the heaviest modal in the app scales+fades on open instead of popping (premium-launch slice — Maya Major)', () => {
    // arrange — Maya Major: pre-fix the heaviest modal in the app
    // popped onto the screen on a single render frame while toasts
    // already slid via animate-toast-in. Pin the entrance class so
    // a later refactor can't silently strip the polish move.
    const ev = makeEvent({ label: 'person', score: 0.5 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — role="dialog" wrapper carries the entrance class.
    // Reduced-motion users still see the final state thanks to the
    // global @media block in index.css that clamps animation
    // duration to 0.01 ms × 1 iteration.
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toMatch(/animate-modal-in/)
  })

  it('Given a medium-confidence event, When the How-sure pane renders, Then the percentage and the tier word stack vertically as primary value + caption (NOT baseline-aligned siblings) — premium-launch slice (Maya Critical: drop "87% Medium" sentence-fragment competition)', () => {
    // arrange — Maya Critical: pre-fix the percentage was
    // `text-3xl font-bold` and the tier word ("Medium") was
    // `text-sm` on the SAME baseline via `flex items-baseline
    // gap-2`. Read as a sentence fragment with two competing
    // visual tiers encoding the same fact. Now the percentage
    // owns its own row (primary numeric display) and the tier
    // drops to a small uppercase caption — same vocabulary as
    // the WHO/WHEN/WHERE eyebrow labels in the same evidence
    // pane.
    const ev = makeEvent({ label: 'person', score: 0.6 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — copy upgrade: tier word is suffixed " confidence"
    // so the caption is a self-contained label rather than a
    // bare adjective.
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument()
    // The percentage is still present in its prior format.
    expect(screen.getByText('60%')).toBeInTheDocument()
    // No baseline competition: the percentage's parent does NOT
    // carry `flex items-baseline` (the prior layout) — it is its
    // own block-level row.
    const pct = screen.getByText('60%')
    expect(pct.parentElement?.className).not.toMatch(/flex.*items-baseline/)
  })

  it('Given a high-confidence event, When the How-sure pane renders, Then the caption reads "High confidence" (preserves SR-friendly tier signal — non-color non-numeric channel)', () => {
    // arrange / act
    const ev = makeEvent({ label: 'person', score: 0.92 })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument()
    expect(screen.getByText('92%')).toBeInTheDocument()
  })

  it('Given a low-confidence event, When the How-sure pane renders, Then the caption reads "Low confidence"', () => {
    // arrange / act
    const ev = makeEvent({ label: 'person', score: 0.42 })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/low confidence/i)).toBeInTheDocument()
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  // ─── iter-357 multi-person face-recognition rendering ────────────

  it('Given a multi-person event, When the WHO panel renders, Then the first matched name takes the prominent display row and the rest appear under "with"', () => {
    // arrange — iter-357: 3-person event. First name keeps the
    // iter-356 display-3xl treatment so a single-person event
    // reads identically; remaining names render as a calmer
    // secondary line so the "Who" panel doesn't blow out the
    // 320 px desktop aside.
    const ev = makeEvent({
      label: 'person',
      person_name: 'israel',
      person_names: ['israel', 'sheenal', 'coco'],
    })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — primary name is in the prominent display row.
    // (use getAllByText because the title also contains the
    // names; we just need to confirm presence.)
    const israels = screen.getAllByText(/israel/i)
    expect(israels.length).toBeGreaterThan(0)
    // Secondary line lists the other names with the "with" prefix.
    expect(screen.getByText(/with sheenal & coco/i)).toBeInTheDocument()
  })

  it('Given a single-person event, When the WHO panel renders, Then NO "with" secondary line appears (single-person path is unchanged from pre-iter-357)', () => {
    // arrange / act — backward-compat sentinel. A pre-iter-357
    // event with only `person_name` set must render the same
    // shape as before; the secondary line only appears when
    // `person_names.length > 1`.
    const ev = makeEvent({ label: 'person', person_name: 'alice' })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.queryByText(/^with /i)).not.toBeInTheDocument()
  })

  it('Given a multi-person event, When the dialog aria-label is queried, Then the title fans out to multiple names so the SR announcement is "Israel & Sheenal at the front door, ..."', () => {
    // arrange / act
    const ev = makeEvent({
      label: 'person',
      person_name: 'israel',
      person_names: ['israel', 'sheenal'],
    })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — the role="dialog" element carries the multi-name
    // title via aria-label so VO announces "Israel & Sheenal at
    // the front door" on dialog open instead of just "Israel".
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toMatch(
      /israel & sheenal at the front door/i,
    )
  })

  // ─── Playroom Modern (Task 7): pill action row — Name them + Delete ──

  it('Given an unrecognized person (no name), When the modal renders, Then a "Name them" action is present', () => {
    // arrange / act
    const ev = makeEvent({ label: 'person', person_name: null })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByRole('button', { name: /name them/i })).toBeInTheDocument()
  })

  it('Given a recognized (named) person, When the modal renders, Then "Name them" is absent (nothing left to name)', () => {
    // arrange / act
    const ev = makeEvent({ label: 'person', person_name: 'alice' })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.queryByRole('button', { name: /name them/i })).not.toBeInTheDocument()
  })

  it('Given a cat event, When the modal renders, Then "Name them" is absent (cats aren\'t named via this flow)', () => {
    // arrange / act
    const ev = makeEvent({ label: 'cat', person_name: null })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.queryByRole('button', { name: /name them/i })).not.toBeInTheDocument()
  })

  it('Given "Name them" is clicked, When an unrecognized person is showing, Then it navigates to the existing uncertain-face review flow', async () => {
    // arrange
    navigateSpy.mockClear()
    const ev = makeEvent({ label: 'person', person_name: null })
    render(<ClipModal event={ev} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.click(screen.getByRole('button', { name: /name them/i }))

    // assert — reuses /training/review (Review.tsx), NOT a new route.
    expect(navigateSpy).toHaveBeenCalledWith('/training/review')
  })

  it('Given the Delete pill is clicked and the confirm dialog is accepted, When the delete resolves, Then the event is deleted and the modal closes', async () => {
    // arrange
    const deleteSpy = vi
      .spyOn(await import('../lib/api'), 'deleteEvent')
      .mockResolvedValue({ deleted: true })
    const onClose = vi.fn()
    const ev = makeEvent({ id: 'evt-del', label: 'cat' })
    render(<ClipModal event={ev} onClose={onClose} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.click(screen.getByRole('button', { name: /delete this cat event/i }))
    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    // assert
    await vi.waitFor(() => expect(deleteSpy).toHaveBeenCalledWith('evt-del'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))

    // cleanup
    vi.restoreAllMocks()
  })

  it('Given the Delete pill is clicked and the confirm dialog is CANCELLED, When the user backs out, Then no delete request is made', async () => {
    // arrange
    const deleteSpy = vi.spyOn(await import('../lib/api'), 'deleteEvent')
    const onClose = vi.fn()
    const ev = makeEvent({ id: 'evt-keep', label: 'cat' })
    render(<ClipModal event={ev} onClose={onClose} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.click(screen.getByRole('button', { name: /delete this cat event/i }))
    await user.click(await screen.findByRole('button', { name: /^cancel$/i }))

    // assert
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // cleanup
    vi.restoreAllMocks()
  })

  // ─── Fix round (review finding): Delete pill owner gating ────────────

  it('Given a non-owner session, When the clip modal renders, Then no Delete button is shown', () => {
    // arrange
    _authUser.role = 'viewer'

    // act
    render(<ClipModal event={makeEvent({ label: 'cat' })} onClose={() => {}} />)

    // assert
    expect(
      screen.queryByRole('button', { name: /delete this cat event/i }),
    ).not.toBeInTheDocument()

    // cleanup
    _authUser.role = 'admin'
  })

  it('Given an owner session, When the clip modal renders, Then the Delete button is shown', () => {
    // arrange
    _authUser.role = 'owner'

    // act
    render(<ClipModal event={makeEvent({ label: 'cat' })} onClose={() => {}} />)

    // assert
    expect(
      screen.getByRole('button', { name: /delete this cat event/i }),
    ).toBeInTheDocument()

    // cleanup
    _authUser.role = 'admin'
  })

  // ─── Playroom Modern (Task 7): "More from tonight" rail ──────────────

  it('Given sibling events within ±2h, When the modal mounts, Then "More from tonight" fetches that window and excludes the active event', async () => {
    // arrange
    const ev = makeEvent({ id: 'evt-active', ts: 1700000000 })
    const sibling = makeEvent({ id: 'evt-sibling', ts: 1700003000, label: 'cat' })
    const searchSpy = vi
      .spyOn(await import('../lib/api'), 'searchEvents')
      .mockResolvedValue({ items: [ev, sibling], next_cursor: null })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — ±2h (7200s) window centered on the active event's ts.
    await vi.waitFor(() =>
      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ since_ts: 1700000000 - 7200, until_ts: 1700000000 + 7200 }),
      ),
    )
    expect(await screen.findByText(/more from tonight/i)).toBeInTheDocument()
    // The active event itself is excluded from its own "more" rail.
    const rail = screen.getByText(/more from tonight/i).closest('div') as HTMLElement
    expect(rail.textContent).not.toMatch(/evt-active/)

    // cleanup
    vi.restoreAllMocks()
  })

  it('Given no sibling events are found, When "More from tonight" resolves empty, Then the rail is not rendered', async () => {
    // arrange
    vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
      items: [],
      next_cursor: null,
    })

    // act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert
    await vi.waitFor(() => {
      expect(screen.queryByText(/more from tonight/i)).not.toBeInTheDocument()
    })

    // cleanup
    vi.restoreAllMocks()
  })

  it('Given a "More from tonight" row is tapped, When the user opens it, Then the SAME modal swaps to that event (video + evidence pane) without the parent re-rendering', async () => {
    // arrange
    const active = makeEvent({ id: 'evt-active', ts: 1700000000, label: 'person', person_name: null })
    const sibling = makeEvent({
      id: 'evt-sibling',
      ts: 1700001000,
      label: 'person',
      person_name: 'alice',
    })
    vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
      items: [sibling],
      next_cursor: null,
    })

    // act
    render(<ClipModal event={active} onClose={() => {}} />)
    const row = await screen.findByRole('button', { name: /alice/i })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    await user.click(row)

    // assert — the modal now plays evt-sibling's clip, not evt-active's.
    expect(screen.getByLabelText(/clip of alice event/i)).toHaveAttribute(
      'src',
      '/api/events/evt-sibling/clip',
    )

    // cleanup
    vi.restoreAllMocks()
  })
})
