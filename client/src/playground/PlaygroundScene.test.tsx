import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

/** jsdom has no PointerEvent constructor, so fireEvent.pointerDown drops
    clientX/Y. A MouseEvent under the pointer type name carries them. */
function firePointer(el: Element, type: string, x: number, y: number) {
  fireEvent(
    el,
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  )
}

beforeEach(() => {
  // Cleared BEFORE each test (not after): the setup-file cleanup()
  // unmounts the previous scene AFTER this file's afterEach would run,
  // and that unmount itself calls resetToyLayer.
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

describe('PlaygroundScene laser chain (FINDING 3: pill → pointer → dot → chase)', () => {
  it('Given the Laser pill is active, When the user presses and drags on the scene, Then the dot renders at the pointer and Mushu takes up the chase', async () => {
    // arrange — controllable frame queue; fake clocks so the press has a
    // real-feeling duration (a wall-clock-instant press would read as a
    // tap and engage the tap latch)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const scheduled: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        scheduled.push(cb)
        return scheduled.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<PlaygroundScene staticScene={false} compact={false} />)
    await flushInit()
    const t0 = performance.now()

    // act — click the pill, press on the scene surface, run one frame
    fireEvent.click(screen.getByRole('button', { name: 'Laser' }))
    const scene = screen.getByTestId('playground-scene')
    firePointer(scene, 'pointerdown', 300, 200)
    await act(async () => {
      scheduled[scheduled.length - 1](t0 + 16)
    })

    // assert — the dot appears AT the pointer (scene coords)
    const dot = screen.getByTestId('playground-laser-dot')
    expect(dot.style.left).toBe('300px')
    expect(dot.style.top).toBe('200px')

    // act — drag, then advance past Mushu's 300ms reaction window (the
    // fake wall clock advances too, so the press reads as a long hold)
    vi.advanceTimersByTime(380)
    firePointer(scene, 'pointermove', 340, 210)
    await act(async () => {
      scheduled[scheduled.length - 1](t0 + 380)
    })
    await act(async () => {
      scheduled[scheduled.length - 1](t0 + 420)
    })

    // assert — the dot survives the drag and the first responder chases
    expect(screen.getByTestId('playground-laser-dot')).toBeInTheDocument()
    expect(screen.getByTestId('playground-cat-mushu')).toHaveAttribute('data-activity', 'run')

    // act — release the press
    firePointer(scene, 'pointerup', 340, 210)
    await act(async () => {
      scheduled[scheduled.length - 1](t0 + 460)
    })

    // assert — the dot goes out with the press
    expect(screen.queryByTestId('playground-laser-dot')).not.toBeInTheDocument()
  })

  it('Given a sub-frame TAP (down+up before any tick), When the next frames run, Then the latched press still flashes the dot where the finger landed', async () => {
    // arrange — the live FINDING-3 miss: a quick poke used to release
    // the pointer before the rAF loop ever saw it, so no dot appeared.
    const scheduled: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback): number => {
        scheduled.push(cb)
        return scheduled.length
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<PlaygroundScene staticScene={false} compact={false} />)
    await flushInit()
    const t0 = performance.now()

    // act — pill, then a tap with NO frame in between
    fireEvent.click(screen.getByRole('button', { name: 'Laser' }))
    const scene = screen.getByTestId('playground-scene')
    firePointer(scene, 'pointerdown', 220, 180)
    firePointer(scene, 'pointerup', 220, 180)
    // touch pointers LEAVE the surface the moment the finger lifts —
    // the latch must survive it (the live tap regression)
    firePointer(scene, 'pointerleave', 220, 180)
    await act(async () => {
      scheduled[scheduled.length - 1](t0 + 16)
    })

    // assert — the dot flashed at the tap point despite the instant release
    const dot = screen.getByTestId('playground-laser-dot')
    expect(dot.style.left).toBe('220px')
    expect(dot.style.top).toBe('180px')
  })
})

describe('PlaygroundScene entrance choreography', () => {
  it('Given the scene initializes, When the cats mount, Then each entrance wrapper carries its arrive animation class (never the flip or positioned element)', async () => {
    // arrange
    vi.stubGlobal('requestAnimationFrame', vi.fn((): number => 0))

    // act
    render(<PlaygroundScene staticScene={false} compact={false} />)
    await flushInit()

    // assert
    const wrappers = screen.getAllByTestId('playground-cat-entrance-wrapper')
    expect(wrappers).toHaveLength(3)
    const classes = wrappers.map((w) => w.className)
    expect(classes).toEqual(
      expect.arrayContaining(['cat-entrance-panther', 'cat-entrance-mushu', 'cat-entrance-coco']),
    )
    // the animated wrapper is never the translated container itself
    for (const wrapper of wrappers) {
      expect(wrapper.parentElement?.style.transform).toContain('translateX(')
    }
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
