import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LineEditor } from './LineEditor'

describe('LineEditor accessibility', () => {
  it('exposes two keyboard-editable coordinate pairs even before pointer points exist', () => {
    const onChange = vi.fn()
    render(<LineEditor points={[]} onChange={onChange} />)

    const xInputs = screen.getAllByLabelText('X percent')
    const yInputs = screen.getAllByLabelText('Y percent')
    expect(xInputs).toHaveLength(2)
    expect(yInputs).toHaveLength(2)

    fireEvent.change(xInputs[1], { target: { value: '80' } })

    expect(onChange).toHaveBeenLastCalledWith([
      [0.25, 0.5],
      [0.8, 0.5],
    ])
  })

  it('renders a visible non-scaling crossing stroke', () => {
    const { container } = render(
      <LineEditor
        points={[
          [0.2, 0.5],
          [0.8, 0.5],
        ]}
        onChange={() => {}}
      />,
    )

    const line = container.querySelector('line')
    expect(line).toHaveAttribute('stroke-width', '4')
    expect(line).toHaveAttribute('stroke-linecap', 'round')
    expect(line).toHaveAttribute('vector-effect', 'non-scaling-stroke')
  })
})
