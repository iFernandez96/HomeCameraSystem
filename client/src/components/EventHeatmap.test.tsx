import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const getEventCountsByDay = vi.fn()
vi.mock('../lib/api', () => ({
  getEventCountsByDay: (...a: unknown[]) => getEventCountsByDay(...a),
}))

import { EventHeatmap, buildDayList, dayBounds } from './EventHeatmap'

describe('EventHeatmap', () => {
  beforeEach(() => {
    getEventCountsByDay.mockReset().mockResolvedValue({ counts: {} })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('fetches counts on mount (iter-223)', async () => {
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
  })

  it('when the heatmap mounts, then the current month is shown with one cell per day (iter-252)', async () => {
    // arrange / act — iter-252 shows a single calendar month at a
    // time (28-31 cells) instead of a fixed 30-day window. Lead-
    // padding cells are aria-hidden so they don't match the
    // "<date>: N detection(s)" aria-label query.
    render(<EventHeatmap />)

    // assert
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    const today = new Date()
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    expect(cells.length).toBe(lastDay)
  })

  it('when the user taps Previous month, then the heatmap refetches with the prior month\'s bounds (iter-252)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    const initialCall = getEventCountsByDay.mock.calls[0][0]

    // act
    await user.click(screen.getByRole('button', { name: /previous month/i }))

    // assert — second fetch's since_ts is exactly one month earlier
    // than the first. Subtracting calendar months in seconds varies
    // (28-31 days), so we just assert the bounds are EARLIER.
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(2))
    const secondCall = getEventCountsByDay.mock.calls[1][0]
    expect(secondCall.since_ts).toBeLessThan(initialCall.since_ts)
    expect(secondCall.until_ts).toBeLessThanOrEqual(initialCall.since_ts)
  })

  it('given a previous month is in view, when Today is clicked, then the view jumps back to the current month (iter-252)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: /previous month/i }))
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(2))

    // act
    await user.click(screen.getByRole('button', { name: /jump to current month/i }))

    // assert — third fetch returns to the original bounds.
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(3))
    const initialCall = getEventCountsByDay.mock.calls[0][0]
    const thirdCall = getEventCountsByDay.mock.calls[2][0]
    expect(thirdCall.since_ts).toBe(initialCall.since_ts)
    expect(thirdCall.until_ts).toBe(initialCall.until_ts)
  })

  it('when viewing the current month, then the Next-month button is disabled (iter-252)', async () => {
    // arrange / act
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())

    // assert
    expect(screen.getByRole('button', { name: /next month/i })).toBeDisabled()
  })

  it('when a day has 3 events, then the cell aria-label reads "3 detections" with the human date (iter-250)', async () => {
    // arrange
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    getEventCountsByDay.mockResolvedValue({ counts: { [todayKey]: 3 } })

    // act
    render(<EventHeatmap />)

    // assert — the cell label is now "<short weekday>, <short
    // month> <day>: 3 detections (today)" (iter-250 plain English).
    await waitFor(() =>
      expect(getEventCountsByDay).toHaveBeenCalledTimes(1),
    )
    expect(
      screen.getByLabelText(/3 detections \(today\)/i),
    ).toBeInTheDocument()
  })

  it('when today\'s cell is clicked, then onSelectDay is called with a 24-hour bound (iter-250)', async () => {
    // arrange
    const onSelectDay = vi.fn()
    render(<EventHeatmap onSelectDay={onSelectDay} />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())

    // act — today is the last day cell; find it via the "(today)"
    // aria-label suffix iter-250 added.
    const todayCell = screen.getByLabelText(/\(today\)/i)
    fireEvent.click(todayCell)

    // assert
    expect(onSelectDay).toHaveBeenCalledTimes(1)
    const args = onSelectDay.mock.calls[0]
    expect(typeof args[0]).toBe('number')
    expect(typeof args[1]).toBe('number')
    expect(args[1] - args[0]).toBe(86400)
  })

  it('renders an error message when getEventCountsByDay rejects (iter-223)', async () => {
    getEventCountsByDay.mockRejectedValue(new Error('network down'))
    render(<EventHeatmap />)
    await waitFor(() =>
      expect(
        screen.getByLabelText(/heatmap load error/i),
      ).toBeInTheDocument(),
    )
  })

  // iter-224 (Feature #6 polish): personName prop forwards to the
  // count_by_day fetch so the heatmap shows alice's days only when
  // the alice chip is active.

  it('forwards personName prop to getEventCountsByDay (iter-224, since iter-252 also passes since/until)', async () => {
    render(<EventHeatmap personName="alice" />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    expect(getEventCountsByDay).toHaveBeenCalledWith(
      expect.objectContaining({ person_name: 'alice' }),
    )
  })

  it('omits person_name from the fetch when personName is undefined (iter-224)', async () => {
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    const call = getEventCountsByDay.mock.calls[0][0]
    expect(call).not.toHaveProperty('person_name')
  })

  it('forwards faceUnrecognized prop to getEventCountsByDay (iter-228)', async () => {
    render(<EventHeatmap faceUnrecognized={true} />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    expect(getEventCountsByDay).toHaveBeenCalledWith(
      expect.objectContaining({ face_unrecognized: true }),
    )
  })

  it('refetches when faceUnrecognized prop changes (iter-228)', async () => {
    const { rerender } = render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    rerender(<EventHeatmap faceUnrecognized={true} />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(2))
    expect(getEventCountsByDay.mock.calls[1][0]).toEqual(
      expect.objectContaining({ face_unrecognized: true }),
    )
  })

  it('refetches when personName prop changes (iter-224)', async () => {
    const { rerender } = render(<EventHeatmap personName="alice" />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    rerender(<EventHeatmap personName="bob" />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(2))
    expect(getEventCountsByDay.mock.calls[1][0]).toEqual(
      expect.objectContaining({ person_name: 'bob' }),
    )
  })

  // iter-226 (Feature #6 polish): refetch on tab resume so a long-
  // open page doesn't show stale counts. Mirrors the iter-37/157/158
  // visibility-aware channels pattern.

  it('refetches counts when document becomes visible (iter-226)', async () => {
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    // Simulate tab returning from background.
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(2))
  })

  it('does NOT refetch when document becomes hidden (iter-226)', async () => {
    render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 0))
    expect(getEventCountsByDay).toHaveBeenCalledTimes(1)
    // Restore for subsequent tests.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('removes the visibilitychange listener on unmount (iter-226)', async () => {
    const { unmount } = render(<EventHeatmap />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalledTimes(1))
    unmount()
    // After unmount, a visibilitychange event must NOT trigger another fetch.
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 0))
    expect(getEventCountsByDay).toHaveBeenCalledTimes(1)
  })
})

