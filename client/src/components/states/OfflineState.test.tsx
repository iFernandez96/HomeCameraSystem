import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { OfflineState } from './OfflineState'

describe('OfflineState', () => {
  it('Given kind="camera", When rendered, Then it shows "Camera offline" copy and the cable-check suggestion (iter-356.63 Slice F)', () => {
    // arrange / act
    render(<OfflineState kind="camera" />)

    // assert
    expect(screen.getByText('Camera offline')).toBeInTheDocument()
    expect(
      screen.getByText(/powered on and connected/i),
    ).toBeInTheDocument()
  })

  it('Given kind="network", When rendered, Then it does not mention the camera (iter-356.63)', () => {
    // arrange / act
    render(<OfflineState kind="network" />)

    // assert
    expect(screen.getByText('Network offline')).toBeInTheDocument()
    expect(screen.queryByText(/powered on/i)).not.toBeInTheDocument()
  })

  it('Given a retry callback, When the Retry button is clicked, Then the callback fires (iter-356.63)', () => {
    // arrange
    const retry = vi.fn()
    render(<OfflineState kind="camera" retry={retry} />)

    // act
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    // assert
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('Given no retry callback, When rendered, Then no Retry button is shown (iter-356.63)', () => {
    // arrange / act
    render(<OfflineState kind="network" />)

    // assert
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })

  it('Given size="compact", When rendered inside a 16:9 video tile, Then the heading uses a tighter actionable hint instead of the multi-line full-page body (premium-launch slice — Maya Critical #4)', () => {
    // arrange / act — Maya Critical #4: pre-fix VideoTile rendered
    // the full-size variant inside its 16:9 tile and the danger
    // circle + multi-line copy + Retry overflowed on landscape
    // phones. Compact variant uses a smaller icon pill, single-line
    // body, and small Retry button so the entire treatment fits in
    // a short tile.
    render(<OfflineState kind="camera" size="compact" />)

    // assert — heading still present.
    expect(screen.getByText('Camera offline')).toBeInTheDocument()
    // Full-page multi-line copy is GONE in compact mode.
    expect(
      screen.queryByText(/powered on and connected/i),
    ).not.toBeInTheDocument()
    // Tight actionable hint is present instead.
    expect(screen.getByText(/power-cycle the camera/i)).toBeInTheDocument()
  })

  it('Given size="compact" + retry callback, When the Retry button is rendered, Then it is sized "sm" so it fits inside the video tile without overflow (premium-launch slice — Maya Critical #4)', () => {
    // arrange / act
    const retry = vi.fn()
    render(<OfflineState kind="camera" size="compact" retry={retry} />)

    // assert — Retry is present and uses the small size variant
    // (Button primitive's sm class includes min-h-[32px]).
    const btn = screen.getByRole('button', { name: /retry/i })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toMatch(/min-h-\[32px\]/)
  })
})
