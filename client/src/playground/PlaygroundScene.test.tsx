import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { PlaygroundScene } from './PlaygroundScene'
import { resetToyLayer } from './toyLayer'

// Wrap the toy layer so unmount hygiene is observable; everything else
// passes through untouched (the real brain still runs).
vi.mock('./toyLayer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./toyLayer')>()
  return { ...mod, resetToyLayer: vi.fn(mod.resetToyLayer) }
})

async function flushInit() {
  // The scene initializes its state on a microtask (measure after paint).
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  // Cleared BEFORE each test (not after): the setup-file cleanup()
  // unmounts the previous scene AFTER this file's afterEach would run,
  // and that unmount itself calls resetToyLayer.
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaygroundScene static diorama (perf-preference gate)', () => {
  it('Given reduced motion, When the scene renders, Then the cats pose at home, no toolbar shows, and no animation frame is EVER scheduled', async () => {
    // arrange
    const rafSpy = vi.fn((): number => 0)
    vi.stubGlobal('requestAnimationFrame', rafSpy)

    // act
    render(<PlaygroundScene staticScene={true} compact={false} />)
    await flushInit()

    // assert — static marker + three posed cats at their home anchors
    expect(screen.getByTestId('playground-scene')).toHaveAttribute('data-motion', 'static')
    expect(screen.getByTestId('playground-cat-panther')).toHaveAttribute('data-activity', 'perch')
    expect(screen.getByTestId('playground-cat-mushu')).toHaveAttribute('data-activity', 'sit')
    expect(screen.getByTestId('playground-cat-coco')).toHaveAttribute('data-activity', 'loaf')
    expect(screen.queryByRole('group', { name: 'Toys' })).not.toBeInTheDocument()
    expect(rafSpy).not.toHaveBeenCalled()
  })
})

describe('PlaygroundScene rAF ownership', () => {
  it('Given an animated scene, When it mounts and unmounts, Then the loop starts once, is cancelled on teardown, and the toy layer memory resets', async () => {
    // arrange — controllable frame queue
    let nextRafId = 1
    const scheduled: FrameRequestCallback[] = []
    const rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      scheduled.push(cb)
      return nextRafId++
    })
    const cancelSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)

    // act — mount, let the state initialize, drive one frame
    const { unmount } = render(<PlaygroundScene staticScene={false} compact={false} />)
    await flushInit()
    expect(rafSpy).toHaveBeenCalledTimes(1)
    await act(async () => {
      scheduled[0](performance.now())
    })

    // assert — the frame re-armed the loop and the world is live
    expect(rafSpy).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('group', { name: 'Toys' })).toBeInTheDocument()
    expect(screen.getByTestId('playground-scene')).toHaveAttribute('data-motion', 'animated')

    // act — teardown
    unmount()

    // assert — the pending frame is cancelled and module memory resets
    expect(cancelSpy).toHaveBeenCalledWith(2)
    expect(vi.mocked(resetToyLayer)).toHaveBeenCalledTimes(1)
  })

  it('Given the tab hides and returns, When visibility flips, Then the loop pauses stepping without leaking listeners after unmount', async () => {
    // arrange
    const scheduled: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        scheduled.push(cb)
        return scheduled.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    // act
    const { unmount } = render(<PlaygroundScene staticScene={false} compact={false} />)
    await flushInit()
    unmount()

    // assert — the visibilitychange listener is symmetric
    const added = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange').length
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'visibilitychange').length
    expect(added).toBeGreaterThan(0)
    expect(removed).toBe(added)
  })
})
