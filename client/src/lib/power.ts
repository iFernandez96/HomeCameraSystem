import type { ServerStatus } from './types'

export type PowerDisplay = {
  state: 'checking' | 'offline' | 'unavailable' | 'error' | 'stale' | 'live'
  compact: string
  detail: string
}

const STALE_AFTER_S = 15

/**
 * Convert raw power telemetry into a display state that cannot imply a live
 * measurement when the sensor, worker, or sample is missing or stale.
 */
export function powerDisplay(status: ServerStatus | null): PowerDisplay {
  if (status === null) {
    return { state: 'checking', compact: 'Power —', detail: 'Checking power sensor' }
  }
  if (!status.worker_alive) {
    return {
      state: 'offline',
      compact: 'Power —',
      detail: 'Power telemetry unavailable while detection is offline',
    }
  }

  const metrics = status.worker_metrics
  if (metrics?.power_sensor_status === 0 || metrics?.power_sensor_status == null) {
    return {
      state: 'unavailable',
      compact: 'Power —',
      detail: 'External power sensor needed',
    }
  }
  if (metrics.power_sensor_status === 2) {
    return {
      state: 'error',
      compact: 'Power error',
      detail: 'Power sensor read failed; retrying automatically',
    }
  }
  if (
    status.power_sample_age_s == null ||
    status.power_sample_age_s > STALE_AFTER_S
  ) {
    return {
      state: 'stale',
      compact: 'Power stale',
      detail: 'Last power reading is no longer current',
    }
  }

  const watts = metrics.power_watts
  const volts = metrics.power_volts
  const amps = metrics.power_amps
  if (
    watts == null || volts == null || amps == null ||
    !Number.isFinite(watts) || !Number.isFinite(volts) || !Number.isFinite(amps) ||
    watts < 0 || volts <= 0 || amps < 0
  ) {
    return {
      state: 'error',
      compact: 'Power error',
      detail: 'Power sensor returned an invalid reading; retrying automatically',
    }
  }

  return {
    state: 'live',
    compact: `Power ${watts.toFixed(1)} W`,
    detail: `${watts.toFixed(2)} W · ${volts.toFixed(2)} V · ${amps.toFixed(2)} A`,
  }
}
