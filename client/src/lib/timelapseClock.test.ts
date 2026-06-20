import { describe, it, expect } from 'vitest'
import {
  formatClock,
  isUsableManifest,
  reelTimeToCaptureTs,
} from './timelapseClock'
import type { TimelapseManifest, TimelapseSegment } from './api'

describe('reelTimeToCaptureTs', () => {
  const segments: TimelapseSegment[] = [
    { offset_s: 0, capture_ts: 1000 },
    { offset_s: 10, capture_ts: 2000 },
    { offset_s: 25, capture_ts: 3000 },
  ]

  it('given a playhead inside the first segment, when mapped, then returns capture_ts plus elapsed', () => {
    // arrange + act
    const ts = reelTimeToCaptureTs(segments, 4)
    // assert — 1000 + (4 - 0)
    expect(ts).toBe(1004)
  })

  it('given a playhead inside a later segment, when mapped, then uses that segment base', () => {
    // arrange + act
    const ts = reelTimeToCaptureTs(segments, 12)
    // assert — segment offset 10 → 2000 + (12 - 10)
    expect(ts).toBe(2002)
  })

  it('given a playhead on a segment boundary, when mapped, then picks the segment starting there', () => {
    // arrange + act
    const ts = reelTimeToCaptureTs(segments, 25)
    // assert — boundary belongs to the new segment (offset 25 → 3000)
    expect(ts).toBe(3000)
  })

  it('given a playhead past the last segment, when mapped, then extends from the last base', () => {
    // arrange + act
    const ts = reelTimeToCaptureTs(segments, 40)
    // assert — 3000 + (40 - 25)
    expect(ts).toBe(3015)
  })

  it('given an empty manifest, when mapped, then returns null so the overlay hides', () => {
    // arrange + act + assert
    expect(reelTimeToCaptureTs([], 5)).toBeNull()
  })

  it('given a non-finite or negative currentTime, when mapped, then returns null', () => {
    // arrange + act + assert
    expect(reelTimeToCaptureTs(segments, Number.NaN)).toBeNull()
    expect(reelTimeToCaptureTs(segments, -1)).toBeNull()
  })
})

describe('isUsableManifest', () => {
  it('given a v1 manifest with segments, when checked, then true', () => {
    // arrange
    const m: TimelapseManifest = {
      v: 1,
      date: '2026-06-15',
      segments: [{ offset_s: 0, capture_ts: 1 }],
    }
    // act + assert
    expect(isUsableManifest(m)).toBe(true)
  })

  it('given null, empty-segments, or a future schema version, when checked, then false', () => {
    // arrange + act + assert
    expect(isUsableManifest(null)).toBe(false)
    expect(isUsableManifest(undefined)).toBe(false)
    expect(isUsableManifest({ v: 1, date: 'x', segments: [] })).toBe(false)
    expect(
      isUsableManifest({
        v: 2,
        date: 'x',
        segments: [{ offset_s: 0, capture_ts: 1 }],
      } as TimelapseManifest),
    ).toBe(false)
  })
})

describe('formatClock', () => {
  it('given an epoch instant, when formatted, then zero-padded local HH:MM:SS', () => {
    // arrange — build the epoch from LOCAL components so the assertion is
    // timezone-independent (the value round-trips through the same local TZ).
    const d = new Date(2026, 5, 15, 9, 5, 3)
    // act
    const s = formatClock(d.getTime() / 1000)
    // assert
    expect(s).toBe('09:05:03')
  })
})
