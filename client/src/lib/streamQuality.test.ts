import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getStreamQuality,
  pathForQuality,
  resolveAutoQuality,
  setStreamQuality,
  whepUrlForPath,
  type ConnectionLike,
  type ResolvedQuality,
  type StreamQuality,
} from './streamQuality'

describe('resolveAutoQuality', () => {
  // Table-driven: every connection shape the Network Information API can
  // hand us, including the partial/absent cases (Safari, Firefox).
  const cases: Array<{
    name: string
    conn: ConnectionLike | undefined | null
    expected: ResolvedQuality
  }> = [
    {
      name: 'given saveData=true (overrides everything), then xs',
      conn: { saveData: true, effectiveType: '4g', type: 'wifi' },
      expected: 'xs',
    },
    {
      name: 'given a cellular link, then xs',
      conn: { type: 'cellular', effectiveType: '4g' },
      expected: 'xs',
    },
    {
      name: 'given effectiveType slow-2g, then xs',
      conn: { effectiveType: 'slow-2g' },
      expected: 'xs',
    },
    {
      name: 'given effectiveType 2g, then xs',
      conn: { effectiveType: '2g' },
      expected: 'xs',
    },
    {
      name: 'given effectiveType 3g, then sd',
      conn: { effectiveType: '3g' },
      expected: 'sd',
    },
    {
      name: 'given effectiveType 4g, then hq',
      conn: { effectiveType: '4g' },
      expected: 'hq',
    },
    {
      name: 'given a wifi link, then hq',
      conn: { type: 'wifi', effectiveType: '4g' },
      expected: 'hq',
    },
    {
      name: 'given an ethernet link, then hq',
      conn: { type: 'ethernet' },
      expected: 'hq',
    },
    {
      name: 'given an unknown/empty connection object, then hq',
      conn: {},
      expected: 'hq',
    },
    {
      name: 'given undefined (Network Information API missing), then hq',
      conn: undefined,
      expected: 'hq',
    },
    {
      name: 'given null, then hq',
      conn: null,
      expected: 'hq',
    },
  ]

  for (const { name, conn, expected } of cases) {
    it(name, () => {
      // arrange / act
      const got = resolveAutoQuality(conn)
      // assert
      expect(got).toBe(expected)
    })
  }
})

describe('pathForQuality', () => {
  it('given each fixed tier, then maps to the MediaMTX path', () => {
    // arrange / act / assert
    expect(pathForQuality('uhq')).toBe('cam_uhq')
    expect(pathForQuality('hq')).toBe('cam')
    expect(pathForQuality('sd')).toBe('cam_lq')
    expect(pathForQuality('xs')).toBe('cam_uq')
  })

  it('given auto on a wifi link, then resolves to the HQ path', () => {
    // arrange
    const conn: ConnectionLike = { type: 'wifi', effectiveType: '4g' }
    // act / assert
    expect(pathForQuality('auto', conn)).toBe('cam')
  })

  it('given auto on a cellular link, then resolves to the ultra-low path', () => {
    // arrange
    const conn: ConnectionLike = { type: 'cellular', effectiveType: '4g' }
    // act / assert
    expect(pathForQuality('auto', conn)).toBe('cam_uq')
  })

  it('given auto on a 3g link, then resolves to the data-saver path', () => {
    // arrange
    const conn: ConnectionLike = { effectiveType: '3g' }
    // act / assert
    expect(pathForQuality('auto', conn)).toBe('cam_lq')
  })

  it('given auto with no connection info, then resolves to the HQ path', () => {
    // arrange / act / assert
    expect(pathForQuality('auto', null)).toBe('cam')
  })

  // Multicam contract (docs/multicam_contract.md, 2026-07-07): the
  // rungs derive from the camera's registry `path` instead of the
  // hardcoded 'cam'. Default stays 'cam' so single-camera composition
  // is byte-identical (pinned by the tests above).

  it('Given a camera base path, When each fixed tier is resolved, Then the rungs derive from that path (multicam contract)', () => {
    // arrange — a second registry camera on MediaMTX path 'garage'.
    const basePath = 'garage'

    // act / assert
    expect(pathForQuality('hq', null, basePath)).toBe('garage')
    expect(pathForQuality('sd', null, basePath)).toBe('garage_lq')
    expect(pathForQuality('xs', null, basePath)).toBe('garage_uq')
  })

  it('Given a camera base path on a cellular link, When auto resolves, Then the ultra-low rung derives from that path (multicam contract)', () => {
    // arrange
    const conn: ConnectionLike = { type: 'cellular', effectiveType: '4g' }

    // act / assert
    expect(pathForQuality('auto', conn, 'garage')).toBe('garage_uq')
  })
})

describe('whepUrlForPath', () => {
  it('given each tier path, then composes the same-origin /whep URL', () => {
    // arrange — jsdom origin
    const origin = window.location.origin
    // act / assert
    expect(whepUrlForPath('cam')).toBe(`${origin}/whep/cam/whep`)
    expect(whepUrlForPath('cam_lq')).toBe(`${origin}/whep/cam_lq/whep`)
    expect(whepUrlForPath('cam_uq')).toBe(`${origin}/whep/cam_uq/whep`)
  })

  it('never bypasses the same-origin media proxy for an HTTP origin', () => {
    expect(whepUrlForPath('cam', {
      protocol: 'http:',
      hostname: '10.0.0.9',
      origin: 'http://10.0.0.9:8000',
    })).toBe('http://10.0.0.9:8000/whep/cam/whep')
  })
})

describe('stream quality persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })
  afterEach(() => {
    window.localStorage.clear()
  })

  it('given no stored value, when read, then defaults to auto', () => {
    // arrange — storage empty (cleared in beforeEach)
    // act
    const got = getStreamQuality()
    // assert
    expect(got).toBe('auto')
  })

  it('given a value is set, when read back, then round-trips', () => {
    // arrange / act
    for (const q of ['auto', 'uhq', 'hq', 'sd', 'xs'] as StreamQuality[]) {
      setStreamQuality(q)
      // assert
      expect(getStreamQuality()).toBe(q)
    }
  })

  it('given a junk stored value, when read, then falls back to auto', () => {
    // arrange
    window.localStorage.setItem('homecam:streamQuality', 'ludicrous')
    // act
    const got = getStreamQuality()
    // assert
    expect(got).toBe('auto')
  })

  it('given an empty stored value, when read, then falls back to auto', () => {
    // arrange
    window.localStorage.setItem('homecam:streamQuality', '')
    // act / assert
    expect(getStreamQuality()).toBe('auto')
  })
})
