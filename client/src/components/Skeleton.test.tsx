import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventListSkeleton, LivePageSkeleton } from './Skeleton'

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

  it('Given the resolved Events surface uses a vertical timeline, When the skeleton renders, Then it mirrors the timeline geometry (axis line + per-row time column + horizontal log card) so first paint settles into final layout (premium-launch slice — Maya Critical)', () => {
    // arrange / act — Maya Critical: pre-fix the EventListSkeleton
    // was a flat list of "16×16 thumb + two text lines per row" so
    // the resolved timeline (time column + axis + horizontal log
    // card) shifted every row ~24-40 px on resolve. Now the
    // skeleton owns the timeline geometry directly so first paint
    // matches.
    const { container } = render(<EventListSkeleton rows={3} />)

    // assert — the axis line (1 px decorative, aria-hidden) is
    // present inside the <ol>.
    const axis = container.querySelector('ol > [aria-hidden="true"]')
    expect(axis).not.toBeNull()
    expect(axis?.className).toMatch(/w-px/)

    // Each <li> hosts the time-column placeholder + axis tick + card.
    const rows = container.querySelectorAll('ol > li')
    expect(rows.length).toBe(3)
    for (const row of rows) {
      // Time-column placeholder sits absolute on the left at top:0.5rem.
      const decorations = row.querySelectorAll('[aria-hidden="true"]')
      expect(decorations.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('LivePageSkeleton', () => {
  it('Given the new full-bleed Live layout, When the skeleton renders, Then it carries role=status + aria-busy and matches the dark video field shape so first paint does not reflow on Live mount (premium-launch slice — Mobile-perf C1)', () => {
    // arrange / act — Mobile-perf C1: pre-fix the LivePageSkeleton
    // rendered an `aspect-video` card inside `lg:grid-cols-3` while
    // the resolved Live page is now `flex-1 min-h-0 bg-black` full
    // bleed. The pre-fix skeleton caused two visible reflows on
    // mount; the new skeleton mirrors the resolved geometry.
    const { container } = render(<LivePageSkeleton />)

    // assert — outer container claims the same height as Live and
    // is announced as loading.
    const outer = screen.getByRole('status', { name: /loading camera/i })
    expect(outer).toHaveAttribute('aria-busy', 'true')
    // Dark video field placeholder is present (bg-black inside).
    expect(container.querySelector('.bg-black')).not.toBeNull()
    // No `aspect-video` legacy shape — the new skeleton uses flex-1
    // bleed instead.
    expect(container.querySelector('.aspect-video')).toBeNull()
  })
})
