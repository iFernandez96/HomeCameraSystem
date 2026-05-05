import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ClipModal } from './ClipModal'
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

  it('given the modal renders the video, when the speed-pill row is shown, then 0.5x / 1x / 2x radio buttons are present (iter-331)', () => {
    // arrange / act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert — radiogroup with 3 radios; "1×" selected by default.
    const group = screen.getByRole('radiogroup', { name: /playback speed/i })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Slow' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Normal' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Normal' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given the user clicks the 2x speed pill, when the click fires, then the video element\'s playbackRate becomes 2 (iter-331)', async () => {
    // arrange — render and grab the live <video> element so we can
    // assert against its real `playbackRate` after the user click.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i) as HTMLVideoElement
    expect(video.playbackRate).toBe(1)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.click(screen.getByRole('radio', { name: 'Fast' }))

    // assert — useEffect ran; ref.current.playbackRate updated.
    expect(video.playbackRate).toBe(2)
    expect(screen.getByRole('radio', { name: 'Fast' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given the user clicks the Loop button, when the click fires, then the video element receives loop=true (iter-331)', async () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i) as HTMLVideoElement
    expect(video.loop).toBe(false)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const loopBtn = screen.getByRole('button', { name: /repeat clip/i })
    expect(loopBtn).toHaveAttribute('aria-pressed', 'false')

    // act
    await user.click(loopBtn)

    // assert
    expect(video.loop).toBe(true)
    expect(loopBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('given the speed radiogroup, when 1× is the current selection, then ONLY the selected pill has tabIndex=0 (iter-335: roving tabindex)', () => {
    // arrange / act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // assert — default is 1×; only that pill in the Tab order.
    expect(
      screen.getByRole('radio', { name: 'Normal' }).getAttribute('tabindex'),
    ).toBe('0')
    expect(
      screen.getByRole('radio', { name: 'Slow' }).getAttribute('tabindex'),
    ).toBe('-1')
    expect(
      screen.getByRole('radio', { name: 'Fast' }).getAttribute('tabindex'),
    ).toBe('-1')
  })

  it('given focus on the 1× pill, when ArrowRight is pressed, then 2× becomes selected and focused (iter-335)', async () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const oneX = screen.getByRole('radio', { name: 'Normal' }) as HTMLButtonElement
    oneX.focus()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.keyboard('{ArrowRight}')

    // assert — selection moved to 2×; tabIndex follows.
    const twoX = screen.getByRole('radio', { name: 'Fast' })
    expect(twoX).toHaveAttribute('aria-checked', 'true')
    expect(twoX.getAttribute('tabindex')).toBe('0')
    expect(oneX.getAttribute('tabindex')).toBe('-1')
  })

  it('given focus on the 1× pill, when ArrowLeft is pressed, then 0.5× becomes selected (iter-335)', async () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const oneX = screen.getByRole('radio', { name: 'Normal' }) as HTMLButtonElement
    oneX.focus()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.keyboard('{ArrowLeft}')

    // assert
    const halfX = screen.getByRole('radio', { name: 'Slow' })
    expect(halfX).toHaveAttribute('aria-checked', 'true')
  })

  it('given focus on the 0.5× pill (leftmost), when ArrowLeft is pressed, then wraps to 2× (iter-335)', async () => {
    // arrange — click 0.5× first to make it the selection, focus it.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Slow' }))
    const halfX = screen.getByRole('radio', { name: 'Slow' }) as HTMLButtonElement
    halfX.focus()

    // act
    await user.keyboard('{ArrowLeft}')

    // assert — wraps from 0.5× back to 2× (last in array).
    expect(
      screen.getByRole('radio', { name: 'Fast' }),
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('given the speed radiogroup, when End is pressed, then 2× (last) becomes selected (iter-335)', async () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const oneX = screen.getByRole('radio', { name: 'Normal' }) as HTMLButtonElement
    oneX.focus()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.keyboard('{End}')

    // assert
    expect(
      screen.getByRole('radio', { name: 'Fast' }),
    ).toHaveAttribute('aria-checked', 'true')
  })

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

  it('given the speed radiogroup, when Home is pressed, then 0.5× (first) becomes selected (iter-335)', async () => {
    // arrange — start at 2× via click.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Fast' }))
    const twoX = screen.getByRole('radio', { name: 'Fast' }) as HTMLButtonElement
    twoX.focus()

    // act
    await user.keyboard('{Home}')

    // assert
    expect(
      screen.getByRole('radio', { name: 'Slow' }),
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('given the clip errored to the snapshot fallback, when the modal renders, then the speed-pill row is hidden (iter-331: no controls when there is no video)', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    fireEvent.error(screen.getByLabelText(/clip of person event/i))

    // assert — speed/loop UI absent in the snapshot-fallback state.
    expect(
      screen.queryByRole('radiogroup', { name: /playback speed/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /repeat clip/i }),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listener: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
})
