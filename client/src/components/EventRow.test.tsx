import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DetectionEvent } from '../lib/types'
import { eventTitle } from '../lib/eventLabel'
import { EventRow } from './EventRow'

const baseEvent: DetectionEvent = {
  v: 1,
  type: 'detection',
  id: 'evt-1',
  ts: 1_700_000_000,
  camera_id: 'cam1',
  label: 'person',
  score: 0.9,
  boxes: [],
  person_name: null,
  person_names: null,
}

describe('EventRow', () => {
  it('GIVEN an event WHEN rendered THEN it shows the eventTitle() text', () => {
    // arrange
    const subline = '2 clips tonight'
    // act
    render(<EventRow event={baseEvent} subline={subline} />)
    // assert
    expect(screen.getByText(eventTitle(baseEvent))).toBeInTheDocument()
  })

  it('GIVEN onOpen is provided WHEN rendered THEN it exposes a button with an accessible name', () => {
    // arrange
    const onOpen = vi.fn()
    // act
    render(<EventRow event={baseEvent} subline="2 clips tonight" onOpen={onOpen} />)
    // assert
    expect(
      screen.getByRole('button', { name: new RegExp(eventTitle(baseEvent)) }),
    ).toBeInTheDocument()
  })

  it('GIVEN onOpen is provided WHEN the row is clicked THEN onOpen fires', () => {
    // arrange
    const onOpen = vi.fn()
    render(<EventRow event={baseEvent} subline="2 clips tonight" onOpen={onOpen} />)
    const button = screen.getByRole('button', { name: new RegExp(eventTitle(baseEvent)) })
    // act
    fireEvent.click(button)
    // assert
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('GIVEN an interactive row WHEN rendered THEN it carries the EventCard hover/active parity classes, and the static row stays inert (overhaul W1 item 8, landscape B1)', () => {
    // arrange / act — interactive variant
    const { unmount } = render(
      <EventRow event={baseEvent} subline="2 clips tonight" onOpen={() => {}} />,
    )
    const button = screen.getByRole('button', { name: new RegExp(eventTitle(baseEvent)) })

    // assert — same pointer response as EventList's EventCard so the
    // two "one card language" components behave identically on desktop.
    expect(button.className).toMatch(/hover:border-\[var\(--color-border-strong\)\]/)
    expect(button.className).toMatch(/hover:bg-\[var\(--color-surface-raised\)\]/)
    expect(button.className).toMatch(/focus-visible:outline-2/)
    unmount()

    // arrange / act — non-interactive variant
    const { container } = render(<EventRow event={baseEvent} subline="2 clips tonight" />)

    // assert — a plain div must not advertise hover affordances.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    const row = container.firstElementChild as HTMLElement
    expect(row.className).not.toMatch(/hover:bg-/)
  })

  it('GIVEN an event WHEN rendered THEN the WhoMark is decorative (aria-hidden), not a second announced img', () => {
    // arrange / act
    render(<EventRow event={baseEvent} subline="2 clips tonight" />)
    // assert — no bare role="img" WhoMark inside the row; it's wrapped
    // aria-hidden since the title already carries the identity, so
    // VoiceOver doesn't double-announce "A cat, Cat at the front door".
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const hiddenMark = document.querySelector('span[aria-hidden="true"] svg')
    expect(hiddenMark).not.toBeNull()
  })

  it('Given the video-status leading mode, When rendered, Then it replaces the identity mark with the explicit server lifecycle', () => {
    // arrange / act
    render(
      <EventRow
        event={{
          ...baseEvent,
          clip_url: '/clips/already-there.mp4',
          video_status: 'finalizing',
        }}
        subline="A moment ago"
        leading="video-status"
      />,
    )

    // assert — status comes only from video_status. The clip URL is
    // intentionally present to prove it cannot turn finalizing into
    // a falsely optimistic available icon.
    expect(screen.getByRole('img', { name: 'Finalizing video' })).toHaveAttribute(
      'data-video-status',
      'finalizing',
    )
    expect(screen.getByText('Estimating…')).toBeInTheDocument()
    expect(
      document.querySelector('span[aria-hidden="true"] svg[role="img"]'),
    ).toBeNull()
  })

  it('Given video status is absent, When video-status leading mode renders, Then it honestly says unknown', () => {
    // arrange / act
    render(
      <EventRow
        event={{ ...baseEvent, clip_url: '/clips/not-proof.mp4' }}
        subline="A moment ago"
        leading="video-status"
      />,
    )

    // assert
    expect(screen.getByRole('img', { name: 'Video status unknown' })).toHaveAttribute(
      'data-video-status',
      'unknown',
    )
  })
})
