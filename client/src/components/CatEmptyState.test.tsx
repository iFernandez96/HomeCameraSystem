import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CatEmptyState } from './CatEmptyState'

describe('CatEmptyState', () => {
  it('given heading + body, when rendered, then heading is text-lg primary and body is text-sm secondary (iter-356.23)', () => {
    // arrange / act
    render(<CatEmptyState heading="All quiet out there" body="Nothing's stirring." />)

    // assert
    const heading = screen.getByText('All quiet out there')
    expect(heading).toBeInTheDocument()
    expect(heading.className).toMatch(/text-lg/)
    expect(heading.className).toMatch(/font-semibold/)

    const body = screen.getByText("Nothing's stirring.")
    expect(body).toBeInTheDocument()
    expect(body.className).toMatch(/text-sm/)
  })

  it('given a hint, when rendered, then hint renders at text-sm (Frank #3 — was text-xs and unreadable)', () => {
    // arrange / act
    render(
      <CatEmptyState
        heading="No timelapses yet"
        body="Pick a date above and tap Build video."
        hint="The camera turns a whole day into a short video."
      />,
    )

    // assert — Frank's iter-356.22 brutal note: hint text was text-xs
    // (~11px effective) which is hostile to anyone with normal aging
    // vision. Bumped to text-sm here.
    const hint = screen.getByText('The camera turns a whole day into a short video.')
    expect(hint.className).toMatch(/text-sm/)
    expect(hint.className).not.toMatch(/text-xs/)
  })

  it('when no illustration override is passed, then the default sleeping cat (with z-z-z) renders (iter-356.23)', () => {
    // arrange / act
    render(<CatEmptyState heading="All quiet" body="Nothing's stirring." />)

    // assert — Frank's iter-356.22 #1 fix: the default illustration is
    // SleepingCatIllustration (has z's), not CalicoSprite (ambiguous
    // pixel blob). Verify by checking for the role=img element which
    // SleepingCatIllustration uses with its ariaLabel.
    expect(
      screen.getByRole('img', { name: /sleeping cat/i }),
    ).toBeInTheDocument()
  })

  it('Given an empty state, When its illustration renders, Then idle life is CSS-only and reduced-motion gated', () => {
    // arrange / act
    render(<CatEmptyState heading="All quiet" body="Nothing's stirring." hint="Check back soon." />)

    // assert
    const illustration = screen.getByTestId('cat-empty-state-illustration')
    expect(illustration.className).toMatch(/cat-empty-state-idle/)
    expect(illustration.className).toMatch(/motion-reduce:animate-none/)
    expect(screen.getByRole('img', { name: /sleeping cat/i })).toBeInTheDocument()
    expect(screen.getByText('Check back soon.')).toBeInTheDocument()
  })

  it('given a custom illustration, when rendered, then the override replaces the default sleeping cat', () => {
    // arrange
    const customIllustration = <span data-testid="custom-illo">paw</span>

    // act
    render(
      <CatEmptyState
        heading="No people"
        body="Enroll a face to get started."
        illustration={customIllustration}
      />,
    )

    // assert
    expect(screen.getByTestId('custom-illo')).toBeInTheDocument()
    expect(
      screen.queryByRole('img', { name: /sleeping cat/i }),
    ).not.toBeInTheDocument()
  })

  it('given an aria-label override, when rendered, then the wrapper carries that label not the heading (iter-356.23)', () => {
    // arrange / act
    render(
      <CatEmptyState
        heading="All quiet out there"
        body="Camera's at rest."
        ariaLabel="All quiet — no events yet"
      />,
    )

    // assert — Events page wants a richer mood phrase for SR users
    // than just the visual heading; the aria-label override carries it.
    expect(screen.getByRole('status', { name: 'All quiet — no events yet' })).toBeInTheDocument()
  })

  it('given an action, when the CTA is clicked, then it renders through the Button primitive and fires onClick (Sunroom redesign)', () => {
    // arrange — Sunroom copy tiering: heading / body / CTA-via-Button.
    const onClick = vi.fn()
    render(
      <CatEmptyState
        heading="No people yet"
        body="Teach the camera a face."
        action={{ label: 'Add a person', onClick }}
      />,
    )

    // act
    const cta = screen.getByRole('button', { name: 'Add a person' })
    fireEvent.click(cta)

    // assert — fires, and carries the Button primitive's secondary
    // paper treatment (not an ad-hoc anchor-styled span).
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(cta.className).toMatch(/bg-\[var\(--color-surface\)\]/)
    expect(cta.className).toMatch(/min-h-\[44px\]/)
  })

  it('when no action is passed, then no CTA button renders', () => {
    // arrange / act
    render(<CatEmptyState heading="All quiet" body="Nothing's stirring." />)

    // assert
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('when no aria-label override is passed, then the wrapper falls back to the heading', () => {
    // arrange / act
    render(<CatEmptyState heading="No timelapses yet" body="Build one." />)

    // assert
    expect(screen.getByRole('status', { name: 'No timelapses yet' })).toBeInTheDocument()
  })

  // UI/UX overhaul 2026-07-07 (device run-through #9/#10): in short
  // landscape viewports the full-size mascot pushed the headline to
  // the bottom edge and the CTA below the fold (Faces), and clipped
  // under the sticky ribbon (Review).
  it('given a short landscape viewport, when rendered, then the figure and vertical rhythm carry landscape-phone compaction classes (overhaul 2026-07-07)', () => {
    // arrange / act
    render(
      <CatEmptyState
        heading="All quiet"
        body="Nothing yet."
        action={{ label: 'Add one', onClick: vi.fn() }}
      />,
    )
    // The Button primitive mounts its own sr-only role="status" live
    // region — scope by accessible name to the empty-state wrapper.
    const wrapper = screen.getByRole('status', { name: 'All quiet' })

    // assert — tighter padding + gaps, height-capped figure, and a
    // scale-down applied to the illustration inside it.
    expect(wrapper.className).toMatch(/landscape-phone:py-3/)
    expect(wrapper.className).toMatch(/landscape-phone:space-y-2/)
    const figure = wrapper.firstElementChild
    expect(figure?.className).toMatch(/landscape-phone:h-14/)
    expect(figure?.className).toMatch(/scale-\[0\.55\]/)
  })
})
