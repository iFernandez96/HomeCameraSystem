import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SnapshotPreview } from './SnapshotPreview'

describe('SnapshotPreview', () => {
  it('renders the snapshot image', () => {
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)
    const img = screen.getByRole('img', { name: /snapshot of the camera/i })
    expect(img).toHaveAttribute('src', '/snapshots/snap_1.jpg')
  })

  it('exposes a download link pointing at the snapshot', () => {
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)
    const link = screen.getByRole('link', { name: /save/i })
    expect(link).toHaveAttribute('href', '/snapshots/snap_1.jpg')
    expect(link).toHaveAttribute('download')
  })

  it('closes via the Close button', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: /^close$/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via ESC', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes via backdrop click', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: /dismiss snapshot/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses dialog semantics', () => {
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('shows a graceful fallback when the image fails to load', () => {
    render(
      <SnapshotPreview url="/snapshots/missing.jpg" onClose={() => {}} />,
    )
    const img = screen.getByRole('img', { name: /snapshot of the camera/i })
    // Simulate a 404 by firing the img element's `error` event.
    fireEvent.error(img)
    expect(screen.getByText(/snapshot unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument()
    // The original <img> is gone but the Save link survives so the
    // user can still try to download / share the URL.
    expect(screen.queryByRole('img', { name: /snapshot of the camera/i })).not
      .toBeInTheDocument()
    expect(screen.getByRole('link', { name: /save/i })).toHaveAttribute(
      'href',
      '/snapshots/missing.jpg',
    )
  })
})
