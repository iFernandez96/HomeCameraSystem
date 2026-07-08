import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AppearanceSection } from './AppearanceSection'

const STORAGE_KEY = 'homecam:theme'

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('AppearanceSection', () => {
  it('Given no stored preference, When rendered, Then the three theme options show with System selected', () => {
    // arrange / act
    render(<AppearanceSection />)

    // assert
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(group).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(screen.getByRole('radio', { name: /system/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: /^light/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('Given a stored dark preference, When rendered, Then Dark is the selected option', () => {
    // arrange
    localStorage.setItem(STORAGE_KEY, 'dark')

    // act
    render(<AppearanceSection />)

    // assert
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: /system/i })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('Given the default (system) preference, When the user taps Dark, Then the pref persists, <html> flips to dark, and selection follows', async () => {
    // arrange
    const user = userEvent.setup()
    render(<AppearanceSection />)

    // act
    await user.click(screen.getByRole('radio', { name: /dark/i }))

    // assert
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('radio', { name: /dark/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('Given a dark preference, When the user taps System, Then the stored override clears and <html> resolves from the OS (light under jsdom)', async () => {
    // arrange — jsdom has no matchMedia, so 'system' resolves light.
    localStorage.setItem(STORAGE_KEY, 'dark')
    const user = userEvent.setup()
    render(<AppearanceSection />)

    // act
    await user.click(screen.getByRole('radio', { name: /system/i }))

    // assert
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('radio', { name: /system/i })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('Given the section is rendered, When read, Then the heading and helper copy speak human', () => {
    // arrange / act
    render(<AppearanceSection />)

    // assert
    expect(
      screen.getByRole('heading', { name: 'Appearance' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText("System follows your device's day/night setting."),
    ).toBeInTheDocument()
  })

  // UI/UX overhaul 2026-07-07 (device run-through #11): on landscape /
  // desktop the three theme tiles stretched across the full content
  // width — comically wide. The group is now width-capped.
  it('Given the theme radiogroup renders, Then the tile grid is width-capped so it does not stretch across a wide viewport (overhaul 2026-07-07)', () => {
    // arrange / act
    render(<AppearanceSection />)

    // assert
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const grid = group.querySelector('.grid')
    expect(grid).not.toBeNull()
    expect(grid?.className).toMatch(/max-w-md/)
  })
})
