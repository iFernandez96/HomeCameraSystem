export type NativeHealthMonitorStatus = {
  v: 1
  native_version: string
  last_check_ms: number
  next_check_ms: number
  last_reachable: boolean
  consecutive_failures: number
  offline_notified: boolean
  background_restricted: boolean
  battery_optimization_exempt: boolean
  notifications_allowed: boolean
}

type NativeBridge = { getHealthMonitorStatus?: () => string }

export function readNativeHealthMonitorStatus(): NativeHealthMonitorStatus | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as Window & { HomeCamNative?: NativeBridge }).HomeCamNative
  if (typeof bridge?.getHealthMonitorStatus !== 'function') return null
  try {
    const value = JSON.parse(bridge.getHealthMonitorStatus()) as Partial<NativeHealthMonitorStatus>
    if (value.v !== 1 || typeof value.native_version !== 'string') return null
    return value as NativeHealthMonitorStatus
  } catch {
    return null
  }
}
