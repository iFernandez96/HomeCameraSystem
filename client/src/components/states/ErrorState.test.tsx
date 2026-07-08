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

  // ─── Premium-launch slice — ErrorBoundary harmonization ─────────

  it('Given a retryLabel override, When rendered, Then the primary button uses that label instead of "Retry" (so ErrorBoundary can ship "Reload app" through the same primitive)', () => {
    // arrange
    const retry = vi.fn()
    render(
      <ErrorState
        title="Something went wrong"
        retry={retry}
        retryLabel="Reload app"
      />,
    )

    // assert — custom label rendered, default "Retry" is NOT.
    expect(
      screen.getByRole('button', { name: /reload app/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^retry$/i }),
    ).not.toBeInTheDocument()
  })

  it('Given a secondaryAction, When rendered, Then both buttons appear with the secondary on the LEFT and the primary on the RIGHT (project convention: primary action on the right)', () => {
    // arrange
    const reset = vi.fn()
    const reload = vi.fn()
    render(
      <ErrorState
        title="Something went wrong"
        retry={reload}
        retryLabel="Reload app"
        secondaryAction={{ label: 'Try again', onClick: reset }}
      />,
    )

    // act / assert — both buttons are queryable by accessible name.
    const tryBtn = screen.getByRole('button', { name: /try again/i })
    const reloadBtn = screen.getByRole('button', { name: /reload app/i })
    expect(tryBtn).toBeInTheDocument()
    expect(reloadBtn).toBeInTheDocument()

    // Visual order: secondary first (DOM-order = left in LTR flex
    // row), primary second.
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]).toBe(tryBtn)
    expect(buttons[1]).toBe(reloadBtn)
  })

  it('Given a secondaryAction, When the secondary button is clicked, Then only its handler fires (primary handler is NOT triggered)', () => {
    // arrange
    const reset = vi.fn()
    const reload = vi.fn()
    render(
      <ErrorState
        title="Something went wrong"
        retry={reload}
        retryLabel="Reload app"
        secondaryAction={{ label: 'Try again', onClick: reset }}
      />,
    )

    // act
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    // assert
    expect(reset).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('Given the warning glyph circle, When rendered, Then it uses the --color-warning-bg token (no rgba fallback — the token is defined in src/index.css)', () => {
    // arrange — Mira #8: the rgba fallback inside the background var() utility
    // expression was dead code that would silently disable theming
    // if the token were ever renamed. The assertion pins that we
    // committed to the token.
    const { container } = render(<ErrorState title="x" />)

    // act
    const circle = container.querySelector('.rounded-full')

    // assert
    expect(circle).not.toBeNull()
    expect(circle!.className).toContain('bg-[var(--color-warning-bg)]')
    expect(circle!.className).not.toContain('rgba(')
  })
})
