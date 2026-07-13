import { afterEach, describe, expect, it } from 'vitest'
import { readNativeHealthMonitorStatus } from './nativeStatus'

describe('readNativeHealthMonitorStatus', () => {
  afterEach(() => {
    delete (window as Window & { HomeCamNative?: unknown }).HomeCamNative
  })

  it('returns the read-only native observer diagnostics when the bridge is valid', () => {
    ;(window as Window & { HomeCamNative?: unknown }).HomeCamNative = {
      getHealthMonitorStatus: () => JSON.stringify({
        v: 1,
        native_version: '1.2.3',
        last_check_ms: 100,
        next_check_ms: 200,
        last_reachable: true,
        consecutive_failures: 0,
        offline_notified: false,
        background_restricted: false,
        battery_optimization_exempt: true,
        notifications_allowed: true,
      }),
    }

    expect(readNativeHealthMonitorStatus()).toMatchObject({
      native_version: '1.2.3',
      last_reachable: true,
    })
  })

  it('fails closed for malformed or absent bridge data', () => {
    expect(readNativeHealthMonitorStatus()).toBeNull()
    ;(window as Window & { HomeCamNative?: unknown }).HomeCamNative = {
      getHealthMonitorStatus: () => '{not json',
    }
    expect(readNativeHealthMonitorStatus()).toBeNull()
  })
})
