import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmProvider, useConfirm } from './confirm'

function Trigger({
  onResolve,
  destructive,
}: {
  onResolve: (v: boolean) => void
  destructive?: boolean
}) {
  const confirm = useConfirm()
  return (
    <button
      onClick={async () => {
        const v = await confirm({
          title: 'Reboot Jetson?',
          body: 'This drops the stream for ~30 s.',
          confirmLabel: 'Reboot',
          destructive,
        })
        onResolve(v)
      }}
    >
      fire
    </button>
  )
}

describe('useConfirm', () => {
  afterEach(() => vi.clearAllMocks())

  it('renders nothing until invoked', () => {
    render(
      <ConfirmProvider>
        <Trigger onResolve={() => {}} />
      </ConfirmProvider>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a dialog with the requested title + body when invoked', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={() => {}} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('Reboot Jetson?')).toBeInTheDocument()
    expect(screen.getByText(/drops the stream/i)).toBeInTheDocument()
  })

  it('resolves true when the confirm button is clicked', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={onResolve} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    await user.click(screen.getByRole('button', { name: 'Reboot' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(true))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves false when the cancel button is clicked', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={onResolve} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false))
  })

  it('resolves false when ESC is pressed', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={onResolve} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false))
  })

  it('resolves false when the backdrop is clicked', async () => {
    // iter-270 (accessibility-auditor A): backdrop changed from
    // role="button" to a div+onClick (aria-hidden). Look up by
    // data-testid since SR/keyboard intentionally skip it.
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={onResolve} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    await screen.findByRole('dialog')
    await user.click(screen.getByTestId('confirm-backdrop'))
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(false))
  })

  it('clicks inside the dialog content do not dismiss', async () => {
    const onResolve = vi.fn()
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Trigger onResolve={onResolve} />
      </ConfirmProvider>,
    )
    await user.click(screen.getByText('fire'))
    await user.click(screen.getByText('Reboot Jetson?'))
    expect(onResolve).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
