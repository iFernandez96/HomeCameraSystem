import { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PlaybackSpeedControl, SPEED_RATES } from './PlaybackSpeedControl'

// Controlled-component harness (the real consumers own the rate state).
function Harness({ initial = 1 }: { initial?: number }) {
  const [rate, setRate] = useState(initial)
  return <PlaybackSpeedControl rate={rate} onRateChange={setRate} />
}

describe('PlaybackSpeedControl', () => {
  it('given the control renders, when shown, then all eight speed rates are present as radios', () => {
    // arrange / act
    render(<Harness />)
    // assert — the full set the user asked for: .25 .5 .75 1 1.25 1.5 2 4.
    expect(SPEED_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4])
    expect(screen.getAllByRole('radio')).toHaveLength(8)
    expect(screen.getByRole('radio', { name: '0.25 times speed' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '0.75 times speed' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '1.25 times speed' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '4 times speed' })).toBeInTheDocument()
  })

  it('given the visible labels, when rendered, then each pill shows the compact "N×" multiplier', () => {
    // arrange / act
    render(<Harness />)
    // assert — visible text is the multiplier; aria-label is the spoken form.
    expect(screen.getByText('1.5×')).toBeInTheDocument()
    expect(screen.getByText('4×')).toBeInTheDocument()
    expect(screen.getByText('0.25×')).toBeInTheDocument()
  })

  it('given a default rate of 1, when rendered, then "Normal speed" is the checked radio', () => {
    // arrange / act
    render(<Harness initial={1} />)
    // assert
    expect(screen.getByRole('radio', { name: 'Normal speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given the user clicks the 4x pill, when it fires, then 4x becomes the checked radio', async () => {
    // arrange
    render(<Harness />)
    const user = userEvent.setup()
    // act
    await user.click(screen.getByRole('radio', { name: '4 times speed' }))
    // assert
    expect(screen.getByRole('radio', { name: '4 times speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given the current selection, when inspected, then ONLY the selected pill has tabIndex=0 (roving tabindex)', () => {
    // arrange / act
    render(<Harness initial={1} />)
    // assert
    expect(
      screen.getByRole('radio', { name: 'Normal speed' }).getAttribute('tabindex'),
    ).toBe('0')
    expect(
      screen.getByRole('radio', { name: '0.25 times speed' }).getAttribute('tabindex'),
    ).toBe('-1')
    expect(
      screen.getByRole('radio', { name: '4 times speed' }).getAttribute('tabindex'),
    ).toBe('-1')
  })

  it('given focus on 1x, when ArrowRight is pressed, then 1.25x (the next rate) becomes selected and focused', async () => {
    // arrange
    render(<Harness initial={1} />)
    const oneX = screen.getByRole('radio', { name: 'Normal speed' }) as HTMLButtonElement
    oneX.focus()
    const user = userEvent.setup()
    // act
    await user.keyboard('{ArrowRight}')
    // assert
    const next = screen.getByRole('radio', { name: '1.25 times speed' })
    expect(next).toHaveAttribute('aria-checked', 'true')
    expect(next.getAttribute('tabindex')).toBe('0')
    expect(oneX.getAttribute('tabindex')).toBe('-1')
  })

  it('given focus on 1x, when ArrowLeft is pressed, then 0.75x (the previous rate) becomes selected', async () => {
    // arrange
    render(<Harness initial={1} />)
    ;(screen.getByRole('radio', { name: 'Normal speed' }) as HTMLButtonElement).focus()
    const user = userEvent.setup()
    // act
    await user.keyboard('{ArrowLeft}')
    // assert
    expect(screen.getByRole('radio', { name: '0.75 times speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given Home and End, when pressed, then selection jumps to the first (0.25x) and last (4x)', async () => {
    // arrange
    render(<Harness initial={1} />)
    ;(screen.getByRole('radio', { name: 'Normal speed' }) as HTMLButtonElement).focus()
    const user = userEvent.setup()
    // act + assert — End → last.
    await user.keyboard('{End}')
    expect(screen.getByRole('radio', { name: '4 times speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // Home → first.
    ;(screen.getByRole('radio', { name: '4 times speed' }) as HTMLButtonElement).focus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('radio', { name: '0.25 times speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('given focus on the first pill (0.25x), when ArrowLeft is pressed, then it wraps to the last (4x)', async () => {
    // arrange
    render(<Harness initial={0.25} />)
    ;(screen.getByRole('radio', { name: '0.25 times speed' }) as HTMLButtonElement).focus()
    const user = userEvent.setup()
    // act
    await user.keyboard('{ArrowLeft}')
    // assert — wraps to the end.
    expect(screen.getByRole('radio', { name: '4 times speed' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })
})
