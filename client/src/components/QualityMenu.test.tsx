import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QualityMenu } from './QualityMenu'

describe('QualityMenu (fuzz F6 — themed replacement for the native select)', () => {
  it('Given the menu is closed, When rendered, Then the trigger announces the current tier and no listbox is present', () => {
    // arrange / act
    render(<QualityMenu quality="auto" onSelect={vi.fn()} />)

    // assert
    const trigger = screen.getByRole('button', { name: 'Stream quality' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveTextContent('Auto')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('Given the trigger, When clicked, Then the listbox opens with every quality option', async () => {
    // arrange
    const user = userEvent.setup()
    render(<QualityMenu quality="hq" onSelect={vi.fn()} />)

    // act
    await user.click(screen.getByRole('button', { name: 'Stream quality' }))

    // assert
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('option', { name: /HQ/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('Given the listbox is open, When ArrowDown then Enter is pressed, Then the next option is selected and focus returns to the trigger', async () => {
    // arrange
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<QualityMenu quality="auto" onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Stream quality' })
    await user.click(trigger)

    // act — Auto is index 0; ArrowDown moves to HQ (index 1), Enter commits.
    await waitFor(() => expect(document.activeElement).not.toBe(trigger))
    await user.keyboard('{ArrowDown}{Enter}')

    // assert
    expect(onSelect).toHaveBeenCalledWith('hq')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('Given the listbox is open, When Escape is pressed, Then it closes without selecting and focus returns to the trigger', async () => {
    // arrange
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<QualityMenu quality="sd" onSelect={onSelect} />)
    const trigger = screen.getByRole('button', { name: 'Stream quality' })
    await user.click(trigger)
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())

    // act
    await user.keyboard('{Escape}')

    // assert
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('Given the listbox is open, When an option is clicked, Then onSelect fires with that value', async () => {
    // arrange
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<QualityMenu quality="auto" onSelect={onSelect} />)
    await user.click(screen.getByRole('button', { name: 'Stream quality' }))

    // act
    await user.click(screen.getByRole('option', { name: /Ultra-low/ }))

    // assert
    expect(onSelect).toHaveBeenCalledWith('xs')
  })

  it('Given the listbox is open, When each option renders, Then a one-line plain-language subtitle explains the tradeoff (painfix wave B #4)', async () => {
    // arrange
    const user = userEvent.setup()
    render(<QualityMenu quality="auto" onSelect={vi.fn()} />)

    // act
    await user.click(screen.getByRole('button', { name: 'Stream quality' }))

    // assert
    expect(screen.getByText('Adjusts to your connection')).toBeInTheDocument()
    expect(screen.getByText('Sharpest picture, most data')).toBeInTheDocument()
    expect(
      screen.getByText('Good picture, about a quarter of the data'),
    ).toBeInTheDocument()
    expect(screen.getByText('Rough picture, works on weak signal')).toBeInTheDocument()
    // Trigger keeps a concise accessible name even though options are chatty.
    expect(screen.getByRole('button', { name: 'Stream quality' })).toBeInTheDocument()
  })

  it('Given the listbox is open, When a click lands outside the menu, Then it closes', async () => {
    // arrange
    const user = userEvent.setup()
    render(
      <div>
        <button type="button">outside</button>
        <QualityMenu quality="auto" onSelect={vi.fn()} />
      </div>,
    )
    await user.click(screen.getByRole('button', { name: 'Stream quality' }))
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument())

    // act
    await user.click(screen.getByRole('button', { name: 'outside' }))

    // assert
    await waitFor(() =>
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument(),
    )
  })
})
