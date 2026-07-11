import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DetectionEvent } from '../lib/types'
import { HourBand } from './HourBand'

const day = new Date(2026, 6, 7).getTime() / 1000
const ev = (
  hour: number,
  minute: number,
  label: string,
  over: Partial<DetectionEvent> = {},
): DetectionEvent => ({
  v: 1,
  type: 'detection',
  id: `${hour}-${minute}-${label}`,
  ts: day + hour * 3600 + minute * 60,
  camera_id: 'cam1',
  label,
  score: 0.9,
  boxes: [],
  person_name: null,
  ...over,
})

describe('HourBand activity ruler', () => {
  it('positions events at their exact minute on one 24-hour ruler', () => {
    render(
      <HourBand
        events={[ev(6, 0, 'cat'), ev(18, 0, 'person')]}
        dayStartTs={day}
        nowTs={day + 12 * 3600}
      />,
    )

    const markers = screen.getAllByTestId('timeline-marker')
    expect(markers).toHaveLength(2)
    expect(markers[0]).toHaveStyle({ left: '25%' })
    expect(markers[1]).toHaveStyle({ left: '75%' })
  })

  it('shows a clean labeled time axis instead of requiring users to count 24 blocks', () => {
    render(<HourBand events={[]} dayStartTs={day} nowTs={day + 14 * 3600} />)

    const ruler = screen.getByTestId('day-activity-ruler')
    expect(within(ruler).getAllByText('12 AM')).toHaveLength(2)
    expect(within(ruler).getByText('6 AM')).toBeInTheDocument()
    expect(within(ruler).getByText('Noon')).toBeInTheDocument()
    expect(within(ruler).getByText('6 PM')).toBeInTheDocument()
    expect(screen.getByText('0 sightings')).toBeInTheDocument()
  })

  it('renders the current-time cursor at the correct position', () => {
    render(<HourBand events={[]} dayStartTs={day} nowTs={day + 9 * 3600} />)
    expect(screen.getByTestId('now-cursor')).toHaveStyle({ left: '37.5%' })
  })

  it('uses observed start and end timestamps to render a proportional session bar', () => {
    render(
      <HourBand
        events={[ev(8, 0, 'person', { start_ts: day + 8 * 3600, end_ts: day + 10 * 3600 })]}
        dayStartTs={day}
        nowTs={day + 12 * 3600}
      />,
    )

    const fill = screen.getByTestId('timeline-marker-fill')
    expect(fill).toHaveStyle({ left: '33.33333333333333%' })
    expect(fill.getAttribute('style')).toContain('width: 8.333')
  })

  it('uses a point marker when no authoritative duration is available', () => {
    render(<HourBand events={[ev(8, 30, 'cat')]} dayStartTs={day} nowTs={day + 12 * 3600} />)
    expect(screen.getByTestId('timeline-marker-fill')).toHaveStyle({ width: '4px' })
  })

  it('opens a single event directly from its marker', () => {
    const event = ev(13, 44, 'person', { video_status: 'available' })
    const onSelectEvent = vi.fn()
    render(
      <HourBand
        events={[event]}
        dayStartTs={day}
        nowTs={day + 15 * 3600}
        onSelectEvent={onSelectEvent}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /1:44 PM.*video available/i }))
    expect(onSelectEvent).toHaveBeenCalledWith(event)
  })

  it('clusters dense nearby events and lets the user choose the exact one', () => {
    const first = ev(13, 40, 'person')
    const second = ev(13, 46, 'cat')
    const onSelectEvent = vi.fn()
    render(
      <HourBand
        events={[first, second]}
        dayStartTs={day}
        nowTs={day + 15 * 3600}
        onSelectEvent={onSelectEvent}
      />,
    )

    const cluster = screen.getByRole('button', { name: /2 events from 1:40 PM–1:46 PM/i })
    expect(cluster).toBeEmptyDOMElement()
    fireEvent.click(cluster)

    const detail = screen.getByRole('region', { name: /2 events from 1:40 PM–1:46 PM/i })
    fireEvent.click(within(detail).getByRole('button', { name: /1:46 PM.*cat/i }))
    expect(onSelectEvent).toHaveBeenCalledWith(second)
  })

  it('gives the ruler a concise accessible summary without claiming empty time was healthy', () => {
    render(<HourBand events={[ev(8, 0, 'cat')]} dayStartTs={day} nowTs={day + 12 * 3600} />)
    expect(
      screen.getByRole('group', { name: /1 recorded event in 1 period/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('1 sighting')).toBeInTheDocument()
    expect(screen.getByText('Latest 8:00 AM')).toBeInTheDocument()
    expect(screen.getByText('Cats 1')).toBeInTheDocument()
    expect(screen.getByText('Tap a mark for exact time')).toBeInTheDocument()
    expect(screen.queryByText(/quiet/i)).not.toBeInTheDocument()
  })

  it('summarizes identity counts at a glance', () => {
    render(
      <HourBand
        events={[ev(8, 0, 'person'), ev(9, 0, 'person'), ev(10, 0, 'cat'), ev(11, 0, 'motion')]}
        dayStartTs={day}
        nowTs={day + 12 * 3600}
      />,
    )

    expect(screen.getByText('4 sightings')).toBeInTheDocument()
    expect(screen.getByText('People 2')).toBeInTheDocument()
    expect(screen.getByText('Cats 1')).toBeInTheDocument()
    expect(screen.getByText('Other 1')).toBeInTheDocument()
    expect(screen.getByText('Latest 11:00 AM')).toBeInTheDocument()
  })

  it('keeps out-of-day events off the ruler', () => {
    render(
      <HourBand
        events={[ev(8, 0, 'cat'), { ...ev(9, 0, 'person'), ts: day - 60 }]}
        dayStartTs={day}
        nowTs={day + 12 * 3600}
      />,
    )
    expect(screen.getAllByTestId('timeline-marker')).toHaveLength(1)
  })
})
