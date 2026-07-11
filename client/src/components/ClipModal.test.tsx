import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render as rtlRender, screen, waitFor, within, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>
}
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: Wrapper, ...options })
}

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
    // Snapshot fallback img + the honest explanatory notice render.
    // makeEvent()'s ts is far in the past, so the copy must NOT
    // promise a video that will never arrive (jank fix 2026-07-08).
    expect(
      screen.getByAltText(/snapshot of person event/i),
    ).toHaveAttribute('src', '/snapshots/thumb_1.jpg')
    expect(screen.getAllByText(/no video is available/i).length).toBeGreaterThan(0)
  })

  it('shows "Clip unavailable" when both video and snapshot error', () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    fireEvent.error(video)
    const img = screen.getByAltText(/snapshot of person event/i)
    fireEvent.error(img)
    expect(screen.getByText(/clip unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/no video or snapshot is available/i)).toBeInTheDocument()
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
    expect(screen.getByText(/no video or snapshot is available/i)).toBeInTheDocument()
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
    // Snapshot fallback should be visible now (old event -> honest
    // "no video is available" copy, jank fix 2026-07-08).
    expect(screen.getAllByText(/no video is available/i).length).toBeGreaterThan(0)
    // New event → fallback clears, video re-renders.
    rerender(
      <ClipModal
        event={makeEvent({ id: 'evt-2', label: 'car' })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText(/no video is available/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/clip of car event/i)).toBeInTheDocument()
  })

  it('when the modal renders, then event action buttons are not shown in the viewer', () => {
    render(<ClipModal event={makeEvent({ label: 'cat' })} onClose={() => {}} />)

    expect(screen.queryByRole('button', { name: /save event/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /share or copy link/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /name them/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete this cat event/i })).not.toBeInTheDocument()
  })

  it('given the clip viewer renders, then playback speed settings include 4x for events', async () => {
    // arrange / act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // assert
    expect(screen.getByLabelText(/clip of person event/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Playback settings' }))
    expect(screen.getByLabelText('Playback speed')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '4×' })).toBeInTheDocument()
  })

  it('given the event player fullscreen command is clicked, then the pinch-capable event pane expands', async () => {
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Enter fullscreen' }))

    expect(screen.getByTestId('clip-swipe-pane')).toHaveClass('fixed')
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toBeInTheDocument()
  })

  // Speed menu, scrub, play/pause, repeat and fullscreen are tested in
  // isolation in VideoPlayer.test.tsx. ClipModal pins that the event viewer
  // exposes the speed menu.

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

  it('given a mid-DOM control is focused, when Tab fires on the dialog, then focus stays inside dialog (iter-336: trap)', () => {
    // arrange — the in-player settings button is mid-DOM. Tab from a non-last focusable
    // should NOT trigger the wrap; my handler only intercepts at
    // the boundaries. Browser-native Tab handles middle case.
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const settingsBtn = screen.getByRole('button', { name: /playback settings/i })
    settingsBtn.focus()
    // iter-356.17: dialog aria-label is now dynamic eventTitle.
    const dialog = screen.getByRole('dialog', { name: /at the front door/i })

    // act
    fireEvent.keyDown(dialog, { key: 'Tab' })

    // assert — focus did NOT escape (it stayed on the focused control since
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
    expect(screen.getByRole('button', { name: /hide .*detection overlay/i })).toBeInTheDocument()
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
      screen.queryByRole('button', { name: /(show|hide) detection overlay/i }),
    ).not.toBeInTheDocument()
  })

  it('Given the detection overlay toggle is clicked, When the user toggles it, Then aria-pressed flips without using the Live tile setting', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    window.localStorage.setItem('homecam:boxesVisible', '1')
    try {
      const eventWithBox = makeEvent({
        boxes: [{ x: 0, y: 0, w: 0.5, h: 0.5, label: 'person', score: 0.8 }],
      })
      render(<ClipModal event={eventWithBox} onClose={() => {}} />)
      const toggle = screen.getByRole('button', { name: /hide .*detection overlay/i })

      // act
      await user.click(toggle)

      // assert
      expect(screen.getByRole('button', { name: /show .*detection overlay/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      expect(window.localStorage.getItem('homecam:boxesVisible')).toBe('1')
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
  //
  // Content dedupe pass (Frank phone-round finding): the evidence pane
  // used to spell out WHEN/WHERE/WHAT/HOW-SURE four times over (title,
  // header badge, When/Where/What blocks, giant How-sure panel). Now
  // WHERE/WHAT live only in the header (title + uppercase label badge)
  // and confidence is a single small chip near the title — there is no
  // more separate "What" eyebrow or duplicated percentage in the aside.
  it('given a cat event, when the modal renders, then no WHO header, no Face match, and no duplicate What/How-sure blocks', () => {
    // arrange
    const ev = makeEvent({ label: 'cat', score: 0.59, person_name: null })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — identity surfaces are absent
    expect(screen.queryByText(/^who$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/unknown person/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/face match/i)).not.toBeInTheDocument()
    // assert — the old separate "What" and "How sure" eyebrow panels
    // are gone; the label + confidence now live in the header only.
    expect(screen.queryByText(/^what$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^how sure$/i)).not.toBeInTheDocument()
    expect(screen.getAllByText(/^cat$/i).length).toBeGreaterThan(0)
    expect(screen.getByText('59%')).toBeInTheDocument()
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument()
  })

  it('given a recognized-person event, when the modal renders, then WHO surfaces and confidence shows once near the title (no duplicate Face match)', () => {
    // arrange
    const ev = makeEvent({ label: 'person', person_name: 'alice', score: 0.87 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/^who$/i)).toBeInTheDocument()
    expect(screen.getAllByText(/alice/i).length).toBeGreaterThan(0)
    // The old "Face match: 87%" line duplicated the header's overall
    // confidence — dropped in favor of the single header chip.
    expect(screen.queryByText(/face match/i)).not.toBeInTheDocument()
    expect(screen.getByText('87%')).toBeInTheDocument()
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument()
  })

  it('applies the server-returned event immediately after identity feedback', async () => {
    const api = await import('../lib/api')
    const original = makeEvent({ person_name: 'Alice' })
    const updated = { ...original, person_name: 'Bob', person_names: ['Bob'] }
    const feedback = vi.spyOn(api, 'submitIdentityFeedback').mockResolvedValue({
      ok: true,
      event: updated,
      captures_moved: 1,
    })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    render(<ClipModal event={original} onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Wrong person' }))
    await user.type(
      screen.getByLabelText(/correct person, or leave blank for unknown/i),
      'Bob',
    )
    await user.click(screen.getByRole('button', { name: 'Save correction' }))

    expect(
      await screen.findByLabelText(/clip of bob event/i),
    ).toBeInTheDocument()
    expect(feedback).toHaveBeenCalledWith('evt-1', {
      verdict: 'incorrect',
      correct_name: 'Bob',
    })
    feedback.mockRestore()
  })

  it('given an event, when the modal renders, then the evidence pane shows exactly ONE compact When line (absolute time + relative age), not repeated When/Where/What blocks', () => {
    // arrange
    const ev = makeEvent({ label: 'cat', ts: 1700000000 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — the single remaining eyebrow in the aside is "When";
    // "Where" and "What" no longer exist as separate blocks there
    // (camera name + label already live in the header).
    expect(screen.getByText(/^when$/i)).toBeInTheDocument()
    expect(screen.queryByText(/^where$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^what$/i)).not.toBeInTheDocument()
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

  // Content dedupe pass: the old giant "How sure" panel (its own
  // eyebrow, a 3xl percentage, and a separate tier caption) repeated
  // the SAME number already shown in the header's "Recognized" pill.
  // It's now a single small chip — "N% · Tier confidence" — living
  // next to the title, and the "How sure" panel is gone entirely.
  it('Given a medium-confidence event, When the modal renders, Then the confidence chip shows the percentage and tier once near the title, and the old How-sure panel is gone', () => {
    // arrange
    const ev = makeEvent({ label: 'person', score: 0.6 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument()
    expect(screen.getByText('60%')).toBeInTheDocument()
    expect(screen.queryByText(/^how sure$/i)).not.toBeInTheDocument()
    // No baseline competition: the percentage's parent does NOT
    // carry `flex items-baseline`.
    const pct = screen.getByText('60%')
    expect(pct.parentElement?.className).not.toMatch(/flex.*items-baseline/)
  })

  it('Given a high-confidence event, When the modal renders, Then the chip reads "High confidence" (preserves SR-friendly tier signal — non-color non-numeric channel)', () => {
    // arrange / act
    const ev = makeEvent({ label: 'person', score: 0.92 })
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument()
    expect(screen.getByText('92%')).toBeInTheDocument()
  })

  it('Given a low-confidence event, When the modal renders, Then the chip reads "Low confidence"', () => {
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

  it('Given household incidents, When the destination picker opens, Then it offers only the signed-in owners incidents plus create', async () => {
    // arrange
    vi.spyOn(await import('../lib/api'), 'listIncidents').mockResolvedValue({
      items: [
        {
          id: 'mine',
          owner_username: 'TestUser',
          title: 'My incident',
          notes: '',
          created_ts: 1,
          updated_ts: 1,
          event_count: 0,
        },
        {
          id: 'theirs',
          owner_username: 'israel',
          title: 'Israel incident',
          notes: '',
          created_ts: 1,
          updated_ts: 1,
          event_count: 0,
        },
      ],
    })
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)

    // act
    fireEvent.click(screen.getByRole('button', { name: 'Add to incident' }))

    // assert
    expect(await screen.findByRole('option', { name: 'My incident' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Israel incident' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Create new incident…' })).toBeInTheDocument()

    // cleanup
    vi.restoreAllMocks()
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

  it('Given more than five sibling events, When "More from tonight" renders, Then the section list is scrollable and all fetched siblings render', async () => {
    // arrange
    const active = makeEvent({ id: 'evt-active', ts: 1700000000 })
    const siblings = Array.from({ length: 8 }, (_, i) =>
      makeEvent({
        id: `evt-sibling-${i}`,
        ts: 1700000100 + i,
        label: 'person',
        person_name: `person ${i}`,
      }),
    )
    vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
      items: [active, ...siblings],
      next_cursor: null,
    })

    // act
    render(<ClipModal event={active} onClose={() => {}} />)
    const heading = await screen.findByText(/more from tonight/i)
    const section = heading.parentElement as HTMLElement
    const list = section.querySelector('ul') as HTMLElement

    // assert — this used to render only five rows via slice(0, 5).
    expect(section.querySelectorAll('button')).toHaveLength(8)
    expect(list.className).toMatch(/overflow-y-auto/)
    expect(list.className).toMatch(/touch-pan-y/)
    expect(list.className).toMatch(/max-h-\[min\(45vh,28rem\)\]/)

    // cleanup
    vi.restoreAllMocks()
  })

  it.each([
    ['available', 'Video available'],
    ['finalizing', 'Finalizing video'],
    ['failed', 'Video unavailable'],
    ['unknown', 'Video status unknown'],
  ] as const)(
    'Given a sibling video is %s, When "More from tonight" renders, Then its leading icon truthfully says %s',
    async (videoStatus, accessibleLabel) => {
      const active = makeEvent({ id: 'evt-active', ts: 1700000000 })
      const sibling = makeEvent({
        id: `evt-${videoStatus}`,
        ts: 1700000100,
        person_name: videoStatus,
        video_status: videoStatus,
      })
      vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
        items: [sibling],
        next_cursor: null,
      })

      render(<ClipModal event={active} onClose={() => {}} />)

      const row = await screen.findByRole('button', { name: new RegExp(videoStatus, 'i') })
      expect(within(row).getByRole('img', { name: accessibleLabel })).toHaveAttribute(
        'data-video-status',
        videoStatus,
      )

      vi.restoreAllMocks()
    },
  )

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

  // ─── Real-device bug fix (Firefox Android): the clip pane rendered
  // completely blank — no player, no error, no thumb —
  // on both fresh AND minutes-old events. Root cause: an unstarted
  // <video> has no intrinsic size, so the media pane (and the flex
  // column it lived in) collapsed toward zero height before metadata
  // loaded, and `onError` never fires for a merely-pending clip. These
  // tests pin the fix: a fixed-aspect frame that's never zero-height,
  // a poster for an instant first frame, explicit pending/loading
  // states.

  it('Given the clip has not finished loading, When the modal renders, Then the media frame carries a fixed aspect ratio so it can never render at zero height', () => {
    // arrange / act
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)

    // assert — the video sits inside the aspect-video frame, which
    // sizes itself off its own width rather than the video's
    // (possibly-zero) intrinsic dimensions.
    expect(video.closest('.aspect-video')).not.toBeNull()
  })

  it('Given a thumb_url, When the video has not loaded, Then the <video> carries a poster so a frame is visible immediately (not a blank black box)', () => {
    // arrange / act
    render(
      <ClipModal
        event={makeEvent({ thumb_url: '/snapshots/thumb_9.jpg' })}
        onClose={() => {}}
      />,
    )

    // assert
    expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
      'poster',
      '/snapshots/thumb_9.jpg',
    )
  })

  it('Given a FRESH event, When the video has not loaded, Then an evidence-based loading message shows inside the frame', () => {
    // arrange — a fresh route can exist before the browser has a decoded frame.
    const ev = makeEvent({ ts: Math.floor(Date.now() / 1000) - 10 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/video is loading/i)).toBeInTheDocument()
  })

  it('Given an OLDER event, When the video has not loaded, Then a subtle loading affordance shows instead of the fresh-clip message', () => {
    // arrange — makeEvent()'s default ts is far in the past.
    const ev = makeEvent()

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert
    expect(screen.getByText(/loading video/i)).toBeInTheDocument()
    expect(screen.queryByText(/video is loading/i)).not.toBeInTheDocument()
  })

  it('Given the video fires loadeddata, When it becomes ready, Then the pending/loading overlay disappears', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    expect(screen.getByText(/loading video/i)).toBeInTheDocument()

    // act
    fireEvent(video, new Event('loadeddata'))

    // assert
    expect(screen.queryByText(/loading video/i)).not.toBeInTheDocument()
  })

  it('Given the video starts playing before loadeddata is observed, When play fires, Then the loading overlay disappears', () => {
    // arrange
    render(<ClipModal event={makeEvent()} onClose={() => {}} />)
    const video = screen.getByLabelText(/clip of person event/i)
    expect(screen.getByText(/loading video/i)).toBeInTheDocument()

    // act
    fireEvent.play(video)

    // assert
    expect(screen.queryByText(/loading video/i)).not.toBeInTheDocument()
  })

  it('Given the clip has not finished loading, When the modal renders, Then event actions are still absent from the viewer', () => {
    // arrange / act
    render(<ClipModal event={makeEvent({ label: 'cat' })} onClose={() => {}} />)

    // assert
    expect(screen.queryByRole('button', { name: /share or copy link/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save event/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete this cat event/i })).not.toBeInTheDocument()
  })

  // ─── "More from tonight" subline dedupe (Frank phone-round finding) ──

  it('Given a sibling event on the SAME camera as the active event, When "More from tonight" renders, Then its subline shows recognition + relative time WITHOUT repeating the location', async () => {
    // arrange
    const active = makeEvent({ id: 'evt-active', ts: 1700000000, camera_id: 'cam1' })
    const sibling = makeEvent({
      id: 'evt-sibling',
      ts: 1700000500,
      camera_id: 'cam1',
      label: 'person',
      person_name: null,
    })
    vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
      items: [sibling],
      next_cursor: null,
    })

    // act
    render(<ClipModal event={active} onClose={() => {}} />)
    const row = await screen.findByRole('button', { name: /not recognized/i })

    // assert — the title already says "the front door" once; the
    // subline must not repeat it since the sibling is on the same
    // camera as the event currently open.
    expect(row.textContent).toMatch(/not recognized/i)
    const matches = row.textContent?.match(/the front door/gi) ?? []
    expect(matches.length).toBe(1)

    // cleanup
    vi.restoreAllMocks()
  })

  it('Given a sibling event on a DIFFERENT camera, When "More from tonight" renders, Then its subline includes that camera\'s location', async () => {
    // arrange
    const active = makeEvent({ id: 'evt-active', ts: 1700000000, camera_id: 'cam1' })
    const sibling = makeEvent({
      id: 'evt-sibling',
      ts: 1700000500,
      camera_id: 'cam2',
      label: 'person',
      person_name: null,
    })
    vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
      items: [sibling],
      next_cursor: null,
    })

    // act
    render(<ClipModal event={active} onClose={() => {}} />)
    const row = await screen.findByRole('button', { name: /cam2/i })

    // assert
    expect(row.textContent).toMatch(/not recognized/i)
    expect(row.textContent).toMatch(/cam2/i)

    // cleanup
    vi.restoreAllMocks()
  })

  // UI/UX overhaul 2026-07-07 (coherence MOBILE #1): a rotated phone
  // (landscape, height <520px) used to get the PORTRAIT stack — video
  // squeezed to a narrow width-driven strip, evidence aside scrolled
  // below. The modal now uses a landscape-phone split, but keeps the
  // video pane uses the available height while the title moves
  // into compact overlays instead of stealing scarce vertical space.
  it('Given the modal renders, Then the dialog, video pane and evidence aside carry the landscape-phone two-pane classes (coherence MOBILE #1)', () => {
    // arrange
    const ev = makeEvent({ label: 'person', score: 0.5 })

    // act
    render(<ClipModal event={ev} onClose={() => {}} />)

    // assert — container flows as a clipped row...
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toMatch(/landscape-phone:flex-row/)
    expect(dialog.className).toMatch(/landscape-phone:overflow-hidden/)
    // ...the video column fills the remaining width, while the video
    // pane itself fills the available short viewport height...
    expect(
      dialog.querySelector('[class*="landscape-phone:flex-1"]'),
    ).not.toBeNull()
    const pane = screen.getByTestId('clip-swipe-pane')
    expect(pane.className).toMatch(/landscape-phone:flex-1/)
    expect(pane.className).toMatch(/landscape-phone:aspect-auto/)
    expect(pane.className).toMatch(/landscape-phone:self-stretch/)
    expect(pane.className).toMatch(/landscape-phone:h-auto/)
    expect(pane.className).toMatch(/landscape-phone:max-w-none/)
    expect(pane.className).toMatch(/landscape-phone:m-2/)
    expect(pane.className).toMatch(/landscape-phone:rounded-xl/)
    // ...and the aside becomes the proportional right column with a
    // side border instead of a top border.
    const aside = screen.getByRole('complementary', {
      name: /incident details/i,
    })
    expect(aside.className).toMatch(/landscape-phone:w-\[38%\]/)
    expect(aside.className).toMatch(/landscape-phone:h-full/)
    expect(aside.className).toMatch(/landscape-phone:min-h-0/)
    expect(aside.className).toMatch(/landscape-phone:overflow-hidden/)
    expect(aside.className).toMatch(/landscape-phone:border-l/)
    expect(aside.className).toMatch(/landscape-phone:border-t-0/)
  })

  // ─── UI/UX overhaul 2026-07-07 (hari GESTURE-5): swipe-between-clips.
  // A horizontal swipe on the video pane flips to the neighboring event
  // from the already-fetched "More from tonight" window, via the SAME
  // setEvent mechanism a rail-row tap uses. Direction matches the rail's
  // newest-first order: swipe LEFT = next row DOWN the list (older),
  // swipe RIGHT = back UP (newer). At either end of the window the pane
  // rubber-bands slightly and stays (no wrap).
  describe('swipe between clips (GESTURE-5)', () => {
    // Rail order is newest-first: [evt-newer, evt-older] around the
    // active event, so the swipe timeline is newer → active → older.
    async function renderWithSiblings() {
      const active = makeEvent({ id: 'evt-active', ts: 1700000000, label: 'person' })
      const newer = makeEvent({ id: 'evt-newer', ts: 1700000600, label: 'cat' })
      const older = makeEvent({ id: 'evt-older', ts: 1699999000, label: 'dog' })
      vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
        items: [newer, older],
        next_cursor: null,
      })
      render(<ClipModal event={active} onClose={() => {}} />)
      await screen.findByText(/more from tonight/i)
      return { active, newer, older, pane: screen.getByTestId('clip-swipe-pane') }
    }

    function drag(pane: HTMLElement, dx: number, dy = 0) {
      fireEvent.touchStart(pane, { touches: [{ clientX: 200, clientY: 150 }] })
      fireEvent.touchMove(pane, {
        touches: [{ clientX: 200 + dx, clientY: 150 + dy }],
      })
    }

    it('Given siblings are loaded, When the user swipes LEFT past the threshold on the video pane, Then the modal advances to the next OLDER event (down the rail)', async () => {
      // arrange
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, -90)
      fireEvent.touchEnd(pane)

      // assert — same swap mechanism as tapping a rail row: the video
      // src now points at the older sibling's clip.
      expect(screen.getByLabelText(/clip of dog event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-older/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given siblings are loaded, When the user swipes RIGHT past the threshold, Then the modal goes back UP the rail to the NEWER event', async () => {
      // arrange
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, 90)
      fireEvent.touchEnd(pane)

      // assert
      await waitFor(() => {
        expect(screen.getByLabelText(/clip of cat event/i)).toHaveAttribute(
          'src',
          '/api/events/evt-newer/clip',
        )
      })

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given a drag BELOW the ~70px threshold, When the finger lifts, Then the pane snaps back and the event does not change', async () => {
      // arrange
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, -40)
      const midDrag = pane.style.transform
      fireEvent.touchEnd(pane)

      // assert — feedback tracked the finger, then released to rest.
      expect(midDrag).toBe('translateX(-40px)')
      expect(pane.style.transform).toBe('')
      expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-active/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given a long drag, When the finger keeps pulling, Then the visual feedback is clamped to the ~48px cap (imperative style, no runaway)', async () => {
      // arrange
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, -200)

      // assert
      expect(pane.style.transform).toBe('translateX(-48px)')

      // cleanup
      fireEvent.touchEnd(pane)
      vi.restoreAllMocks()
    })

    it('Given a gesture that starts VERTICALLY (scrolling), When it later gains horizontal travel, Then the axis lock keeps it a scroll — no feedback and no event change', async () => {
      // arrange
      const { pane } = await renderWithSiblings()

      // act — first >6px move is vertical, so the axis locks to 'v';
      // a later strongly-horizontal move must NOT be re-interpreted.
      fireEvent.touchStart(pane, { touches: [{ clientX: 200, clientY: 150 }] })
      fireEvent.touchMove(pane, { touches: [{ clientX: 202, clientY: 190 }] })
      fireEvent.touchMove(pane, { touches: [{ clientX: 60, clientY: 210 }] })
      fireEvent.touchEnd(pane)

      // assert
      expect(pane.style.transform).toBe('')
      expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-active/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given the active event is the NEWEST in the window, When the user swipes right past the threshold, Then the pane rubber-bands (small resisted feedback) and stays — no wrap', async () => {
      // arrange — active is newest: no neighbor to the right.
      const active = makeEvent({ id: 'evt-active', ts: 1700001000, label: 'person' })
      const older = makeEvent({ id: 'evt-older', ts: 1700000000, label: 'cat' })
      vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
        items: [older],
        next_cursor: null,
      })
      render(<ClipModal event={active} onClose={() => {}} />)
      await screen.findByText(/more from tonight/i)
      const pane = screen.getByTestId('clip-swipe-pane')

      // act
      drag(pane, 90)
      const midDrag = pane.style.transform
      fireEvent.touchEnd(pane)

      // assert — 90px of finger travel shows only the resisted,
      // capped rubber-band (90/3 = 30, capped at 20), then settles.
      expect(midDrag).toBe('translateX(20px)')
      expect(pane.style.transform).toBe('')
      expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-active/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given a touch that starts on a CONTROL, When it moves horizontally past the threshold, Then no swipe happens — controls stay controls', async () => {
      // arrange
      const active = makeEvent({
        id: 'evt-active',
        ts: 1700000000,
        label: 'person',
        boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'person', score: 0.9 }],
      })
      const older = makeEvent({ id: 'evt-older', ts: 1699999000, label: 'cat' })
      vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
        items: [older],
        next_cursor: null,
      })
      render(<ClipModal event={active} onClose={() => {}} />)
      await screen.findByText(/more from tonight/i)
      const pane = screen.getByTestId('clip-swipe-pane')
      const control = screen.getByRole('button', { name: /playback settings/i })

      // act — the gesture BEGINS on the button; moves bubble through
      // the pane but the gesture was never armed.
      fireEvent.touchStart(control, { touches: [{ clientX: 200, clientY: 150 }] })
      fireEvent.touchMove(pane, { touches: [{ clientX: 80, clientY: 150 }] })
      fireEvent.touchEnd(pane)

      // assert
      expect(pane.style.transform).toBe('')
      expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-active/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given prefers-reduced-motion, When a below-threshold drag releases, Then the pane returns with NO snap animation (no transition)', async () => {
      // arrange — jsdom has no matchMedia; install a reduce=true stub.
      const mm = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      vi.stubGlobal('matchMedia', mm)
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, -40)
      fireEvent.touchEnd(pane)

      // assert — snapped back instantly, no transition property set.
      expect(pane.style.transform).toBe('')
      expect(pane.style.transition).toBe('')

      // cleanup
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    it('Given motion is allowed, When a below-threshold drag releases, Then the snap-back uses an ease-out transform transition', async () => {
      // arrange — matchMedia present, reduce NOT matched.
      const mm = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }))
      vi.stubGlobal('matchMedia', mm)
      const { pane } = await renderWithSiblings()

      // act
      drag(pane, -40)
      fireEvent.touchEnd(pane)

      // assert
      expect(pane.style.transform).toBe('')
      expect(pane.style.transition).toContain('transform')

      // cleanup
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })
  })

  // Pinch-to-zoom on the clip (user request 2026-07-07): two fingers
  // scale the zoom layer via lib/pinchZoom's clamped math; one finger
  // pans while zoomed and clip-swipe is suppressed; switching events
  // resets to 1x. jsdom has zero-size rects, so translation clamps to
  // 0 — assertions pin scale, suppression, and reset.
  describe('pinch-to-zoom on the clip', () => {
    async function renderZoomable() {
      const active = makeEvent({ id: 'evt-active', ts: 1700000000, label: 'person' })
      const older = makeEvent({ id: 'evt-older', ts: 1699999000, label: 'cat' })
      vi.spyOn(await import('../lib/api'), 'searchEvents').mockResolvedValue({
        items: [older],
        next_cursor: null,
      })
      render(<ClipModal event={active} onClose={() => {}} />)
      await screen.findByText(/more from tonight/i)
      return {
        pane: screen.getByTestId('clip-swipe-pane'),
        layer: screen.getByTestId('clip-zoom-layer'),
      }
    }

    function pinchOut(pane: HTMLElement) {
      fireEvent.touchStart(pane, {
        touches: [
          { clientX: 180, clientY: 150 },
          { clientX: 220, clientY: 150 },
        ],
      })
      fireEvent.touchMove(pane, {
        touches: [
          { clientX: 120, clientY: 150 },
          { clientX: 280, clientY: 150 },
        ],
      })
      fireEvent.touchEnd(pane)
    }

    it('Given a playing clip is embedded, When two fingers pinch outward, Then the zoom layer scales up and native media chrome is disabled', async () => {
      // arrange
      const { pane, layer } = await renderZoomable()

      // act
      pinchOut(pane)

      // assert — scale(4) at the midpoint; jsdom's zero-size pane
      // clamps translation to 0.
      expect(layer.style.transform).toContain('scale(4)')
      await waitFor(() =>
        expect(screen.getByLabelText(/clip of person event/i)).not.toHaveAttribute('controls'),
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given the clip is zoomed in, When one finger drags horizontally past the swipe threshold, Then the picture PANS and the modal does NOT advance to a sibling', async () => {
      // arrange
      const { pane } = await renderZoomable()
      pinchOut(pane)

      // act — a drag that would advance to evt-older at 1x.
      fireEvent.touchStart(pane, { touches: [{ clientX: 200, clientY: 150 }] })
      fireEvent.touchMove(pane, { touches: [{ clientX: 90, clientY: 150 }] })
      fireEvent.touchEnd(pane)

      // assert — still the active event's clip.
      expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
        'src',
        '/api/events/evt-active/clip',
      )

      // cleanup
      vi.restoreAllMocks()
    })

    it('Given the clip is zoomed in, When the modal swaps to a different event, Then zoom resets to identity', async () => {
      // arrange
      const { pane, layer } = await renderZoomable()
      pinchOut(pane)
      expect(layer.style.transform).not.toBe('')

      // act — swap via the rail (the tap path swipe reuses).
      fireEvent.click(screen.getByRole('button', { name: /cat/i }))

      // assert
      await waitFor(() => expect(layer.style.transform).toBe(''))

      // cleanup
      vi.restoreAllMocks()
    })
  })
})
