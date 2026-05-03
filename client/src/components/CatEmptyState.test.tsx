import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('when no aria-label override is passed, then the wrapper falls back to the heading', () => {
    // arrange / act
    render(<CatEmptyState heading="No timelapses yet" body="Build one." />)

    // assert
    expect(screen.getByRole('status', { name: 'No timelapses yet' })).toBeInTheDocument()
  })
})
