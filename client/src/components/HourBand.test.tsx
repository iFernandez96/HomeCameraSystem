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
})
