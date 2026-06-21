import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VideoPlayer, SPEED_RATES } from './VideoPlayer'

describe('VideoPlayer', () => {
  it('given the player renders, then the video and control-bar buttons are present', () => {
    // arrange / act
    render(<VideoPlayer src="/clip.mp4" ariaLabel="Test clip" />)
    // assert — custom control bar (native <video controls> is off).
    expect(screen.getByLabelText('Test clip')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /playback speed/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Repeat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument()
  })

  it('given the speed set, when offered, then it is the eight rates .25×–4×', () => {
    // arrange / act / assert
    expect(SPEED_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4])
  })

  it('given the speed menu, when a rate is chosen, then it opens YouTube-style, marks the choice, applies it to video, and closes', async () => {
    // arrange
    render(<VideoPlayer src="/clip.mp4" ariaLabel="Test clip" />)
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    expect(video.playbackRate).toBe(1)
    const user = userEvent.setup()

    // act — open the settings/speed menu.
    await user.click(screen.getByRole('button', { name: /playback speed/i }))

    // assert — a menu with the current rate checked.
    const menu = screen.getByRole('menu', { name: /playback speed/i })
    expect(menu).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'Normal' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    // act — pick 4×.
    await user.click(screen.getByRole('menuitemradio', { name: '4×' }))

    // assert — applied to the element and the menu dismisses.
    expect(video.playbackRate).toBe(4)
    expect(
      screen.queryByRole('menu', { name: /playback speed/i }),
    ).not.toBeInTheDocument()
  })

  it('given the repeat button, when toggled, then the video loops', async () => {
    // arrange
    render(<VideoPlayer src="/clip.mp4" ariaLabel="Test clip" />)
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    expect(video.loop).toBe(false)
    const user = userEvent.setup()
    // act
    await user.click(screen.getByRole('button', { name: 'Repeat' }))
    // assert
    expect(video.loop).toBe(true)
  })

  it('given a known duration, when the scrubber is dragged, then video.currentTime follows', () => {
    // arrange — jsdom doesn't drive media time, so back currentTime/duration.
    render(<VideoPlayer src="/clip.mp4" ariaLabel="Test clip" />)
    const video = screen.getByLabelText('Test clip') as HTMLVideoElement
    Object.defineProperty(video, 'duration', { value: 100, configurable: true })
    let ct = 0
    Object.defineProperty(video, 'currentTime', {
      get: () => ct,
      set: (x: number) => {
        ct = x
      },
      configurable: true,
    })
    fireEvent.loadedMetadata(video)

    // act — move the seek slider to 42.
    fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), {
      target: { value: '42' },
    })

    // assert
    expect(video.currentTime).toBe(42)
  })

  it('given onVideoEl, when mounted, then the consumer receives the <video> element', () => {
    // arrange
    let el: HTMLVideoElement | null = null
    // act
    render(
      <VideoPlayer
        src="/clip.mp4"
        ariaLabel="Test clip"
        onVideoEl={(v) => {
          el = v
        }}
      />,
    )
    // assert — ClipModal relies on this to bind its bbox overlay.
    expect(el).toBeInstanceOf(HTMLVideoElement)
  })
})
