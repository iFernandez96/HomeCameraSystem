import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventListSkeleton } from './Skeleton'

describe('EventListSkeleton', () => {
  it('renders with role=status + aria-busy for assistive tech (iter-242)', () => {
    render(<EventListSkeleton />)
    const list = screen.getByRole('status', { name: /loading events/i })
    expect(list).toHaveAttribute('aria-busy', 'true')
  })

  it('defaults to 6 placeholder rows', () => {
    render(<EventListSkeleton />)
    const list = screen.getByRole('status', { name: /loading events/i })
    expect(list.querySelectorAll('li')).toHaveLength(6)
  })

  it('respects the rows prop', () => {
    render(<EventListSkeleton rows={3} />)
    const list = screen.getByRole('status', { name: /loading events/i })
    expect(list.querySelectorAll('li')).toHaveLength(3)
  })
})
