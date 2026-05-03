import { describe, expect, it } from 'vitest'
import { nextRovingIndex } from './a11y'

// iter-345: pin the WAI-ARIA radiogroup keyboard-nav math.
// Both iter-335 (ClipModal speed pills) + iter-339 (Events filter
// chips) consume this helper; their integration tests pin the
// React/DOM behavior. These tests pin the pure index math.

describe('nextRovingIndex', () => {
  it('given ArrowRight at idx 0 of 3, when next is computed, then returns 1', () => {
    // arrange / act
    const next = nextRovingIndex('ArrowRight', 0, 3)

    // assert
    expect(next).toBe(1)
  })

  it('given ArrowRight at last idx, when next is computed, then wraps to 0', () => {
    // arrange / act
    const next = nextRovingIndex('ArrowRight', 2, 3)

    // assert
    expect(next).toBe(0)
  })

  it('given ArrowLeft at idx 0, when next is computed, then wraps to len-1', () => {
    // arrange / act
    const next = nextRovingIndex('ArrowLeft', 0, 3)

    // assert
    expect(next).toBe(2)
  })

  it('given ArrowDown, when next is computed, then behaves identically to ArrowRight (vertical alias)', () => {
    // arrange / act
    const next = nextRovingIndex('ArrowDown', 0, 3)

    // assert
    expect(next).toBe(1)
  })

  it('given ArrowUp, when next is computed, then behaves identically to ArrowLeft (vertical alias)', () => {
    // arrange / act
    const next = nextRovingIndex('ArrowUp', 1, 3)

    // assert
    expect(next).toBe(0)
  })

  it('given Home key, when next is computed, then returns 0 (jump to first)', () => {
    // arrange / act
    const next = nextRovingIndex('Home', 2, 3)

    // assert
    expect(next).toBe(0)
  })

  it('given End key, when next is computed, then returns len-1 (jump to last)', () => {
    // arrange / act
    const next = nextRovingIndex('End', 0, 3)

    // assert
    expect(next).toBe(2)
  })

  it('given a non-navigation key, when next is computed, then returns null (caller should let event bubble)', () => {
    // arrange / act
    const tabResult = nextRovingIndex('Tab', 0, 3)
    const enterResult = nextRovingIndex('Enter', 0, 3)
    const aResult = nextRovingIndex('a', 0, 3)

    // assert
    expect(tabResult).toBeNull()
    expect(enterResult).toBeNull()
    expect(aResult).toBeNull()
  })

  it('given an empty radiogroup (len=0), when any key is computed, then returns null (no division-by-zero)', () => {
    // arrange / act
    const right = nextRovingIndex('ArrowRight', 0, 0)
    const home = nextRovingIndex('Home', 0, 0)

    // assert
    expect(right).toBeNull()
    expect(home).toBeNull()
  })
})
