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

  it('Given a long info toast (~120 chars), When rendered, Then it persists past the 3.5 s floor proportional to message length (premium-launch slice — Frank D2)', () => {
    // arrange — Frank D2: the longest toast in the app is the
    // notification-setup info ("No devices are set up to receive
    // alerts yet — flip the toggle on each phone you want to
    // notify, then try again") at ~120 characters. The previous
    // 3.5 s timeout vanished it before a typical reading pace
    // (200 wpm) could finish. Now: per-character floor at 60 ms,
    // capped at 9 s.
    const long =
      'No devices are set up to receive alerts yet — flip the toggle on each phone you want to notify, then try again'

    render(
      <ToastProvider>
        <Trigger msg={long} />
      </ToastProvider>,
    )

    // act
    fireEvent.click(screen.getByText('fire'))

    // assert — toast is present at the old 3.5 s floor (would have
    // unmounted under the pre-slice constant timeout).
    expect(screen.getByRole('status')).toHaveTextContent(long.slice(0, 24))
    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()

    // assert — caps at 9 s (long.length * 60 = 6720 ms, but with
    // some slack the absolute cap holds even on monster strings).
    act(() => {
      vi.advanceTimersByTime(6_000) // total 10 s
    })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('Given a short message and the per-char floor would compute below the kind floor, When rendered, Then the kind floor still applies', () => {
    // arrange — verify the Math.max preserves the per-kind floor
    // for short messages (most common case).
    render(
      <ToastProvider>
        <Trigger msg="hi" />
      </ToastProvider>,
    )

    // act
    fireEvent.click(screen.getByText('fire'))

    // assert — at 3 s (under the 3.5 s floor) the toast is still up.
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByRole('status')).toBeInTheDocument()
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
