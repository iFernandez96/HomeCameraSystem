import { describe, expect, it } from 'vitest'
import type { ServerStatus } from './types'
import { powerDisplay } from './power'

function status(over: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ok: true,
    uptime_s: 60,
    camera: 'ok',
    detection_active: true,
    worker_alive: true,
    worker_last_seen_s: 1,
    worker_metrics: null,
    power_sample_age_s: null,
    cpu_temp_c: 45,
    gpu_temp_c: 44,
    cpu_freq_pct: 100,
    load_avg: [0.1, 0.1, 0.1],
    memory_used_mb: 1000,
    memory_total_mb: 2000,
    disk_free_gb: 20,
    fps: 5,
    push_subs_count: 0,
    seconds_since_last_frame: 1,
    camera_label: 'Front Door',
    audio_enabled: false,
    ...over,
  }
}

describe('powerDisplay', () => {
  it('Given detection is offline, Then power telemetry names its actual dependency without claiming the camera is offline', () => {
    expect(powerDisplay(status({ worker_alive: false }))).toEqual({
      state: 'offline',
      compact: 'Power —',
      detail: 'Power telemetry unavailable while detection is offline',
    })
  })

  it('Given the Nano has no sensor, Then it asks for hardware instead of estimating watts', () => {
    expect(powerDisplay(status({ worker_metrics: { power_sensor_status: 0 } }))).toEqual({
      state: 'unavailable',
      compact: 'Power —',
      detail: 'External power sensor needed',
    })
  })

  it('Given a fresh real sample, Then it formats watts, volts, and amps', () => {
    const display = powerDisplay(status({
      power_sample_age_s: 2,
      worker_metrics: {
        power_sensor_status: 1,
        power_watts: 6.287,
        power_volts: 5.03,
        power_amps: 1.25,
      },
    }))
    expect(display.compact).toBe('Power 6.3 W')
    expect(display.detail).toBe('6.29 W · 5.03 V · 1.25 A')
  })

  it('Given the last sample is old, Then it never presents the value as live', () => {
    const display = powerDisplay(status({
      power_sample_age_s: 16,
      worker_metrics: {
        power_sensor_status: 1,
        power_watts: 6.2,
        power_volts: 5,
        power_amps: 1.24,
      },
    }))
    expect(display.state).toBe('stale')
    expect(display.compact).toBe('Power stale')
  })

  it('Given a read failure, Then it says retrying instead of retaining a stale watt claim', () => {
    expect(powerDisplay(status({ worker_metrics: { power_sensor_status: 2 } })).detail)
      .toMatch(/retrying automatically/i)
  })
})
