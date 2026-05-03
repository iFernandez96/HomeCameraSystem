import { useEffect, useState } from 'react'

// iter-347: hoisted from `client/src/components/EventList.tsx` (was
// module-internal there since iter-?). Now shared with the People
// page so its `_formatRelative` ("5 minutes ago") updates without
// a manual reload. Returns Date.now() that bumps every `periodMs`.
//
// Default 30s matches the EventList cadence — a long-open events
// list refreshed twice per minute is enough granularity for the
// 1-minute-bucket relative-time displays.
export function useTicker(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(id)
  }, [periodMs])
  return now
}
