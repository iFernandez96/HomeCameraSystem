import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { VerbToolbar } from './VerbToolbar'

describe('VerbToolbar', () => {
  it('Given no active verb, When the toolbar renders, Then all four verb pills are accessible buttons with aria-pressed false', () => {
    // arrange / act
    render(<VerbToolbar activeVerb={null} onSelect={() => {}} />)

    // assert
    const group = screen.getByRole('group', { name: 'Toys' })
    expect(group).toBeInTheDocument()
    for (const label of ['Laser', 'Yarn', 'Treat', 'Wand']) {
      const pill = screen.getByRole('button', { name: label })
      expect(pill).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('Given the laser verb is active, When the toolbar renders, Then only the laser pill is pressed', () => {
    // arrange / act
    render(<VerbToolbar activeVerb="laser" onSelect={() => {}} />)

    // assert
    expect(screen.getByRole('button', { name: 'Laser' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Yarn' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('Given no active verb, When a pill is clicked, Then onSelect fires with that verb', async () => {
    // arrange
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<VerbToolbar activeVerb={null} onSelect={onSelect} />)

    // act
    await user.click(screen.getByRole('button', { name: 'Treat' }))

    // assert
    expect(onSelect).toHaveBeenCalledWith('treat')
  })

  it('Given the active verb pill, When it is clicked again, Then onSelect fires with null (toggle off)', async () => {
    // arrange
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<VerbToolbar activeVerb="wand" onSelect={onSelect} />)

    // act
    await user.click(screen.getByRole('button', { name: 'Wand' }))

    // assert
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})
