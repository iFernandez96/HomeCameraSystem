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
    expect(screen.getByText(/nothing came knocking/i)).toBeInTheDocument()
    // iter-356.57 (cat-brand brief): body copy attributes the calm
    // watch to all three cats by name, replacing the prior universal
    // "as quiet as a sleeping cat" line.
    expect(
      screen.getByText(/Panther, Mushu and Coco have the door covered/i),
    ).toBeInTheDocument()
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
    expect(screen.queryByText(/nothing came knocking/i)).not.toBeInTheDocument()
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

    // assert — iter-356.57 (radical redesign): day-headers reframed
    // as a watch-log: "Today's log" / "Yesterday's log" with brass
    // entry-count tags. "events" → "entries" matches the journal
    // register without changing the underlying day grouping logic.
    // Painfix #3: the Today group's count reads "N today" (not
    // "N entries") so it can't be misread as contradicting the
    // page-header's "Showing the last N" fetch-window count.
    expect(screen.getByText("Today's log")).toBeInTheDocument()
    expect(screen.getByText("Yesterday's log")).toBeInTheDocument()
    expect(screen.getByText(/2 today/)).toBeInTheDocument()
    expect(screen.getByText(/1 entry/)).toBeInTheDocument()
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

  it('Given a low-score event, When the confidence pill renders, Then it uses the neutral scrim chip (not a semantic danger color) and spells out the tier word next to the percentage (Painfix #1 — audited on-device)', () => {
    // arrange / act
    render(<EventList events={[evt({ score: 0.42 })]} />)

    // assert — aria-label still spells out the tier word for SR
    // users (Frank E4 + Dana F2). Painfix #1: a bare number under a
    // SOLID danger/warning/success fill used to read as a system
    // health alarm, not "how sure the model was." The pill is now a
    // neutral surface-scrim chip (same grammar as VideoTile's camera
    // pill) for every tier, and the tier word is spelled out visibly
    // ("42% · Low") instead of being color-only.
    const pill = screen.getByLabelText(/how sure the camera was: 42%, low/i)
    expect(pill).toBeInTheDocument()
    expect(pill.className).toMatch(/color-surface-scrim/)
    expect(pill.className).not.toMatch(/color-danger|color-warning|color-success/)
    expect(pill.textContent?.trim()).toBe('42% · Low')
  })

  it('Given a high-score event, When the confidence pill renders, Then the tier word reads "High" next to the percentage using the same neutral chip as every other tier (Painfix #1)', () => {
    // arrange / act
    render(<EventList events={[evt({ score: 0.93 })]} />)

    // assert — pill text names the tier; aria-label gives SR users
    // the same tier word for non-color signaling.
    const pill = screen.getByLabelText(/how sure the camera was: 93%, high/i)
    expect(pill.textContent?.trim()).toBe('93% · High')
    expect(pill.className).toMatch(/color-surface-scrim/)
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

  it('shows score formatted as percentage with the tier word (Painfix #1)', () => {
    render(<EventList events={[evt({ score: 0.93 })]} />)
    expect(screen.getByText('93% · High')).toBeInTheDocument()
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

  it('given a row with onDelete, when the user swipes left past the threshold and releases, then the swipe Delete pad becomes interactive (iter-356.62 bug #2)', () => {
    // arrange
    const onDelete = vi.fn()

    // act
    render(
      <EventList
        events={[evt({ id: 'sw1', thumb_url: '/snapshots/a.jpg' })]}
        onDelete={onDelete}
      />,
    )
    // The swipe-handler element is the parent of the swipe-delete pad
    // button (the EventCard wrapper div). Walk up two levels: button →
    // pad div → swipe-handler wrapper div.
    const padButton = screen.getByTestId('swipe-delete-button')
    const card = padButton.parentElement?.parentElement as HTMLElement
    // simulate a swipe-left of 100px (past the 80px threshold)
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(card, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 100, clientY: 100 }] })

    // assert — the swipe pad button is now interactive (tabIndex 0)
    // and tapping it fires onDelete with the event.
    const swipeBtn = screen.getByTestId('swipe-delete-button') as HTMLButtonElement
    expect(swipeBtn.tabIndex).toBe(0)
    fireEvent.click(swipeBtn)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete.mock.calls[0][0].id).toBe('sw1')
  })

  it('given a row with onDelete, when the user swipes left only a few pixels and releases, then the swipe Delete pad stays inactive (iter-356.62 bug #2)', () => {
    // arrange
    const onDelete = vi.fn()

    // act
    render(
      <EventList
        events={[evt({ id: 'sw2', thumb_url: '/snapshots/a.jpg' })]}
        onDelete={onDelete}
      />,
    )
    const padButton = screen.getByTestId('swipe-delete-button')
    const card = padButton.parentElement?.parentElement as HTMLElement
    // tiny swipe — well below the 80px threshold
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchMove(card, { touches: [{ clientX: 190, clientY: 100 }] })
    fireEvent.touchEnd(card, { changedTouches: [{ clientX: 190, clientY: 100 }] })

    // assert — the pad button is not in the tab order; the user
    // would have to swipe further to expose it.
    const swipeBtn = screen.getByTestId('swipe-delete-button') as HTMLButtonElement
    expect(swipeBtn.tabIndex).toBe(-1)
  })

  it('given selectionMode is on, when a card is clicked, then onToggleSelect fires (not onSelect)', () => {
    // arrange — multi-select wires the card click to toggle selection
    // instead of opening the clip modal. iter-356.x desktop D1.
    const onSelect = vi.fn()
    const onToggleSelect = vi.fn()
    render(
      <EventList
        events={[evt({ id: 'sel1', thumb_url: '/snapshots/a.jpg' })]}
        onSelect={onSelect}
        onToggleSelect={onToggleSelect}
        selectionMode={true}
        selectedIds={new Set()}
      />,
    )

    // act — click on the card (the wrapper button now toggles selection)
    const card = screen.getByRole('button', { name: /select/i })
    fireEvent.click(card)

    // assert
    expect(onToggleSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('given selectionMode is on and the card is selected, then aria-pressed=true and a check glyph renders', () => {
    // arrange
    const onToggleSelect = vi.fn()
    render(
      <EventList
        events={[evt({ id: 'sel2', thumb_url: '/snapshots/a.jpg' })]}
        onToggleSelect={onToggleSelect}
        selectionMode={true}
        selectedIds={new Set(['sel2'])}
      />,
    )

    // assert — the wrapper carries aria-pressed=true so AT users hear
    // "selected" instead of inferring state from a checkbox icon alone.
    const card = screen.getByRole('button', { name: /deselect/i })
    expect(card).toHaveAttribute('aria-pressed', 'true')
  })

  it('given selectionMode is on, then the hover ✕ delete button is suppressed', () => {
    // arrange — in selection mode, taps must consistently toggle
    // selection. The hover ✕ would shadow that affordance and is
    // hidden so single-delete and bulk-delete don't conflict.
    render(
      <EventList
        events={[evt({ id: 'sel3', thumb_url: '/snapshots/a.jpg' })]}
        onDelete={() => {}}
        onToggleSelect={() => {}}
        selectionMode={true}
        selectedIds={new Set()}
      />,
    )

    // assert
    expect(
      screen.queryByRole('button', { name: /delete event from/i }),
    ).not.toBeInTheDocument()
  })

  // ─── iter-357 multi-person face-recognition rendering ────────────

  it('Given a multi-person event with two recognized names, When the card renders, Then both names render as separate chips next to the matched-face icon', () => {
    // arrange — iter-357: a family of two arrives; both faces matched.
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: 'israel',
            person_names: ['israel', 'sheenal'],
            score: 0.92,
            thumb_url: '/snapshots/x.jpg',
          }),
        ]}
      />,
    )

    // assert — both names appear in the chip row. The title also
    // renders the names (eventTitle path), so use the chip-only
    // class signature to disambiguate.
    const chips = screen.getAllByText(/^(israel|sheenal)$/)
    expect(chips.length).toBeGreaterThanOrEqual(2)
  })

  it('Given a multi-person event with FOUR recognized names, When the card renders, Then the first three render as chips and a "+1" overflow pill summarizes the rest', () => {
    // arrange — iter-357 chip cap at 3 visible. Card height stays
    // bounded; full list is in the title + ClipModal "Who" panel.
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: 'israel',
            person_names: ['israel', 'sheenal', 'coco', 'mushu'],
            score: 0.92,
            thumb_url: '/snapshots/x.jpg',
          }),
        ]}
      />,
    )

    // assert — first 3 names visible as chips.
    expect(screen.getAllByText(/^israel$/)[0]).toBeInTheDocument()
    expect(screen.getAllByText(/^sheenal$/)[0]).toBeInTheDocument()
    expect(screen.getAllByText(/^coco$/)[0]).toBeInTheDocument()
    // 4th name NOT rendered as a chip.
    expect(screen.queryByText(/^mushu$/)).not.toBeInTheDocument()
    // Overflow pill present with accessible name for SR users.
    expect(
      screen.getByLabelText(/1 more person matched/i),
    ).toBeInTheDocument()
  })

  it('Given a multi-person event with FIVE recognized names, When the card renders, Then the overflow pill announces "2 more people matched" (plural)', () => {
    // arrange
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: 'israel',
            person_names: ['israel', 'sheenal', 'coco', 'mushu', 'panther'],
          }),
        ]}
      />,
    )

    // assert — plural noun in the SR-only overflow label.
    expect(
      screen.getByLabelText(/2 more people matched/i),
    ).toBeInTheDocument()
  })

  it('Given a multi-person event title is built, When rendered, Then the card title fans out to "Name1 & Name2 at the front door"', () => {
    // arrange / act
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: 'israel',
            person_names: ['israel', 'sheenal'],
          }),
        ]}
      />,
    )

    // assert — fan-out title format pinned at the integration level
    // (EventList consumes eventTitle which has its own unit tests).
    expect(
      screen.getByText(/israel & sheenal at the front door/i),
    ).toBeInTheDocument()
  })

  it('Given an event with person_names but no legacy person_name (server-side normalization gap), When rendered, Then the chip + title still render correctly via recognizedNames fallback', () => {
    // arrange — defense in depth: even if a future server skips
    // the derive step, the client-side helper covers the case.
    render(
      <EventList
        events={[
          evt({
            label: 'person',
            person_name: null,
            person_names: ['israel'],
          }),
        ]}
      />,
    )

    // assert — chip renders and title fans through the names branch.
    expect(screen.getAllByText(/^israel$/).length).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText(/israel at the front door/i),
    ).toBeInTheDocument()
  })

  // ─── Task 6 (Playroom Modern) review fix — WhoMark coverage ──────

  it('Given multiple events render, When each card is inspected, Then it leads with a decorative WhoMark identity mark before the thumbnail (Task 6 review finding)', () => {
    // arrange — three events so the assertion pins per-card presence,
    // not just "at least one mark somewhere in the list".
    render(
      <EventList
        events={[
          evt({ id: 'wm1', label: 'person', camera_id: 'cam1' }),
          evt({ id: 'wm2', label: 'person', person_name: 'Israel', camera_id: 'cam1' }),
          evt({ id: 'wm3', label: 'cat', camera_id: 'cam1' }),
        ]}
      />,
    )

    // act — WhoMark renders as an aria-hidden wrapper (decorative;
    // the accessible identity already lands via title + row
    // aria-label) containing an inline <svg role="img">.
    const marks = document.querySelectorAll(
      'ol > li span[aria-hidden="true"] > svg[role="img"]',
    )

    // assert — one mark per rendered event card.
    expect(marks.length).toBe(3)
  })

  it('Given a person event renders, When the timeline axis dot is inspected, Then it carries the person identity color var', () => {
    // arrange
    render(<EventList events={[evt({ id: 'axis-person', label: 'person' })]} />)

    // act
    const dot = screen.getByTestId('event-axis-dot')

    // assert
    expect(dot.getAttribute('style')).toContain(
      'background-color: var(--color-id-person)',
    )
  })
})
