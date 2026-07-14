import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventVideoStatusIcon, type EventVideoStatus } from './EventVideoStatusIcon'

describe('EventVideoStatusIcon', () => {
  it('Given recording is still open, Then ETA is visibly paused for the person in scene', () => {
    const { container } = render(<EventVideoStatusIcon status="recording" />)

    expect(screen.getByText('Person in scene')).toHaveAttribute(
      'title',
      'ETA is paused; leaving and returning continues the same capture',
    )
    expect(screen.getByRole('img')).toHaveAccessibleName(/ETA paused/i)
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('Given the person leaves during the grace window, Then it counts toward clear and warns that re-entry resets it', () => {
    const nowMs = 1_700_000_000_000
    const { rerender } = render(
      <EventVideoStatusIcon
        status="recording"
        activityPresent={false}
        finalizeIfClearTs={nowMs / 1000 + 24.2}
        nowMs={nowMs}
      />,
    )

    expect(screen.getByText('Clear · 25s')).toHaveAttribute(
      'title',
      'Scene is temporarily clear; this countdown resets if the person returns',
    )
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /finalizing in 25 seconds unless the person returns/i,
    )

    rerender(
      <EventVideoStatusIcon
        status="recording"
        activityPresent
        finalizeIfClearTs={nowMs / 1000 + 24.2}
        nowMs={nowMs}
      />,
    )
    expect(screen.getByText('Person in scene')).toBeInTheDocument()
    expect(screen.queryByText(/Clear ·/)).not.toBeInTheDocument()
  })

  it('Given detection is paused during a recording, Then it shows a compact closing state without a perpetual spinner', () => {
    const { container } = render(
      <EventVideoStatusIcon
        status="recording"
        activityPresent={false}
        detectionPaused
      />,
    )

    expect(screen.getByText('Closing…')).toHaveAttribute(
      'title',
      'Detection is paused; the worker is closing this video at the last observed frame',
    )
    expect(screen.getByRole('img')).toHaveAccessibleName(
      /detection paused.*closing video/i,
    )
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByText(/confirming clear/i)).not.toBeInTheDocument()
  })

  it('Given the worker is offline during a recording, Then it says offline and never pretends processing is moving', () => {
    const { container } = render(
      <EventVideoStatusIcon status="recording" workerOffline />,
    )

    expect(screen.getByText('Offline')).toHaveAttribute(
      'title',
      'The worker is offline, so this video is not progressing',
    )
    expect(screen.getByRole('img')).toHaveAccessibleName(/worker offline/i)
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('Given a recording has no authoritative clear deadline, Then the fallback copy stays compact', () => {
    render(
      <EventVideoStatusIcon status="recording" activityPresent={false} />,
    )

    expect(screen.getByText('Clearing…')).toBeInTheDocument()
    expect(screen.queryByText(/confirming clear/i)).not.toBeInTheDocument()
  })

  it('Given finalizing has no authoritative deadline, Then it shows an honest estimating label', () => {
    render(<EventVideoStatusIcon status="finalizing" />)
    expect(screen.getByText('Estimating…')).toBeInTheDocument()
  })

  it('Given authoritative bounds cross minute buckets, Then it rounds outward to a conservative range', () => {
    // arrange
    const nowMs = 1_700_000_000_000

    // act
    render(
      <EventVideoStatusIcon
        status="finalizing"
        etaMinTs={nowMs / 1000 + 61}
        etaMaxTs={nowMs / 1000 + 119}
        nowMs={nowMs}
      />,
    )

    // assert — seconds are deliberately not exposed as false precision.
    expect(screen.getByText('~1–2 min')).toBeInTheDocument()
  })

  it('Given a device-calibrated point estimate, Then it shows a precise ETA and its evidence', () => {
    const nowMs = 1_700_000_000_000
    render(
      <EventVideoStatusIcon
        status="finalizing"
        etaPointTs={nowMs / 1000 + 82}
        etaMinTs={nowMs / 1000 + 60}
        etaMaxTs={nowMs / 1000 + 120}
        etaModelSamples={156}
        etaBacktestMedianErrorS={7.4}
        nowMs={nowMs}
      />,
    )

    expect(screen.getByText('~1m 15s')).toHaveAttribute(
      'title',
      'Calibrated from 156 completed videos; walk-forward median error about 7 seconds',
    )
  })

  it('Given live FFmpeg progress, Then it uses the measured countdown without requiring history', () => {
    const nowMs = 1_700_000_000_000
    render(
      <EventVideoStatusIcon
        status="finalizing"
        etaPointTs={nowMs / 1000 + 42}
        etaMinTs={nowMs / 1000 + 35}
        etaMaxTs={nowMs / 1000 + 55}
        etaModelSamples={0}
        etaLiveProgress
        nowMs={nowMs}
      />,
    )

    expect(screen.getByText('~45s')).toHaveAttribute(
      'title',
      'Calculated from live video-validation progress and measured speed',
    )
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
        status="finalizing"
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
      <EventVideoStatusIcon status="finalizing" placement="axis" />,
    )

    // assert — right-alignment makes the label end at the 24px axis
    // slot instead of spilling right into the event card.
    const eta = screen.getByText('Estimating…')
    expect(eta.className).toMatch(/\bright-0\b/)
    expect(container.firstElementChild?.className).toMatch(/left-\[3\.45rem\]/)
  })
})
