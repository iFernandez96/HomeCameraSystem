import { describe, expect, it } from 'vitest'
import { HttpError } from './api'
import {
  formatAge,
  formatBytes,
  formatError,
  formatSecondsAgo,
  formatTemp,
  formatUptime,
} from './format'

describe('formatUptime', () => {
  it('renders a 0-second uptime as "0s"', () => {
    expect(formatUptime(0)).toBe('0s')
  })

  it('floors fractional seconds (59.9 → 59s)', () => {
    expect(formatUptime(59.9)).toBe('59s')
  })

  it('crosses to minutes at 60s exactly', () => {
    expect(formatUptime(60)).toBe('1m')
  })

  it('crosses to hours+minutes at 3600s exactly', () => {
    expect(formatUptime(3600)).toBe('1h 0m')
  })

  it('renders 7325 (2h 2m 5s) as "2h 2m"', () => {
    // Pinned by the existing Settings test — boundary expectation.
    expect(formatUptime(7325)).toBe('2h 2m')
  })

  it('crosses to days+hours at 86400s exactly', () => {
    expect(formatUptime(86400)).toBe('1d 0h')
  })

  it('renders multi-day uptime', () => {
    expect(formatUptime(86400 * 3 + 3600 * 5)).toBe('3d 5h')
  })
})

describe('formatAge', () => {
  it('renders sub-5-second ages as "just now"', () => {
    expect(formatAge(0)).toBe('just now')
    expect(formatAge(4.999)).toBe('just now')
  })

  it('renders seconds at the 5-second threshold', () => {
    expect(formatAge(5)).toBe('5s')
  })

  it('crosses to minutes at 60s', () => {
    expect(formatAge(60)).toBe('1m')
  })

  it('crosses to hours at 3600s', () => {
    expect(formatAge(3600)).toBe('1h')
  })

  it('does not break out into days — just keeps incrementing hours', () => {
    // Quick-glance UX: a worker that's been "X hours ago" doesn't
    // need a day-level breakdown; the OFFLINE pill is the actionable
    // signal.
    expect(formatAge(86400 * 2)).toBe('48h')
  })
})

describe('formatSecondsAgo', () => {
  it('Given a null age, When formatSecondsAgo runs, Then it returns never', () => {
    // arrange / act / assert
    expect(formatSecondsAgo(null)).toBe('never')
  })

  it('Given a numeric age, When formatSecondsAgo runs, Then it appends ago', () => {
    // arrange / act / assert
    expect(formatSecondsAgo(60)).toBe('1m ago')
  })
})

describe('formatTemp', () => {
  it('Given null temperature, When formatTemp runs, Then it returns an em-dash', () => {
    // arrange / act / assert
    expect(formatTemp(null)).toBe('—')
  })

  it('Given a numeric temperature, When formatTemp runs, Then it rounds and adds Celsius', () => {
    // arrange / act / assert
    expect(formatTemp(70.4)).toBe('70 °C')
  })
})

describe('formatError (iter-166)', () => {
  it('returns Error.message instead of "Error: <msg>" prefix', () => {
    // String(new Error('boom')) gives 'Error: boom'. We prefer the
    // bare message so the rendered text reads naturally and doesn't
    // look like a stack trace to the user.
    expect(formatError(new Error('network down'))).toBe('network down')
  })

  it('surfaces HttpError.message including the status inline', () => {
    // HttpError.message is shaped as `${path} ${status}${detail}` so
    // the formatted string already carries the diagnostic context
    // (path + status code + body excerpt) without needing the
    // helper to know about HttpError specifically.
    const e = new HttpError('/api/events', 503, ': server unreachable')
    expect(formatError(e)).toBe('/api/events 503: server unreachable')
  })

  it('falls back to String(x) for non-Error throwables', () => {
    // `throw 'string-typed-error'` is bad style but legal. `throw {}`
    // is the same. The helper must not crash on these and should
    // produce *something* a human can look at.
    expect(formatError('plain string')).toBe('plain string')
    expect(formatError(42)).toBe('42')
    expect(formatError(null)).toBe('null')
    expect(formatError(undefined)).toBe('undefined')
    expect(formatError({ foo: 'bar' })).toBe('[object Object]')
  })
})

describe('formatBytes (iter-214)', () => {
  it('renders bytes under 1000 with B suffix', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
  })

  it('crosses to KB at 1000', () => {
    expect(formatBytes(1000)).toBe('1.0 KB')
    expect(formatBytes(12_500)).toBe('12.5 KB')
  })

  it('crosses to MB at 1_000_000', () => {
    expect(formatBytes(1_000_000)).toBe('1.0 MB')
    expect(formatBytes(20_000_000)).toBe('20.0 MB')
  })

  it('crosses to GB at 1_000_000_000', () => {
    expect(formatBytes(1_000_000_000)).toBe('1.0 GB')
    expect(formatBytes(7_500_000_000)).toBe('7.5 GB')
  })

  it('returns em-dash for non-finite or negative inputs', () => {
    expect(formatBytes(NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Infinity)).toBe('—')
  })
})
