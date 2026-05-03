import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Slider } from './Slider'

/** Stateful harness — Slider is controlled, so the parent must echo
 * onChange back into the value prop for a fireEvent.change to "stick". */
function Stateful({
  initial = 0.5,
  onCommit,
}: {
  initial?: number
  onCommit?: (v: number) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Slider
      label="x"
      value={value}
      min={0}
      max={1}
      step={0.01}
      onChange={setValue}
      onCommit={onCommit}
    />
  )
}

describe('Slider', () => {
  it('renders the label and formatted value', () => {
    render(
      <Slider
        label="Threshold"
        value={0.55}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText('Threshold')).toBeInTheDocument()
    expect(screen.getByText('0.55')).toBeInTheDocument()
  })

  it('uses label as the accessible name when no ariaLabel given', () => {
    render(
      <Slider
        label="Cooldown"
        value={5}
        min={0}
        max={60}
        step={1}
        onChange={() => {}}
      />,
    )
    expect(screen.getByRole('slider', { name: 'Cooldown' })).toBeInTheDocument()
  })

  it('respects an explicit ariaLabel', () => {
    render(
      <Slider
        label="Cooldown"
        ariaLabel="Detection cooldown seconds"
        value={5}
        min={0}
        max={60}
        step={1}
        onChange={() => {}}
      />,
    )
    expect(
      screen.getByRole('slider', { name: 'Detection cooldown seconds' }),
    ).toBeInTheDocument()
  })

  it('fires onChange with the parsed numeric value', () => {
    const onChange = vi.fn()
    render(
      <Slider
        label="x"
        value={0.5}
        min={0}
        max={1}
        step={0.01}
        onChange={onChange}
      />,
    )
    const input = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.7' } })
    expect(onChange).toHaveBeenCalledWith(0.7)
  })

  it('fires onCommit on pointer up (debounce gate for network writes)', () => {
    const onCommit = vi.fn()
    render(<Stateful onCommit={onCommit} />)
    const input = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.4' } })
    fireEvent.pointerUp(input)
    expect(onCommit).toHaveBeenCalledWith(0.4)
  })

  it('fires onCommit on arrow-key release', () => {
    const onCommit = vi.fn()
    render(<Stateful onCommit={onCommit} />)
    const input = screen.getByRole('slider') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.6' } })
    fireEvent.keyUp(input, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenCalledWith(0.6)
  })

  it('does not fire onCommit on unrelated key release', () => {
    const onCommit = vi.fn()
    render(
      <Slider
        label="x"
        value={0.5}
        min={0}
        max={1}
        step={0.01}
        onChange={() => {}}
        onCommit={onCommit}
      />,
    )
    const input = screen.getByRole('slider') as HTMLInputElement
    fireEvent.keyUp(input, { key: 'Tab' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('respects disabled', () => {
    render(
      <Slider
        label="x"
        value={0.5}
        min={0}
        max={1}
        step={0.01}
        onChange={() => {}}
        disabled
      />,
    )
    expect(screen.getByRole('slider')).toBeDisabled()
  })
})
