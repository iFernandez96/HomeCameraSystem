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

  it('Given the speed set, When offered, Then it is the eight rates .25×–4×', () => {
    // arrange / act / assert
    expect(SPEED_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4])
    renderPlayer()
    const select = screen.getByLabelText('Playback speed')
    expect(select.querySelectorAll('option')).toHaveLength(8)
  })

  it('Given the speed select, When a rate is chosen, Then it applies to video.playbackRate', async () => {
    // arrange
    const user = userEvent.setup()
    renderPlayer()
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement

    // act
    await user.selectOptions(screen.getByLabelText('Playback speed'), '2')

    // assert
    expect(video.playbackRate).toBe(2)
  })

  it('Given the repeat button, When toggled, Then the video loops and aria-pressed tracks it', async () => {
    // arrange
    const user = userEvent.setup()
    renderPlayer()
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    const repeat = screen.getByRole('button', { name: 'Repeat' })
    expect(repeat).toHaveAttribute('aria-pressed', 'false')
    expect(video).not.toHaveAttribute('loop')

    // act
    await user.click(repeat)

    // assert
    expect(repeat).toHaveAttribute('aria-pressed', 'true')
    expect(video).toHaveAttribute('loop')
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
})
