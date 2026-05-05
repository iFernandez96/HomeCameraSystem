import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ErrorState } from './ErrorState'

describe('ErrorState', () => {
  it('Given a title, When rendered, Then the title renders as an h2 (iter-356.63 Slice F)', () => {
    // arrange / act
    render(<ErrorState title="Could not load events" />)

    // assert
    const heading = screen.getByRole('heading', { level: 2, name: /could not load events/i })
    expect(heading).toBeInTheDocument()
  })

  it('Given a technicalDetail, When rendered, Then it lives inside a collapsed <details> (iter-356.63)', () => {
    // arrange / act
    render(
      <ErrorState
        title="Could not load people"
        technicalDetail="TypeError: cannot read property 'name' of undefined"
      />,
    )

    // assert — the <details> is closed (no `open` attribute), so the
    // technical text is not visible to a default reader; the summary
    // is.
    const summary = screen.getByText(/technical details/i)
    expect(summary.tagName).toBe('SUMMARY')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
  })

  it('Given a retry callback, When the Retry button is clicked, Then the callback fires (iter-356.63)', () => {
    // arrange
    const retry = vi.fn()
    render(<ErrorState title="Could not load people" retry={retry} />)

    // act
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    // assert
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('Given no retry callback, When rendered, Then no Retry button is shown (iter-356.63)', () => {
    // arrange / act
    render(<ErrorState title="Could not load events" />)

    // assert
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
  })
})
