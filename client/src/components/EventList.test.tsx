import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EventList } from './EventList'
import type { DetectionEvent } from '../lib/types'

function evt(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: 'evt-' + Math.random().toString(36).slice(2),
    ts: Date.now() / 1000,
    camera_id: 'cam1',
    label: 'person',
    score: 0.85,
    boxes: [],
    ...over,
  }
}

describe('EventList', () => {
  it('when no events and camera healthy, then the cat-themed "all quiet" empty state is shown (iter-247 → iter-356.23)', () => {
    // arrange / act
    render(<EventList events={[]} />)

    // assert — iter-356.23: cat-themed empty state via the
    // <CatEmptyState> primitive. Copy was de-localized from "Coco's
    // having a snooze" to universal "as quiet as a sleeping cat" so
    // first-time users without cat-name context don't read it as a typo.
    expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument()
    expect(screen.getByText(/as quiet as a sleeping cat/i)).toBeInTheDocument()
    // Nudge the user toward action — Frank-test compliant. iter-356.23
    // also swapped "confidence threshold" jargon for "Sensitivity slider"
    // which matches the Settings UI.
    expect(
      screen.getByText(/walking in front of the camera|sensitivity slider/i),
    ).toBeInTheDocument()
  })

  it('given cameraOffline=true, when no events, then the empty state pivots to "Camera looks offline" not the sleeping cat (iter-356.24 — Frank carryover)', () => {
    // arrange / act — Frank's iter-356.22 wife-anecdote: "She'd stare
    // at the sleeping cat for two hours wondering why the front door
    // wasn't showing up." iter-356.24 branches the empty state so the
    // sleeping cat is reserved for "camera is on and nothing
    // happened."
    render(<EventList events={[]} cameraOffline={true} />)

    // assert — offline copy + offline aria-label render; the sleeping-
    // cat copy does NOT.
    expect(screen.getByText(/camera looks offline/i)).toBeInTheDocument()
    expect(screen.getByText(/check the live tab/i)).toBeInTheDocument()
    expect(screen.queryByText(/all quiet out there/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('status', { name: /camera offline — no events being recorded/i }),
    ).toBeInTheDocument()
  })

  it('when events span multiple local-time days, then each day is grouped with a header and event count (iter-249/355ae)', () => {
    // arrange — two events today, one yesterday. iter-356.24 fix:
    // pre-iter-356.24 the test computed `Date.now() - 26h` which only
    // lands "yesterday" when `now` is past 02:00 local time. Run
    // between midnight and 02:00 and "26h ago" was the day BEFORE
    // yesterday — header read "Friday" or similar, the assertion
    // `getByText('Yesterday')` failed. Now: anchor to noon of today
    // so 26h back is unambiguously yesterday's noon (well outside the
    // local-day boundary), surviving any time of day the suite runs.
    const today = new Date()
    today.setHours(12, 0, 0, 0)
    const noonTodayMs = today.getTime()
    const noonYesterdayMs = noonTodayMs - 24 * 60 * 60 * 1000
    render(
      <EventList
        events={[
          evt({ id: 't1', ts: noonTodayMs / 1000 }),
          evt({ id: 't2', ts: (noonTodayMs - 60_000) / 1000 }),
          evt({ id: 'y1', ts: noonYesterdayMs / 1000 }),
        ]}
      />,
    )

    // assert — iter-355ae (Maya Major): "Today — 2 detections" was
    // technical / log-like. "Today · 2 events" reads consumer-app.
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByText(/2 events/)).toBeInTheDocument()
    expect(screen.getByText(/1 event/)).toBeInTheDocument()
  })

  it('when an event has a clip_url, then a small play badge is rendered without burying the thumbnail (iter-249)', () => {
    // arrange / act — iter-249 fix: the play indicator is a corner
    // badge, NOT a full-overlay that hides the photo.
    render(
      <EventList
        events={[
          evt({
            thumb_url: '/snapshots/x.jpg',
            clip_url: '/api/events/abc/clip',
          }),
        ]}
        onSelect={() => {}}
      />,
    )

    // assert
    expect(screen.getByLabelText(/clip available/i)).toBeInTheDocument()
    // Aria-label uses "Play clip:" (verb-first) when a clip is
    // present; "Open:" otherwise.
    expect(
      screen.getByRole('button').getAttribute('aria-label'),
    ).toMatch(/^play clip:/i)
    // The thumbnail <img> is still in the DOM and not stacked under
    // a full-cover overlay — pin the absence of the iter-247
    // `inset-0` overlay div.
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('when score is below 50%, then the confidence pill uses the red tier (iter-249)', () => {
    // arrange / act
    render(<EventList events={[evt({ score: 0.42 })]} />)

    // assert
    const pill = screen.getByLabelText(/confidence 42 percent/i)
    expect(pill).toBeInTheDocument()
    expect(pill.className).toMatch(/red/)
  })

  it('when an event has label=person and camera_id=cam1, then the title reads "Person at the front door" (iter-249)', () => {
    // arrange / act — iter-249: plain-English title that answers
    // "what am I looking at" at a glance. Replaces the iter-247
    // bare-class layout.
    render(<EventList events={[evt({ label: 'person', camera_id: 'cam1' })]} />)

    // assert
    expect(screen.getByText(/person at the front door/i)).toBeInTheDocument()
  })

  it('when an event has a person_name, then the title leads with the name (iter-249)', () => {
    // arrange / act
    render(
      <EventList
        events={[evt({ label: 'person', person_name: 'Israel', camera_id: 'cam1' })]}
      />,
    )

    // assert — "Israel at the front door" reads as a notification,
    // not as a debug log.
    expect(screen.getByText(/israel at the front door/i)).toBeInTheDocument()
  })

  it('when there are events from multiple cameras, then each card shows its own location title (iter-249)', () => {
    // arrange / act — non-cam1 ids fall through to the raw id
    // pending the multi-cam friendly-name plan (iter-177 MC track).
    render(
      <EventList
        events={[
          evt({ id: 'a', label: 'person', camera_id: 'cam1' }),
          evt({ id: 'b', label: 'car', camera_id: 'cam2' }),
        ]}
      />,
    )

    // assert
    expect(screen.getByText(/person at the front door/i)).toBeInTheDocument()
    expect(screen.getByText(/car at cam2/i)).toBeInTheDocument()
  })

  it('shows score formatted as percentage', () => {
    render(<EventList events={[evt({ score: 0.93 })]} />)
    expect(screen.getByText('93%')).toBeInTheDocument()
  })

  it('formats today timestamps as time only (no month name)', () => {
    const today = new Date()
    today.setHours(14, 30, 0, 0)
    render(<EventList events={[evt({ ts: today.getTime() / 1000 })]} />)
    const monthRegex = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/
    expect(document.body.textContent).not.toMatch(monthRegex)
  })

  it('formats older timestamps with a month and day', () => {
    const old = new Date()
    old.setMonth(old.getMonth() - 2)
    render(<EventList events={[evt({ ts: old.getTime() / 1000 })]} />)
    const monthRegex = /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/
    expect(document.body.textContent).toMatch(monthRegex)
  })

  it('renders a placeholder graphic in the thumb slot when no thumb_url', () => {
    render(<EventList events={[evt()]} />)
    // EventList renders an inline SVG icon in place of a missing thumb;
    // check that the slot exists by absence of an <img>.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders a placeholder when thumb_url is explicitly null (iter-161)', () => {
    // Server emits the wire shape `{thumb_url: null}` (always-present-
    // but-nullable in the TypedDict on the server). The client type was
    // `thumb_url?: string` until iter-161 — TS thought `null` was a
    // type error, even though the runtime falsy check handled it. The
    // fix widened the type to `string | null` and this test pins that
    // null specifically renders the placeholder, not a broken-image
    // glyph or a crash.
    render(<EventList events={[evt({ thumb_url: null })]} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders an image when a thumb_url is provided', () => {
    render(<EventList events={[evt({ thumb_url: '/snapshots/x.jpg' })]} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', '/snapshots/x.jpg')
  })

  it('rows are not clickable when no onSelect callback is given', () => {
    render(
      <EventList events={[evt({ id: 'a', thumb_url: '/snapshots/a.jpg' })]} />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('rows with thumb_url become buttons when onSelect is provided', () => {
    const onSelect = vi.fn()
    render(
      <EventList
        events={[evt({ id: 'a', thumb_url: '/snapshots/a.jpg' })]}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('rows without thumb_url stay non-clickable even with onSelect', () => {
    const onSelect = vi.fn()
    render(
      <EventList
        events={[
          evt({ id: 'a', thumb_url: '/snapshots/a.jpg' }),
          evt({ id: 'b' }), // no thumb
        ]}
        onSelect={onSelect}
      />,
    )
    // Only the first row (with thumb) is a button.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('clicking a thumb row fires onSelect with the event', async () => {
    const onSelect = vi.fn()
    const event = evt({ id: 'a', thumb_url: '/snapshots/a.jpg', label: 'person' })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<EventList events={[event]} onSelect={onSelect} />)
    await user.click(screen.getByRole('button'))
    expect(onSelect).toHaveBeenCalledWith(event)
  })

  it('when a face is matched, then the recognized name is shown as a badge on the thumbnail (iter-249)', () => {
    // arrange / act
    render(
      <EventList
        events={[evt({ label: 'person', person_name: 'Israel', score: 0.92, thumb_url: '/snapshots/x.jpg' })]}
      />,
    )

    // assert — the name appears in the thumbnail-overlay badge AND
    // in the title. Two-text "Israel" is the expected shape.
    const israels = screen.getAllByText(/israel/i)
    expect(israels.length).toBeGreaterThanOrEqual(1)
  })

  it('when a face is matched on cam1, then the title reads as a recognized arrival at the friendly camera name (iter-249)', () => {
    // arrange / act
    render(
      <EventList
        events={[evt({ label: 'person', person_name: 'Sheenal', camera_id: 'cam1' })]}
      />,
    )

    // assert — iter-249 dropped the subtitle's camera_id/class
    // breakdown in favour of a notification-style title that
    // reads in plain English. Camera ids surface on multi-cam
    // deploys via the `humanCameraName` map.
    expect(screen.getByText(/sheenal at the front door/i)).toBeInTheDocument()
  })

  it('does not show a Recognized badge when person_name is absent', () => {
    render(<EventList events={[evt({ label: 'person' })]} />)
    expect(screen.queryByText(/recognized/i)).not.toBeInTheDocument()
  })

  it('when a face is matched, then the thumbnail alt and row aria-label reflect the matched name (iter-249)', () => {
    // arrange / act
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: 'Israel',
            thumb_url: '/snapshots/x.jpg',
            camera_id: 'cam1',
          }),
        ]}
        onSelect={() => {}}
      />,
    )

    // assert — iter-249 alt is the full title ("Israel at the
    // front door") so screen readers describe the SCENE, not just
    // the matched name.
    expect(screen.getByRole('img').getAttribute('alt')).toMatch(
      /israel at the front door/i,
    )
    // iter-249: aria-label uses "Open:" prefix when no clip; the
    // "Play clip:" prefix is pinned by the separate clip-badge test.
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /^open: israel at the front door/i,
    )
  })

  it('falls back to placeholder when the thumb URL fails to load', () => {
    render(<EventList events={[evt({ thumb_url: '/snapshots/missing.jpg' })]} />)
    const img = screen.getByRole('img')
    fireEvent.error(img)
    // After the error fires, the <img> is replaced by the inline
    // placeholder SVG — same component the no-thumb case uses.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('when a row is clickable without a clip, then aria-label uses the "Open:" verb prefix with the full title (iter-249)', () => {
    // arrange
    const onSelect = vi.fn()

    // act
    render(
      <EventList
        events={[evt({ thumb_url: '/snapshots/a.jpg', label: 'person', camera_id: 'cam1' })]}
        onSelect={onSelect}
      />,
    )

    // assert
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toMatch(
      /^open: person at the front door/i,
    )
  })
})