// Visible helpers — pin their semantics so refactors don't drift
// the date-bucketing convention from the iter-222 server side.

describe('buildDayList', () => {
  it('returns N days oldest-first ending at today', () => {
    const today = new Date(2026, 3, 30)  // April 30, 2026 (month 0-indexed)
    const days = buildDayList(5, today)
    expect(days).toHaveLength(5)
    expect(days[0]).toBe('2026-04-26')
    expect(days[4]).toBe('2026-04-30')
  })

  it('handles month boundaries', () => {
    const today = new Date(2026, 4, 2)  // May 2, 2026
    const days = buildDayList(5, today)
    expect(days[0]).toBe('2026-04-28')
    expect(days[4]).toBe('2026-05-02')
  })
})

describe('EventHeatmap brand consistency (premium-launch slice)', () => {
  it('Given today exists in the rendered month, When the today cell renders, Then the active-ring uses the brass brand token (NOT raw blue)', async () => {
    // arrange — Maya Major: pre-fix the today indicator was
    // `ring-2 ring-blue-400` — a raw Tailwind blue inside the
    // warm-den brand palette that read as a dev placeholder.
    // Brass token matches the rest of the watch-log eyebrow
    // pattern and stays in the project's color system.
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    getEventCountsByDay.mockResolvedValue({ counts: { [todayKey]: 1 } })

    // act
    render(<EventHeatmap />)

    // assert
    const cell = await screen.findByLabelText(/\(today\)/i)
    expect(cell.className).toMatch(/ring-\[var\(--color-brass-default\)\]/)
    expect(cell.className).not.toMatch(/ring-blue/)
  })

  it('Given counts span all four populated heat-ramp tiers, When the cells render, Then no cell uses the raw `bg-amber-300` Tailwind token (single-hue ramp through ember tokens)', async () => {
    // arrange — Maya Critical: the mid-tier of the ramp was
    // `bg-amber-300`, a raw Tailwind tone OUTSIDE the brand
    // token system. Now the entire ramp climbs through ember
    // tokens monotonically: subtle → muted → default → bright.
    // Build a counts map that exercises all four tiers — max=8
    // so ratios 1/8, 3/8, 5/8, 8/8 hit each band.
    const today = new Date()
    const fmt = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    getEventCountsByDay.mockResolvedValue({
      counts: {
        [fmt(-3)]: 1,
        [fmt(-2)]: 3,
        [fmt(-1)]: 5,
        [fmt(0)]: 8,
      },
    })

    // act
    render(<EventHeatmap />)
    const cells = await screen.findAllByLabelText(/: \d+ detections?/)

    // assert — no cell carries a raw `amber-` Tailwind token.
    for (const cell of cells) {
      expect(cell.className).not.toMatch(/\bbg-amber-\d+\b/)
    }
  })

  it('Given the legend renders, When the swatches paint, Then the mid-tier swatch uses the ember-muted brand token (matching the cellTier mid-tier — single-source-of-truth between ramp and legend)', async () => {
    // arrange — pre-fix the legend swatch was `bg-amber-300` and
    // the cell-tier mid-band was also `bg-amber-300`. We swap
    // both to `--color-accent-muted`. This test asserts the
    // LEGEND side; the cells side is asserted above.
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    getEventCountsByDay.mockResolvedValue({ counts: { [todayKey]: 5 } })

    // act
    const { container } = render(<EventHeatmap />)
    await screen.findByText(/fewer detections/i)

    // assert — search inside the legend row for the muted swatch;
    // also assert no amber-300 swatch survives.
    const legend = screen
      .getByText(/fewer detections/i)
      .closest('div')!
    expect(legend.innerHTML).toMatch(/--color-accent-muted/)
    expect(container.innerHTML).not.toMatch(/bg-amber-300/)
  })

  it('Given a day cell with events, When the count renders, Then it uses the 11px readable size instead of the sub-floor 9px (UI/UX overhaul 2026-07-07, frank B4)', async () => {
    // arrange — put 3 events on today so a count span renders.
    const today = new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    getEventCountsByDay.mockResolvedValue({ counts: { [todayKey]: 3 } })

    // act
    render(<EventHeatmap />)
    const cell = await screen.findByLabelText(/3 detections \(today\)/i)

    // assert — jsdom applies no stylesheet; pin the class token.
    const count = Array.from(cell.querySelectorAll('span')).find(
      (s) => s.textContent === '3',
    )
    expect(count).toBeDefined()
    expect(count!.className).toMatch(/text-\[11px\]/)
    expect(count!.className).not.toMatch(/text-\[9px\]/)
  })
})

describe('dayBounds', () => {
  it('returns local-midnight to next-local-midnight as unix epoch seconds', () => {
    const [start, end] = dayBounds('2026-04-30')
    // 24 hours apart.
    expect(end - start).toBe(86400)
    // Start aligns to local midnight (the test runs in whatever TZ
    // the runner is in; we just assert the local-time math, not
    // specific UTC values).
    const startDate = new Date(start * 1000)
    expect(startDate.getHours()).toBe(0)
    expect(startDate.getMinutes()).toBe(0)
    expect(startDate.getSeconds()).toBe(0)
  })
})
