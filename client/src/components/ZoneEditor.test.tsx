import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ZoneEditor } from './ZoneEditor'
import { ToastProvider } from '../lib/toast'
import type { Zone } from '../lib/types'

// iter-274: ZoneEditor depends on useToast() now (slice a uses it
// for invalid-input feedback). Wrap renders in a ToastProvider so
// the hook resolves to a real implementation.
function renderWithToast(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>)
}

// jsdom returns zeros from getBoundingClientRect by default. Stub a
// 200×100 box so the click handler can translate to non-trivial
// normalized coords. Apply the stub via Object.defineProperty on
// SVGElement.prototype so it covers any svg the test renders.
function stubBoundingRect() {
  Object.defineProperty(SVGElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => '',
    }),
  })
}


describe('ZoneEditor', () => {
  it('renders existing zones as polygon overlays', () => {
    const zones: Zone[] = [
      [
        [0.1, 0.1],
        [0.5, 0.1],
        [0.3, 0.5],
      ],
      [
        [0.6, 0.6],
        [0.9, 0.6],
        [0.9, 0.9],
        [0.6, 0.9],
      ],
    ]
    renderWithToast(<ZoneEditor zones={zones} onChange={vi.fn()} />)
    expect(screen.getByTestId('zone-0')).toBeInTheDocument()
    expect(screen.getByTestId('zone-1')).toBeInTheDocument()
    // Zone-1 is rendered with the 4 points joined into the polygon
    // points attribute; verify exact coords flow through unchanged.
    expect(screen.getByTestId('zone-1').getAttribute('points')).toBe(
      '0.6,0.6 0.9,0.6 0.9,0.9 0.6,0.9',
    )
  })

  it('clicking the SVG appends an in-progress vertex', () => {
    stubBoundingRect()
    const onChange = vi.fn()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    // iter-295: SVG role is now 'application' (interactive widget).
    // Tests look up via the new role + updated aria-label prefix.
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    // 200×100 box → click at (50, 25) → normalized (0.25, 0.25).
    fireEvent.click(svg, { clientX: 50, clientY: 25 })
    expect(screen.getByTestId('in-progress-vertex-0')).toBeInTheDocument()
    // Finish button is disabled until 3 points are committed.
    expect(
      screen.getByRole('button', { name: /finish polygon/i }),
    ).toBeDisabled()
    // No commit yet — onChange must NOT have fired.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('finishes a polygon when 3 points are added and button is clicked', () => {
    stubBoundingRect()
    const onChange = vi.fn()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    // iter-295: SVG role is now 'application' (interactive widget).
    // Tests look up via the new role + updated aria-label prefix.
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    fireEvent.click(svg, { clientX: 0, clientY: 0 })
    fireEvent.click(svg, { clientX: 200, clientY: 0 })
    fireEvent.click(svg, { clientX: 100, clientY: 100 })
    const finish = screen.getByRole('button', { name: /finish polygon/i })
    expect(finish).not.toBeDisabled()
    fireEvent.click(finish)
    expect(onChange).toHaveBeenCalledTimes(1)
    const passed = onChange.mock.calls[0][0] as Zone[]
    expect(passed).toHaveLength(1)
    expect(passed[0]).toEqual([
      [0, 0],
      [1, 0],
      [0.5, 1],
    ])
  })

  it('cancel button clears the in-progress vertices', () => {
    stubBoundingRect()
    renderWithToast(<ZoneEditor zones={[]} onChange={vi.fn()} />)
    // iter-295: SVG role is now 'application' (interactive widget).
    // Tests look up via the new role + updated aria-label prefix.
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    fireEvent.click(svg, { clientX: 0, clientY: 0 })
    fireEvent.click(svg, { clientX: 200, clientY: 0 })
    expect(screen.getByTestId('in-progress-vertex-0')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByTestId('in-progress-vertex-0')).not.toBeInTheDocument()
  })

  it('per-zone delete fires onChange with the zone removed', () => {
    const zones: Zone[] = [
      [
        [0.1, 0.1],
        [0.5, 0.1],
        [0.3, 0.5],
      ],
      [
        [0.6, 0.6],
        [0.9, 0.6],
        [0.9, 0.9],
      ],
    ]
    const onChange = vi.fn()
    renderWithToast(<ZoneEditor zones={zones} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /delete zone 1/i }))
    expect(onChange).toHaveBeenCalledWith([zones[1]])
  })

  it('clamps clicks outside the SVG bounds to [0, 1]', () => {
    stubBoundingRect()
    const onChange = vi.fn()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    // iter-295: SVG role is now 'application' (interactive widget).
    // Tests look up via the new role + updated aria-label prefix.
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    // 250 > 200 width → would be 1.25 → clamped to 1.0.
    fireEvent.click(svg, { clientX: 250, clientY: 200 })
    fireEvent.click(svg, { clientX: -50, clientY: 0 })
    fireEvent.click(svg, { clientX: 100, clientY: 50 })
    fireEvent.click(screen.getByRole('button', { name: /finish polygon/i }))
    const passed = onChange.mock.calls[0][0] as Zone[]
    expect(passed[0]).toEqual([
      [1, 1],
      [0, 0],
      [0.5, 0.5],
    ])
  })

  it('finish button stays disabled with fewer than 3 in-progress points', () => {
    stubBoundingRect()
    renderWithToast(<ZoneEditor zones={[]} onChange={vi.fn()} />)
    // iter-295: SVG role is now 'application' (interactive widget).
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    // iter-295: Finish + Cancel + Undo only render when drawing
    // (inProgress.length > 0). Empty state shows neither.
    expect(
      screen.queryByRole('button', { name: /finish polygon/i }),
    ).not.toBeInTheDocument()
    fireEvent.click(svg, { clientX: 10, clientY: 10 })
    // Now drawing → button visible but disabled with 1 point.
    const finish1 = screen.getByRole('button', { name: /finish polygon/i })
    expect(finish1).toBeDisabled()
    fireEvent.click(svg, { clientX: 20, clientY: 20 })
    expect(
      screen.getByRole('button', { name: /finish polygon/i }),
    ).toBeDisabled()
  })

  // iter-297 (ux-grandpa Gripe #2): the disabled Finish button used
  // to read "Finish polygon (1 pts)" — tapping it did nothing and
  // gave no clue why. Now the label tells the user what's missing.

  it('given 1 in-progress vertex, when the disabled Finish button renders, then the label says "need 2 more" (iter-297)', () => {
    // arrange
    stubBoundingRect()
    renderWithToast(<ZoneEditor zones={[]} onChange={vi.fn()} />)
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })

    // act
    fireEvent.click(svg, { clientX: 10, clientY: 10 })

    // assert
    expect(
      screen.getByRole('button', { name: /finish polygon \(need 2 more\)/i }),
    ).toBeDisabled()
  })

  it('given 2 in-progress vertices, when the help text reads, then it tells the user to tap once more (iter-297)', () => {
    // arrange
    stubBoundingRect()
    renderWithToast(<ZoneEditor zones={[]} onChange={vi.fn()} />)
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })

    // act
    fireEvent.click(svg, { clientX: 10, clientY: 10 })
    fireEvent.click(svg, { clientX: 20, clientY: 20 })

    // assert
    expect(
      screen.getByText(/tap inside the frame once more, then finish polygon/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /finish polygon \(need 1 more\)/i }),
    ).toBeDisabled()
  })

  // iter-274 (accessibility-auditor #2 slice a): keyboard add-vertex
  // BDD-lite tests. Given/When/Then naming, AAA structure.

  it('given the keyboard form, when valid X/Y are submitted, then a vertex is added at the normalized coords', async () => {
    // arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    const x = screen.getByLabelText(/vertex x coordinate/i)
    const y = screen.getByLabelText(/vertex y coordinate/i)

    // act
    await user.clear(x)
    await user.type(x, '25')
    await user.clear(y)
    await user.type(y, '50')
    await user.click(screen.getByRole('button', { name: /^add point$/i }))

    // assert
    expect(screen.getByTestId('in-progress-vertex-0')).toBeInTheDocument()
    // No commit yet (1 vertex < 3 minimum).
    expect(onChange).not.toHaveBeenCalled()
  })

  it('given an out-of-range Y value, when Add point is clicked, then no vertex is added (validation guard)', async () => {
    // arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    const x = screen.getByLabelText(/vertex x coordinate/i)
    const y = screen.getByLabelText(/vertex y coordinate/i)

    // act
    await user.clear(x)
    await user.type(x, '50')
    await user.clear(y)
    await user.type(y, '200') // out of range
    await user.click(screen.getByRole('button', { name: /^add point$/i }))

    // assert: no in-progress vertex, no commit
    expect(screen.queryByTestId('in-progress-vertex-0')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('given three keyboard-added vertices, when Finish polygon clicked, then a polygon commits', async () => {
    // arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    renderWithToast(<ZoneEditor zones={[]} onChange={onChange} />)
    const x = screen.getByLabelText(/vertex x coordinate/i)
    const y = screen.getByLabelText(/vertex y coordinate/i)
    const addBtn = screen.getByRole('button', { name: /^add point$/i })

    // act: add three vertices via keyboard
    for (const [xv, yv] of [
      ['10', '10'],
      ['90', '10'],
      ['50', '90'],
    ]) {
      await user.clear(x)
      await user.type(x, xv)
      await user.clear(y)
      await user.type(y, yv)
      await user.click(addBtn)
    }
    await user.click(screen.getByRole('button', { name: /finish polygon/i }))

    // assert
    expect(onChange).toHaveBeenCalledTimes(1)
    const passed = onChange.mock.calls[0][0] as Zone[]
    expect(passed).toHaveLength(1)
    expect(passed[0]).toEqual([
      [0.1, 0.1],
      [0.9, 0.1],
      [0.5, 0.9],
    ])
  })

  // iter-295: BDD-lite tests for the user-reported UX overhaul.

  it('given an in-progress polygon, when Undo last point is clicked, then the most-recent vertex is removed (iter-295)', () => {
    // arrange
    stubBoundingRect()
    renderWithToast(<ZoneEditor zones={[]} onChange={vi.fn()} />)
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    fireEvent.click(svg, { clientX: 0, clientY: 0 })
    fireEvent.click(svg, { clientX: 100, clientY: 0 })
    fireEvent.click(svg, { clientX: 50, clientY: 100 })
    expect(screen.getByTestId('in-progress-vertex-2')).toBeInTheDocument()

    // act
    fireEvent.click(
      screen.getByRole('button', { name: /undo last point/i }),
    )

    // assert
    expect(
      screen.queryByTestId('in-progress-vertex-2'),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('in-progress-vertex-1')).toBeInTheDocument()
  })

  it('given a committed zone, when the user taps it, then it becomes selected with a Delete this zone button (iter-295)', () => {
    // arrange
    const zones: Zone[] = [
      [
        [0.1, 0.1],
        [0.5, 0.1],
        [0.3, 0.5],
      ],
    ]
    const onChange = vi.fn()
    renderWithToast(<ZoneEditor zones={zones} onChange={onChange} />)

    // act: tap the polygon to select.
    fireEvent.click(screen.getByTestId('zone-0'))

    // assert: bigger "Delete this zone" button shows below the
    // editor (the iter-295 selection affordance — pre-iter-295 the
    // only delete was a tiny ✕ in the listing).
    expect(
      screen.getByRole('button', { name: /delete this zone/i }),
    ).toBeInTheDocument()
    // Per-vertex draggable handles render for the selected zone.
    expect(screen.getByTestId('zone-0-vertex-0')).toBeInTheDocument()
    // iter-310 (Frank Gripe #3): a brief white-outline pulse renders
    // on top of the polygon to confirm the tap registered visually.
    expect(screen.getByTestId('zone-0-flash')).toBeInTheDocument()
  })

  it('given the user is drawing, when they tap an existing zone, then nothing is selected (drawing takes precedence) (iter-295)', () => {
    // arrange
    stubBoundingRect()
    const zones: Zone[] = [
      [
        [0.1, 0.1],
        [0.5, 0.1],
        [0.3, 0.5],
      ],
    ]
    renderWithToast(<ZoneEditor zones={zones} onChange={vi.fn()} />)
    const svg = screen.getByRole('application', {
      name: /detection zone editor/i,
    })
    // Start drawing by clicking empty space.
    fireEvent.click(svg, { clientX: 150, clientY: 60 })
    expect(screen.getByTestId('in-progress-vertex-0')).toBeInTheDocument()

    // act: try to tap the existing polygon while drawing.
    fireEvent.click(screen.getByTestId('zone-0'))

    // assert: no selection-edit affordances appear because we're
    // still drawing the new one.
    expect(
      screen.queryByRole('button', { name: /delete this zone/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByTestId('zone-0-vertex-0')).not.toBeInTheDocument()
  })
})
