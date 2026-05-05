import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LoadingState } from './LoadingState'

describe('LoadingState', () => {
  it('Given shape="list", When rendered, Then a list-shaped skeleton with row outlines is present (iter-356.63 Slice F)', () => {
    // arrange / act
    const { container } = render(<LoadingState shape="list" />)

    // assert
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
    // EventListSkeleton renders <li> rows.
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0)
  })

  it('Given shape="grid", When rendered, Then a grid of square placeholders is present (iter-356.63)', () => {
    // arrange / act
    const { container } = render(<LoadingState shape="grid" />)

    // assert
    const grid = container.querySelector('[aria-label="Loading"]')
    expect(grid).not.toBeNull()
    expect(grid?.className).toMatch(/grid/)
    expect(container.querySelectorAll('.aspect-square').length).toBeGreaterThan(0)
  })

  it('Given shape="video", When rendered, Then a 16:9 placeholder is present (iter-356.63)', () => {
    // arrange / act
    const { container } = render(<LoadingState shape="video" />)

    // assert
    expect(container.querySelector('.aspect-video')).not.toBeNull()
    expect(screen.getByLabelText('Loading video')).toBeInTheDocument()
  })

  it('Given shape="form", When rendered, Then a stack of label+input outlines is present (iter-356.63)', () => {
    // arrange / act
    const { container } = render(<LoadingState shape="form" />)

    // assert
    expect(screen.getByLabelText('Loading')).toBeInTheDocument()
    // Form skeleton stacks 4 input blocks + a submit-ish row.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(4)
  })
})
