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

  it('Given navigator.share is available, When Share is tapped, Then it shares an absolute, origin-qualified snapshot link (painfix wave B #5)', async () => {
    // arrange
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: share,
    })
    const user = userEvent.setup()
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // act
    await user.click(screen.getByRole('button', { name: /^share$/i }))

    // assert
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${window.location.origin}/snapshots/snap_1.jpg` }),
    )
    Reflect.deleteProperty(navigator, 'share')
  })

  it('Given navigator.share is unavailable, When Share is tapped, Then it falls back to copying the link to the clipboard (painfix wave B #5)', async () => {
    // arrange — userEvent.setup() installs its OWN clipboard stub, so
    // define ours AFTER setup() or it gets clobbered.
    Reflect.deleteProperty(navigator, 'share')
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // act
    await user.click(screen.getByRole('button', { name: /^share$/i }))

    // assert
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/snapshots/snap_1.jpg`,
    )
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

  it('closes via backdrop click', () => {
    // iter-356.63 (Slice D a11y): backdrop is now a div+onClick
    // (aria-hidden + no button role), so AT users skip it but
    // mouse/touch users still get backdrop-click-to-close.
    const onClose = vi.fn()
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('snapshot-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('given the dialog renders, when AT users query the backdrop, then it has no accessible role and is aria-hidden (iter-356.63: Slice D a11y — was a Button that VO swipe landed on first)', () => {
    // arrange
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // act
    const backdrop = screen.getByTestId('snapshot-backdrop')

    // assert
    expect(backdrop.getAttribute('aria-hidden')).toBe('true')
    expect(backdrop.getAttribute('role')).toBeNull()
    expect(backdrop.tagName).toBe('DIV')
    expect(
      screen.queryByRole('button', { name: /dismiss snapshot/i }),
    ).not.toBeInTheDocument()
  })

  it('given the dialog opens, when focus management runs, then the Close button is focused (iter-356.63: Slice D a11y — focus capture)', () => {
    // arrange / act
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // assert
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^close$/i }),
    )
  })

  it('given the dialog closes, when the component unmounts, then focus is restored to the previously-focused element (iter-356.63: Slice D a11y — focus restore)', () => {
    // arrange — simulate the Capture button as the trigger that
    // owned focus before opening the preview.
    const trigger = document.createElement('button')
    trigger.textContent = 'Capture'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    // act
    const { unmount } = render(
      <SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />,
    )
    expect(document.activeElement).not.toBe(trigger) // moved into dialog
    unmount()

    // assert
    expect(document.activeElement).toBe(trigger)
    document.body.removeChild(trigger)
  })

  it('given the Save and Close buttons render, when measured, then both meet the 44 px touch-target floor (iter-356.63: Slice D a11y — hit-target bumps)', () => {
    // arrange / act
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // assert
    expect(screen.getByRole('link', { name: /save/i }).className).toMatch(
      /min-h-\[44px\]/,
    )
    expect(screen.getByRole('button', { name: /^share$/i }).className).toMatch(
      /min-h-\[44px\]/,
    )
    expect(screen.getByRole('button', { name: /^close$/i }).className).toMatch(
      /min-h-\[44px\]/,
    )
  })

  it('given the light Sunroom theme, when the buttons render over the black viewer, then both carry explicit text-white (over-image dark surface must not inherit ink page text)', () => {
    // arrange / act
    render(<SnapshotPreview url="/snapshots/snap_1.jpg" onClose={() => {}} />)

    // assert — the viewer is intentionally dark; inherited page text
    // is now dark ink and would vanish on the white/10 fills.
    expect(screen.getByRole('link', { name: /save/i }).className).toMatch(
      /\btext-white\b/,
    )
    expect(screen.getByRole('button', { name: /^close$/i }).className).toMatch(
      /\btext-white\b/,
    )
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
