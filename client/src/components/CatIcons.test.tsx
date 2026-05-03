import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  BombayCatIcon,
  CalicoCatIcon,
  CatTrioMark,
  SleepingCatIllustration,
  TuxedoCatIcon,
} from './CatIcons'

describe('CatIcons', () => {
  it('given an ariaLabel prop, when BombayCatIcon renders, then it exposes role=img with that label', () => {
    // arrange
    const label = 'bombay'

    // act
    render(<BombayCatIcon ariaLabel={label} />)

    // assert
    expect(screen.getByRole('img', { name: /bombay/i })).toBeInTheDocument()
  })

  it('given an ariaLabel prop, when TuxedoCatIcon renders, then it exposes role=img with that label', () => {
    // arrange
    const label = 'tuxedo'

    // act
    render(<TuxedoCatIcon ariaLabel={label} />)

    // assert
    expect(screen.getByRole('img', { name: /tuxedo/i })).toBeInTheDocument()
  })

  it('given an ariaLabel prop, when CalicoCatIcon renders, then it exposes role=img with that label', () => {
    // arrange
    const label = 'calico'

    // act
    render(<CalicoCatIcon ariaLabel={label} />)

    // assert
    expect(screen.getByRole('img', { name: /calico/i })).toBeInTheDocument()
  })

  it('when CatTrioMark renders with default props, then aria-label pins the canonical wordmark string + <title> announces cat names (iter-356.6 Frank #1)', () => {
    // arrange + act
    const { container } = render(<CatTrioMark />)

    // assert — pin the EXACT default label, not just .toBeTruthy()
    // (test-integrity-auditor flagged the prior vacuous form).
    const img = screen.getByRole('img')
    expect(img.getAttribute('aria-label')).toBe(
      'Three cats — the household watch crew',
    )
    // iter-356.6 Frank #1: <title> is the browser-tooltip + SR-secondary
    // hook so users discover the cat names without reading source code.
    const title = container.querySelector('title')
    expect(title?.textContent).toBe('Panther, Mushu, and Coco')
  })

  it('given a custom ariaLabel, when CatTrioMark renders, then the SVG carries that label', () => {
    // arrange
    const label = 'three cats'

    // act
    render(<CatTrioMark ariaLabel={label} />)

    // assert
    expect(screen.getByRole('img', { name: /three cats/i })).toBeInTheDocument()
  })

  it('when SleepingCatIllustration renders with default props, then aria-label pins the canonical empty-state copy', () => {
    // arrange + act
    render(<SleepingCatIllustration />)

    // assert — pin the EXACT default label (test-integrity).
    const img = screen.getByRole('img')
    expect(img.getAttribute('aria-label')).toBe(
      'A sleeping cat — nothing happening here yet',
    )
  })

  it('given a custom ariaLabel, when SleepingCatIllustration renders, then the SVG carries that label', () => {
    // arrange
    const label = 'snoozing kitty'

    // act
    render(<SleepingCatIllustration ariaLabel={label} />)

    // assert
    expect(screen.getByRole('img', { name: /snoozing kitty/i })).toBeInTheDocument()
  })
})
