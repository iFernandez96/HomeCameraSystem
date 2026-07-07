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
    // componentDidCatch-side log fired. ErrorBoundary now routes through
    // the structured logger (log.error), which emits
    // console.error('[errorBoundary:caught]', fields).
    const matchingCall = errorSpy.mock.calls.find(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('errorBoundary:caught'),
    )
    expect(matchingCall).toBeTruthy()
  })

  // ─── Premium-launch slice — harmonization invariants ─────────────

  it('Given the boundary fallback renders, When the DOM is inspected, Then NO raw red-XXX Tailwind classes are present (Mira #1 / Dana #1 — must use design-system tokens)', () => {
    // arrange — pre-fix the boundary used `bg-red-500/10`,
    // `border-red-500/30`, `text-red-400` — all violations of
    // CLAUDE.md's "no raw red-XXX outside semantic tokens" rule
    // AND `text-red-400` measured ~2.6:1 on the calico-cream
    // theme (Dana flagged as WCAG 1.4.3 contrast fail).
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    // act / assert — sweep the rendered tree for the forbidden
    // class fragments.
    const html = container.innerHTML
    expect(html).not.toMatch(/\bred-(?:300|400|500|600)\b/)
    expect(html).not.toMatch(/\bbg-red-\d+\/\d+\b/)
    expect(html).not.toMatch(/\bborder-red-\d+\/\d+\b/)
  })

  it('Given a Boom child throws "kaboom", When the boundary renders the fallback, Then "kaboom" lives inside the Technical-details <details> disclosure (NOT slammed onto the user as a top-level paragraph — Mira #2 / matches the ErrorState contract)', () => {
    // arrange / act
    const { container } = render(
      <ErrorBoundary>
        <Boom message="kaboom-disclosure-pin" />
      </ErrorBoundary>,
    )

    // assert — the error message text is queryable (jsdom renders
    // <details> contents regardless of the open attr) but lives
    // inside a <details>.
    const errorText = screen.getByText(/kaboom-disclosure-pin/)
    const details = errorText.closest('details')
    expect(details).not.toBeNull()
    // The disclosure is closed by default — Frank doesn't see the
    // raw exception on first paint.
    expect(details).not.toHaveAttribute('open')
    // The summary is the visible label.
    const summary = container.querySelector('details > summary')
    expect(summary?.textContent).toMatch(/technical details/i)
  })

  it('Given the fallback renders, When the action buttons are queried, Then they carry the Button-primitive base classes (min-h-[44px] tap target, focus-visible:outline-2, primitive bg tokens — proves we routed through <Button>, not hand-rolled <button>)', () => {
    // arrange / act — primitive's BASE_CLASSES include the
    // `focus-visible:outline-2` family and `font-bold`; size="md"
    // forces `min-h-[44px]`. Hand-rolled buttons in the pre-fix
    // boundary used `py-2` (~32 px), `font-medium`, and a custom
    // focus-ring style — none of which matched the primitive
    // contract. (Fix-round: pill-grammar Button migrated the base
    // weight from `font-semibold` to `font-bold`; this pin follows
    // the primitive, not a hardcoded weight.)
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    // assert — both buttons share the primitive shape.
    for (const name of [/try again/i, /reload app/i]) {
      const btn = screen.getByRole('button', { name })
      // Primitive base contract.
      expect(btn.className).toContain('font-bold')
      expect(btn.className).toMatch(/focus-visible:outline-2/)
      expect(btn.className).toContain('min-h-[44px]')
    }
  })

  it('Given the fallback renders, When the alert region is queried, Then the warning glyph + h2 title + technical disclosure all live inside one role="alert" container (Mira: harmonized vocabulary with inline ErrorState)', () => {
    // arrange / act
    render(
      <ErrorBoundary>
        <Boom message="alert-region-pin" />
      </ErrorBoundary>,
    )

    // assert — single role="alert", h2 heading (NOT a plain <p>),
    // technical details disclosure all nested inside it.
    const alert = screen.getByRole('alert')
    const heading = screen.getByRole('heading', { level: 2 })
    expect(alert).toContainElement(heading)
    expect(heading).toHaveTextContent(/something went wrong/i)
    const details = alert.querySelector('details')
    expect(details).not.toBeNull()
  })
})
