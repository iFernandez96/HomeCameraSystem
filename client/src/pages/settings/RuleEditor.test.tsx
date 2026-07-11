import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SmartRule } from '../../lib/types'
import { RuleEditor } from './RuleEditor'

vi.mock('../../components/LineEditor', () => ({
  LineEditor: () => <div data-testid="line-editor" />,
}))

vi.mock('../../components/ZoneEditor', () => ({
  ZoneEditor: () => <div data-testid="zone-editor" />,
}))

const baseRule: SmartRule = {
  id: 'porch_rule',
  name: 'Porch package area',
  kind: 'package',
  enabled: true,
  camera_id: 'front_door',
  points: [[0.1, 0.1], [0.8, 0.1], [0.8, 0.8]],
  labels: ['person'],
  direction: 'any',
  dwell_s: 10,
  threshold: 0.55,
}

function renderEditor(rule: SmartRule, onChange = vi.fn()) {
  render(
    <RuleEditor
      rule={rule}
      cameras={[{ id: 'front_door', name: 'Front Door', path: 'cam' }]}
      busy={false}
      privacyMasks={[]}
      onChange={onChange}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  return onChange
}

describe('RuleEditor package semantics', () => {
  it('Given a package rule, When edited, Then person is suggested only as a scene-sampling blocker', () => {
    // arrange / act
    renderEditor(baseRule)

    // assert
    const blockers = screen.getByRole('textbox', {
      name: 'Objects that pause package detection',
    })
    expect(blockers).toHaveValue('person')
    expect(blockers).toHaveAttribute('placeholder', 'person')
    expect(blockers.getAttribute('placeholder')).not.toContain('package')
    expect(blockers).toHaveAccessibleDescription(/pause scene-change sampling/i)
    expect(screen.getByText(/pause scene-change sampling/i)).toBeInTheDocument()
    expect(screen.getByText(/does not identify a parcel/i)).toBeInTheDocument()
  })

  it('Given a rule without labels, When package mode is selected, Then person becomes the safe default blocker', () => {
    // arrange
    const onChange = renderEditor({
      ...baseRule,
      kind: 'line_crossing',
      points: [[0.2, 0.5], [0.8, 0.5]],
      labels: [],
    })

    // act
    fireEvent.change(screen.getByRole('combobox', { name: 'Rule type' }), {
      target: { value: 'package' },
    })

    // assert
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'package',
      points: [],
      labels: ['person'],
    }))
  })
})
