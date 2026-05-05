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
})
