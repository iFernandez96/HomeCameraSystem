import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventList } from './EventList'
import type { DetectionEvent } from '../lib/types'

function evt(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: 'evt-' + Math.random().toString(36).slice(2),
    ts: 1700000000,
    camera_id: 'cam1',
    label: 'person',
    score: 0.85,
    boxes: [],
    ...over,
  }
}

describe('EventList thumbnails', () => {
  it('given events with and without thumb_url, when rendered, then thumb rows use the exact URL and rows without render the declared placeholder', () => {
    // arrange
    const thumbUrl = '/snapshots/thumb_1700000000.jpg'

    // act
    render(
      <EventList
        events={[
          evt({ id: 'with-thumb', label: 'person', camera_id: 'cam1', thumb_url: thumbUrl }),
          evt({ id: 'without-thumb', label: 'car', camera_id: 'cam2', thumb_url: null }),
        ]}
      />,
    )

    // assert
    expect(screen.getByRole('img', { name: /person at the front door/i })).toHaveAttribute(
      'src',
      thumbUrl,
    )
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(screen.getByText(/car at cam2/i)).toBeInTheDocument()
    const placeholder = document.querySelector(
      'svg[width="32"][height="32"][viewBox="0 0 24 24"]',
    )
    expect(placeholder).toBeInTheDocument()
    expect(placeholder?.querySelector('rect[x="3"][y="3"]')).toBeInTheDocument()
    expect(placeholder?.querySelector('circle[cx="8.5"][cy="8.5"]')).toBeInTheDocument()
    expect(placeholder?.querySelector('polyline[points="21 15 16 10 5 21"]')).toBeInTheDocument()
  })
})
