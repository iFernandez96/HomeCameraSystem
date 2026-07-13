import { useEffect, useState } from 'react'
import { getServerVersion } from '../lib/api'

const CLIENT_API_COMPAT = 1

function reloadFresh() {
  const url = new URL(window.location.href)
  url.searchParams.set('_build', String(Date.now()))
  window.location.replace(url.toString())
}

export function UpdateCompatibilityBanner() {
  const [updateReady, setUpdateReady] = useState(false)
  const [incompatible, setIncompatible] = useState(false)

  useEffect(() => {
    let disposed = false
    void getServerVersion().then((version) => {
      if (!disposed) setIncompatible(CLIENT_API_COMPAT < version.minimum_client_compat)
    }).catch(() => undefined)

    if (!('serviceWorker' in navigator)) return () => { disposed = true }
    let hadController = navigator.serviceWorker.controller != null
    const onControllerChange = () => {
      if (!hadController) {
        hadController = true
        return
      }
      if (document.visibilityState === 'visible' && !document.querySelector('[role="dialog"]')) {
        reloadFresh()
      } else {
        setUpdateReady(true)
      }
    }
    const inspect = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting && navigator.serviceWorker.controller) setUpdateReady(true)
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true)
        })
      })
      void registration.update().catch(() => undefined)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration) inspect(registration)
    })
    const updateTimer = window.setInterval(() => {
      void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined)
    }, 5 * 60_000)
    return () => {
      disposed = true
      window.clearInterval(updateTimer)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
    }
  }, [])

  if (!updateReady && !incompatible) return null
  return (
    <div role="alert" className="fixed inset-x-3 bottom-20 z-[70] flex min-h-12 items-center justify-center gap-3 rounded-[var(--radius-xl)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-2 text-sm text-[var(--color-text-primary)] shadow-[var(--shadow-card)] lg:inset-x-auto lg:bottom-4 lg:right-4 lg:max-w-xl">
      <span className="font-semibold">{incompatible ? 'This app version is no longer compatible with the camera box.' : 'A fresh HomeCam update is ready.'}</span>
      <button type="button" onClick={reloadFresh} className="min-h-10 rounded-full bg-[var(--color-ink)] px-4 font-semibold text-[var(--color-on-ink)]">Restart now</button>
    </div>
  )
}
