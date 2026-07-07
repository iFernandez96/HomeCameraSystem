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
})
