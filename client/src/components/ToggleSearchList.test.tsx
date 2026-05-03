import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToggleSearchList } from './ToggleSearchList'

// iter-303: BDD-lite tests for the new fuzzy-search + per-option
// toggle widget. Used by NotificationsSection (iter-303a) to replace
// the comma-separated text inputs for cameras + person_names.

describe('ToggleSearchList', () => {
  it('given options and one selected, when rendered, then the selected option is checked (iter-303)', () => {
    // arrange
    const onChange = vi.fn()

    // act
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob']}
        selected={['alice']}
        onChange={onChange}
      />,
    )

    // assert
    expect((screen.getByLabelText(/^allow alice$/i) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText(/^don't allow bob$/i) as HTMLInputElement).checked).toBe(false)
  })

  it('given an unselected option, when user clicks it, then onChange fires with the option added (iter-303)', async () => {
    // arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob']}
        selected={[]}
        onChange={onChange}
      />,
    )

    // act
    await user.click(screen.getByLabelText(/^don't allow alice$/i))

    // assert
    expect(onChange).toHaveBeenCalledWith(['alice'])
  })

  it('given a selected option, when user clicks it, then onChange fires with the option removed (iter-303)', async () => {
    // arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob']}
        selected={['alice', 'bob']}
        onChange={onChange}
      />,
    )

    // act
    await user.click(screen.getByLabelText(/^allow alice$/i))

    // assert — sorted survivors only.
    expect(onChange).toHaveBeenCalledWith(['bob'])
  })

  it('given a search query, when typed, then only matching options are shown (iter-303)', async () => {
    // arrange
    const user = userEvent.setup()
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob', 'carol']}
        selected={[]}
        onChange={vi.fn()}
      />,
    )

    // act — case-insensitive substring match.
    await user.type(screen.getByLabelText(/search people/i), 'AL')

    // assert
    expect(screen.getByLabelText(/^don't allow alice$/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^don't allow bob$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^don't allow carol$/i)).not.toBeInTheDocument()
  })

  it('given empty options, when rendered, then shows the empty-state message (iter-303)', () => {
    // arrange
    render(
      <ToggleSearchList
        label="Cameras"
        options={[]}
        selected={[]}
        onChange={vi.fn()}
        emptyMessage="No cameras yet."
      />,
    )

    // assert — search box is hidden, empty message shown.
    expect(screen.getByText('No cameras yet.')).toBeInTheDocument()
    expect(screen.queryByLabelText(/search cameras/i)).not.toBeInTheDocument()
  })

  it('given disabled, when rendered, then checkboxes are disabled (iter-303)', () => {
    // arrange
    render(
      <ToggleSearchList
        label="People"
        options={['alice']}
        selected={[]}
        onChange={vi.fn()}
        disabled
      />,
    )

    // assert
    expect(screen.getByLabelText(/^don't allow alice$/i)).toBeDisabled()
    expect(screen.getByLabelText(/search people/i)).toBeDisabled()
  })

  it('given no options selected, when rendered, then helper says no filter set (iter-321 ux-grandpa Frank #1)', () => {
    // arrange
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob']}
        selected={[]}
        onChange={vi.fn()}
      />,
    )

    // assert — empty selection = match all (the iter-205 server semantic).
    expect(
      screen.getByText(/no filter set — alerts come through for everyone/i),
    ).toBeInTheDocument()
  })

  it('given one of two options selected, when rendered, then helper reads "Alerting for 1 of 2 people" (iter-321)', () => {
    // arrange
    render(
      <ToggleSearchList
        label="People"
        options={['alice', 'bob']}
        selected={['alice']}
        onChange={vi.fn()}
      />,
    )

    // assert
    expect(
      screen.getByText(/alerting for 1 of 2 people/i),
    ).toBeInTheDocument()
  })
})
