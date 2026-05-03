import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider, useToast } from './toast'

function Trigger({ msg, kind }: { msg: string; kind?: 'info' | 'success' | 'error' }) {
  const { showToast } = useToast()
  return (
    <button onClick={() => showToast(msg, kind)} type="button">
      fire
    </button>
  )
}

describe('toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    // Drain any remaining toast timeouts before switching back to real
    // timers so we don't leak across tests.
    act(() => {
      vi.runOnlyPendingTimers()
    })
    vi.useRealTimers()
  })

  it('renders nothing initially', () => {
    render(
      <ToastProvider>
        <Trigger msg="hi" />
      </ToastProvider>,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders an info toast as role=status', () => {
    render(
      <ToastProvider>
        <Trigger msg="hello" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('status')).toHaveTextContent('hello')
  })

  it('renders an error toast as role=alert', () => {
    render(
      <ToastProvider>
        <Trigger msg="bad" kind="error" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('alert')).toHaveTextContent('bad')
  })

  it('auto-dismisses info toasts after 3.5 s (iter-356.3a Maya: bumped from 2.5s for non-technical readability)', () => {
    render(
      <ToastProvider>
        <Trigger msg="hi" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getByRole('status')).toHaveTextContent('hi')
    act(() => {
      vi.advanceTimersByTime(3600)
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('error toasts persist longer (5 s)', () => {
    render(
      <ToastProvider>
        <Trigger msg="bad" kind="error" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fire'))
    act(() => {
      vi.advanceTimersByTime(2600)
    })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2600)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('stacks multiple toasts', () => {
    function Multi() {
      const { showToast } = useToast()
      return (
        <button
          onClick={() => {
            showToast('first')
            showToast('second')
            showToast('third')
          }}
        >
          fire
        </button>
      )
    }
    render(
      <ToastProvider>
        <Multi />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByText('fire'))
    expect(screen.getAllByRole('status')).toHaveLength(3)
  })
})
