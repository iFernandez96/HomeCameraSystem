import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SPEED_RATES, VideoPlayer } from './VideoPlayer'

// Native-controls era (2026-07-02): the custom YouTube-style bar was
// replaced by the browser's own controls after repeated touch-
// interaction bugs (unreachable fullscreen, dead taps). These tests
// pin the wrapper's contract: native controls ON, overlay isolated
// behind pointer-events-none, and the speed/repeat strip — the two
// features the native bar lacks.

function renderPlayer(extra: Partial<Parameters<typeof VideoPlayer>[0]> = {}) {
  return render(
    <VideoPlayer src="/clip.mp4" ariaLabel="Test clip" {...extra} />,
  )
}

describe('VideoPlayer (native-controls wrapper)', () => {
  it('Given the player renders, Then the <video> carries NATIVE controls (the whole point of the rewrite)', () => {
    // arrange / act
    renderPlayer()

    // assert
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    expect(video.tagName).toBe('VIDEO')
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('playsinline')
  })

  it('Given nativeControls is false, When the player renders, Then the <video> does not show browser media chrome', () => {
    // arrange / act
    renderPlayer({ nativeControls: false })

    // assert
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    expect(video).not.toHaveAttribute('controls')
  })

  it('Given the speed set, When offered, Then it is the eight rates .25×–4×', async () => {
    // arrange / act / assert
    expect(SPEED_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4])
    renderPlayer()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Playback settings' }))
    const select = screen.getByLabelText('Playback speed')
    expect(select.querySelectorAll('option')).toHaveLength(8)
  })

  it('Given the speed select, When a rate is chosen, Then it applies to video.playbackRate', async () => {
    // arrange
    const user = userEvent.setup()
    renderPlayer()
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement

    // act
    await user.click(screen.getByRole('button', { name: 'Playback settings' }))
    await user.selectOptions(screen.getByLabelText('Playback speed'), '2')

    // assert
    expect(video.playbackRate).toBe(2)
  })

  it('Given the repeat button, When toggled, Then the video loops and aria-pressed tracks it', async () => {
    // arrange
    const user = userEvent.setup()
    renderPlayer()
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    await user.click(screen.getByRole('button', { name: 'Playback settings' }))
    const repeat = screen.getByRole('menuitemcheckbox', { name: 'Repeat' })
    expect(repeat).toHaveAttribute('aria-checked', 'false')
    expect(video).not.toHaveAttribute('loop')

    // act
    await user.click(repeat)

    // assert
    expect(repeat).toHaveAttribute('aria-checked', 'true')
    expect(video).toHaveAttribute('loop')
  })

  it('Given the fullscreen button, When clicked, Then it expands the player and requests fullscreen on the container', async () => {
    // arrange
    const user = userEvent.setup()
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    const original = HTMLElement.prototype.requestFullscreen
    HTMLElement.prototype.requestFullscreen = requestFullscreen

    try {
      renderPlayer()

      // act
      await user.click(screen.getByRole('button', { name: /enter fullscreen/i }))

      // assert
      expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: 'hide' })
      expect(screen.getByLabelText('Test clip').closest('[data-app-fullscreen="true"]')).not.toBeNull()
      expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument()
    } finally {
      if (original) HTMLElement.prototype.requestFullscreen = original
      else delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen
    }
  })

  it('Given an overlay, When rendered, Then it sits in a pointer-events-none layer (can never eat a control tap)', () => {
    // arrange / act
    renderPlayer({
      overlay: <canvas data-testid="overlay-canvas" />,
    })

    // assert
    const canvas = screen.getByTestId('overlay-canvas')
    const wrapper = canvas.parentElement!
    expect(wrapper.className).toContain('pointer-events-none')
    expect(wrapper.className).toContain('absolute')
  })

  it('Given onVideoEl, When mounted, Then the consumer receives the <video> element (and null on unmount)', () => {
    // arrange
    const onVideoEl = vi.fn()

    // act
    const { unmount } = renderPlayer({ onVideoEl })

    // assert
    expect(onVideoEl).toHaveBeenCalledWith(expect.any(HTMLVideoElement))
    unmount()
    expect(onVideoEl).toHaveBeenLastCalledWith(null)
  })

  // ─── Real-device bug fix (Firefox Android, ClipModal black-pane bug):
  // an unstarted <video> has zero intrinsic size. `poster` gives it a
  // real first frame before metadata loads; `fillHeight` lets a
  // consumer (ClipModal) stretch the player into a fixed-aspect frame
  // instead of relying on the video's own (possibly-zero) size.

  it('Given a poster prop, When the player renders, Then the <video> carries it so a frame is visible before playback starts', () => {
    // arrange / act
    renderPlayer({ poster: '/snapshots/thumb_1.jpg' })

    // assert
    const video = screen.getByLabelText('Test clip')
    expect(video).toHaveAttribute('poster', '/snapshots/thumb_1.jpg')
  })

  it('Given no poster prop, When the player renders, Then the <video> has no poster attribute (default unchanged)', () => {
    // arrange / act
    renderPlayer()

    // assert
    const video = screen.getByLabelText('Test clip')
    expect(video).not.toHaveAttribute('poster')
  })

  it('Given fillHeight, When the player renders, Then the video wrapper carries flex-1 so it stretches to fill a parent-provided height', () => {
    // arrange / act
    renderPlayer({ fillHeight: true })

    // assert
    const video = screen.getByLabelText('Test clip')
    expect(video.parentElement?.className).toContain('flex-1')
  })

  it('Given fillHeight is omitted, When the player renders, Then the video wrapper does NOT carry flex-1 (other consumers keep content-based sizing)', () => {
    // arrange / act
    renderPlayer()

    // assert
    const video = screen.getByLabelText('Test clip')
    expect(video.parentElement?.className).not.toContain('flex-1')
  })

  it('Given playback settings are opened, Then settings controls carry the 44px touch-target floor', async () => {
    // arrange / act
    const user = userEvent.setup()
    renderPlayer()
    await user.click(screen.getByRole('button', { name: 'Playback settings' }))

    // assert
    expect(screen.getByLabelText('Playback speed').className).toMatch(
      /min-h-\[44px\]/,
    )
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Repeat' }).className,
    ).toMatch(/min-h-\[44px\]/)
  })
})
