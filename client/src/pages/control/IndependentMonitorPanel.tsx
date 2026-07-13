import { useEffect, useState } from 'react'
import { readNativeHealthMonitorStatus, type NativeHealthMonitorStatus } from '../../lib/nativeStatus'
import { Section } from '../settings/parts'

function when(value: number): string {
  return value > 0 ? new Date(value).toLocaleString() : 'Not checked yet'
}

export function IndependentMonitorPanel() {
  const [status, setStatus] = useState<NativeHealthMonitorStatus | null>(() => readNativeHealthMonitorStatus())

  useEffect(() => {
    const refresh = () => setStatus(readNativeHealthMonitorStatus())
    const id = window.setInterval(refresh, 60_000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  return (
    <Section title="Independent phone observer" subtitle="The Android wrapper checks both Tailscale and the local network even when the Jetson cannot send a push.">
      {status ? (
        <div className="space-y-2 p-4 text-sm">
          <p className="font-semibold">{status.last_reachable ? 'Last check reached HomeCam' : status.last_check_ms ? 'Last check could not reach HomeCam' : 'Waiting for the first check'}</p>
          <p className="text-[var(--color-text-secondary)]">Last checked: {when(status.last_check_ms)} · next requested: {when(status.next_check_ms)}</p>
          <p className="text-[var(--color-text-secondary)]">Android wrapper {status.native_version} · {status.consecutive_failures} consecutive failure{status.consecutive_failures === 1 ? '' : 's'}</p>
          {!status.notifications_allowed ? <p role="alert" className="text-[var(--color-danger)]">Phone notifications are blocked, so offline alerts cannot appear.</p> : null}
          {status.background_restricted ? <p role="alert" className="text-[var(--color-danger)]">Android is restricting HomeCam background work. Allow unrestricted battery use for more timely checks.</p> : null}
          {!status.battery_optimization_exempt ? <p className="text-[var(--color-warning)]">Battery optimization may defer checks during Doze. The shown next time is requested, not a promise from Android.</p> : null}
        </div>
      ) : (
        <p className="p-4 text-sm text-[var(--color-text-secondary)]">This browser is not the Android wrapper. Independent monitoring continues only on phones with the installed HomeCam app.</p>
      )}
    </Section>
  )
}
