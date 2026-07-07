import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HourBand } from './HourBand'

const day = new Date(2026, 6, 7).getTime() / 1000
const ev = (h: number, label: string, name?: string) => ({
  id: `${h}-${label}`, ts: day + h * 3600 + 60, label,
  person_name: name ?? null, person_names: name ? [name] : null,
}) as any

describe('HourBand', () => {
  it('GIVEN events in two hours WHEN rendered THEN 24 cells with those hours colored', () => {
    // arrange / act
    render(<HourBand events={[ev(8, 'cat'), ev(20, 'person')]} dayStartTs={day} />)
    // assert
    const band = screen.getByRole('img', { name: /hour by hour/i })
    const cells = band.querySelectorAll('[data-hour]')
    expect(cells).toHaveLength(24)
    expect((cells[8] as HTMLElement).style.background).toContain('--color-id-mushu')
    expect((cells[20] as HTMLElement).style.background).toContain('--color-id-person')
  })

  it('GIVEN a person and a cat in the same hour WHEN rendered THEN the person wins the cell', () => {
    // arrange / act
    render(<HourBand events={[ev(9, 'cat'), ev(9, 'person')]} dayStartTs={day} />)
    // assert
    const cell = screen.getByRole('img', { name: /hour by hour/i }).querySelectorAll('[data-hour]')[9]
    expect((cell as HTMLElement).style.background).toContain('--color-id-person')
  })

  it('GIVEN events in two hours WHEN rendered THEN the aria sentence names each active hour and identity', () => {
    // arrange / act
    render(<HourBand events={[ev(8, 'cat'), ev(20, 'person')]} dayStartTs={day} />)
    // assert
    const band = screen.getByRole('img', {
      name: /Today hour by hour: 8 AM cat, 8 PM person, rest quiet\./i,
    })
    expect(band).toBeInTheDocument()
  })

  it('GIVEN a repeated visit in one hour WHEN rendered THEN the aria sentence calls out the count', () => {
    // arrange / act
    render(<HourBand events={[ev(14, 'person'), ev(14, 'person'), ev(14, 'person')]} dayStartTs={day} />)
    // assert
    expect(screen.getByRole('img', { name: /2 PM person \(x3\)/i })).toBeInTheDocument()
  })

  it('GIVEN one sighting in an hour WHEN rendered THEN the cell is lighter than a busy hour of 4+', () => {
    // arrange / act
    render(
      <HourBand
        events={[ev(5, 'cat'), ev(6, 'cat'), ev(6, 'cat'), ev(6, 'cat'), ev(6, 'cat')]}
        dayStartTs={day}
      />,
    )
    // assert
    const cells = screen.getByRole('img', { name: /hour by hour/i }).querySelectorAll('[data-hour]')
    expect((cells[5] as HTMLElement).style.opacity).toBe('0.55') // 1 event
    expect((cells[6] as HTMLElement).style.opacity).toBe('1') // 4+ events
  })

  it('GIVEN no events WHEN rendered THEN a plain quiet aria sentence (no "rest quiet" dangling comma)', () => {
    // arrange / act
    render(<HourBand events={[]} dayStartTs={day} />)
    // assert
    expect(screen.getByRole('img', { name: /quiet so far, no activity/i })).toBeInTheDocument()
  })

  it('GIVEN two same-rank events (named persons) tie in one hour, WHEN events arrive newest-first (as the API returns them), THEN the EARLIEST event of the hour wins the cell (final review fix batch #7)', () => {
    // arrange — same rank (both 'named-person'), same hour, DIFFERENT
    // timestamps. Pushed newest-first to mirror the real API ordering
    // — pre-fix, the naive "keep the first array entry on a tie" rule
    // picked the NEWEST (array-first) event instead of the hour's
    // actual first arrival.
    const hour = 9
    const earliest = {
      id: 'evt-early', ts: day + hour * 3600 + 30, label: 'person',
      person_name: 'Sheenal', person_names: ['Sheenal'],
    } as any
    const latest = {
      id: 'evt-late', ts: day + hour * 3600 + 300, label: 'person',
      person_name: 'Israel', person_names: ['Israel'],
    } as any

    // act — newest-first array order (latest before earliest).
    render(<HourBand events={[latest, earliest]} dayStartTs={day} />)

    // assert — the aria sentence names the EARLIEST arrival's identity.
    expect(
      screen.getByRole('img', { name: /9 AM Sheenal/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('img', { name: /9 AM Israel/i }),
    ).not.toBeInTheDocument()
  })

  it('GIVEN the band WHEN rendered THEN a visible legend names People, Cats, and Quiet', () => {
    // arrange / act
    render(<HourBand events={[ev(8, 'cat')]} dayStartTs={day} />)
    // assert
    expect(screen.getByText('People')).toBeInTheDocument()
    expect(screen.getByText('Cats')).toBeInTheDocument()
    expect(screen.getByText('Quiet')).toBeInTheDocument()
  })
})
