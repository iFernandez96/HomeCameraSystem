import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useCatsEnabled } from './catPref'

/**
 * iter-356.10 — coverage for the cat-pref hook (Frank #5).
 */

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('useCatsEnabled', () => {
  it('given no localStorage value, when the hook mounts, then enabled defaults to true', () => {
    // arrange — localStorage cleared in beforeEach

    // act
    const { result } = renderHook(() => useCatsEnabled())

    // assert
    expect(result.current[0]).toBe(true)
  })

  it('given localStorage["homecam:cats"]="off", when the hook mounts, then enabled is false', () => {
    // arrange
    window.localStorage.setItem('homecam:cats', 'off')

    // act
    const { result } = renderHook(() => useCatsEnabled())

    // assert
    expect(result.current[0]).toBe(false)
  })

  it('given the setter is called with false, when invoked, then localStorage persists "off" and state flips', () => {
    // arrange
    const { result } = renderHook(() => useCatsEnabled())
    expect(result.current[0]).toBe(true)

    // act
    act(() => {
      result.current[1](false)
    })

    // assert
    expect(result.current[0]).toBe(false)
    expect(window.localStorage.getItem('homecam:cats')).toBe('off')
  })

  it('given the setter is called with true after off, when invoked, then localStorage persists "on" and state flips', () => {
    // arrange
    window.localStorage.setItem('homecam:cats', 'off')
    const { result } = renderHook(() => useCatsEnabled())
    expect(result.current[0]).toBe(false)

    // act
    act(() => {
      result.current[1](true)
    })

    // assert
    expect(result.current[0]).toBe(true)
    expect(window.localStorage.getItem('homecam:cats')).toBe('on')
  })

  it('given two hook instances, when one writes, then both reflect the new value via cross-tab event (iter-356.10)', () => {
    // arrange — two hooks (simulating two open tabs / two consumers
    // on the same device).
    const a = renderHook(() => useCatsEnabled())
    const b = renderHook(() => useCatsEnabled())
    expect(a.result.current[0]).toBe(true)
    expect(b.result.current[0]).toBe(true)

    // act — disable on hook A
    act(() => {
      a.result.current[1](false)
    })

    // assert — hook B picks up the change via the homecam:cats-pref
    // window event dispatched in writePref()
    expect(a.result.current[0]).toBe(false)
    expect(b.result.current[0]).toBe(false)
  })
})
