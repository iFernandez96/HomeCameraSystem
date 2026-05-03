import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Boom({ message = 'kaboom' }: { message?: string }): ReactNode {
  throw new Error(message)
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React logs the caught error to console.error; suppress it to keep
    // the test output clean.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>hello</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('renders the fallback when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="kaboom" />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
    expect(screen.getByText('kaboom')).toBeInTheDocument()
  })

  it('includes the label in the fallback heading', () => {
    render(
      <ErrorBoundary label="Events">
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/in events/i)
  })

  it('exposes a Try again button that resets', () => {
    let shouldThrow = true
    function MaybeBoom() {
      if (shouldThrow) throw new Error('first render')
      return <p>recovered</p>
    }
    render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
  })

  it('exposes a Reload app button that calls location.reload', () => {
    const reloadSpy = vi.fn()
    const orig = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...orig, reload: reloadSpy },
    })
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole('button', { name: /reload app/i }))
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: orig,
      })
    }
  })

  it('logs the caught error to console.error for dev visibility', () => {
    render(
      <ErrorBoundary>
        <Boom message="trace-me" />
      </ErrorBoundary>,
    )
    // React itself logs the error too; we just want to confirm our
    // componentDidCatch-side log fired with the expected prefix.
    const matchingCall = errorSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].startsWith('ErrorBoundary caught'),
    )
    expect(matchingCall).toBeTruthy()
  })
})
