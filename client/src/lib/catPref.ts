import { useEffect, useState } from 'react'

/**
 * iter-356.10 (Frank #5) — local user preference for the ambient
 * CatLayer. Frank's wife loves the cats; Frank thinks they're a
 * battery drain. With this hook + the AccountSection toggle they
 * each get what they want (per device — preference is localStorage,
 * not server-side).
 *
 * Storage key: `homecam:cats` — `'on'` or `'off'` (string sentinel,
 * not boolean serialization, so a corrupt or pre-iter-356.10 missing
 * value defaults to 'on' = cats enabled).
 *
 * Cross-tab sync: dispatches a window CustomEvent `homecam:cats-pref`
 * on write, so an open Settings tab and an open Live tab on the same
 * device both pick up the change immediately. Storage events fire
 * across tabs natively too.
 */

const STORAGE_KEY = 'homecam:cats'
const EVENT_NAME = 'homecam:cats-pref'

function readPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    // Default ON. Only the explicit string 'off' disables.
    return v !== 'off'
  } catch {
    return true
  }
}

function writePref(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // localStorage may throw in private mode / quota exceeded.
    // Silently fall through; the runtime state still updates.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: enabled }))
}

export function useCatsEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => readPref())

  useEffect(() => {
    const onPref = (e: Event) => {
      const next = (e as CustomEvent<boolean>).detail
      if (typeof next === 'boolean') setEnabled(next)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setEnabled(readPref())
    }
    window.addEventListener(EVENT_NAME, onPref)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVENT_NAME, onPref)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setAndPersist = (next: boolean) => {
    writePref(next)
    setEnabled(next)
  }

  return [enabled, setAndPersist]
}
