import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventVideoStatusIcon, type EventVideoStatus } from './EventVideoStatusIcon'

describe('EventVideoStatusIcon', () => {
  it.each(['recording', 'finalizing'] as const)(
    'Given %s has no authoritative deadline, Then it shows an honest estimating label',
    (status) => {
      // arrange / act
      render(<EventVideoStatusIcon status={status} />)

      // assert
      expect(screen.getByText('Estimating…')).toBeInTheDocument()
    },
  )

  it('Given authoritative bounds cross minute buckets, Then it rounds outward to a conservative range', () => {
    // arrange
    const nowMs = 1_700_000_000_000

    // act
    render(
      <EventVideoStatusIcon
        status="recording"
        etaMinTs={nowMs / 1000 + 61}
        etaMaxTs={nowMs / 1000 + 119}
        nowMs={nowMs}
      />,
    )

    // assert — seconds are deliberately not exposed as false precision.
    expect(screen.getByText('~1–2 min')).toBeInTheDocument()
  })

  it('Given the upper bound is under one minute, Then it avoids a false countdown', () => {
    const nowMs = 1_700_000_000_000
    render(
      <EventVideoStatusIcon
        status="finalizing"
        etaMinTs={nowMs / 1000 + 10}
        etaMaxTs={nowMs / 1000 + 45}
        nowMs={nowMs}
      />,
    )
    expect(screen.getByText('<1 min')).toBeInTheDocument()
  })

  it('Given the upper bound has passed while status is still loading, Then it says finishing instead of zero', () => {
    const nowMs = 1_700_000_000_000
    render(
      <EventVideoStatusIcon
        status="finalizing"
        etaMinTs={nowMs / 1000 - 30}
        etaMaxTs={nowMs / 1000 - 1}
        nowMs={nowMs}
      />,
    )
    expect(screen.getByText('Finishing…')).toBeInTheDocument()
  })

  it('Given only one bound is present, Then it falls back instead of inventing a range', () => {
    const nowMs = 1_700_000_000_000
    render(
      <EventVideoStatusIcon
        status="recording"
        etaMinTs={nowMs / 1000 + 60}
        nowMs={nowMs}
      />,
    )
    expect(screen.getByText('Estimating…')).toBeInTheDocument()
  })

  it.each(['available', 'failed', 'unknown'] as EventVideoStatus[])(
    'Given terminal or unknown status %s, Then it does not imply work is progressing',
    (status) => {
      // arrange / act
      render(<EventVideoStatusIcon status={status} />)

      // assert
      expect(screen.queryByText('Estimating…')).not.toBeInTheDocument()
    },
  )

  it('Given the server marks a stale event failed, Then no loading treatment survives', () => {
    // arrange / act
    const { container } = render(
      <EventVideoStatusIcon
        status="failed"
        etaMinTs={1_700_000_060}
        etaMaxTs={1_700_000_120}
        nowMs={1_700_000_000_000}
      />,
    )

    // assert — the component trusts the terminal server state. It
    // never uses event age or an old clip URL to keep a spinner alive.
    expect(screen.getByRole('img', { name: 'Video unavailable' })).toHaveAttribute(
      'data-video-status',
      'failed',
    )
    expect(screen.queryByText('Estimating…')).not.toBeInTheDocument()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('Given axis placement is loading, Then the ETA stays left of the event card boundary', () => {
    // arrange / act
    const { container } = render(
      <EventVideoStatusIcon status="recording" placement="axis" />,
    )

    // assert — right-alignment makes the label end at the 24px axis
    // slot instead of spilling right into the event card.
    const eta = screen.getByText('Estimating…')
    expect(eta.className).toMatch(/\bright-0\b/)
    expect(container.firstElementChild?.className).toMatch(/left-\[3\.45rem\]/)
  })
})
