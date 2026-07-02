/**
 * iter-356.37 — Settings → System → Debug pane.
 *
 * Operator-grade reload surface so the user can force the PWA to fetch
 * a fresh bundle from Android (or any other client) without going into
 * Chrome devtools. Two buttons:
 *
 *   1. **Reload app** — `location.reload()`. Bypasses memory cache via
 *      a `?_t=<now>` query string on the next request, but the service
 *      worker will still serve cached assets if the SW is healthy + the
 *      autoUpdate path hasn't activated yet.
 *
 *   2. **Reset cache & reload** — nuclear option. Calls `caches.delete`
 *      on every Cache-API entry, then `serviceWorker.unregister()` on
 *      every registration, then a hard `location.replace` with a cache-
 *      busting query. Use when a deploy "should be live" but the device
 *      is still serving the prior bundle.
 *
 * Plus a read-only diagnostic strip showing:
 *   - Bundle ID (build stamp injected via vite.config.ts `define`)
 *   - Service worker scope + state
 *   - User agent (truncated)
 *
 * No auth gating beyond the existing System-tab visibility — debug
 * info is harmless to non-owners and the buttons are local-only (no
 * server side-effects).
 */

import { useEffect, useState } from 'react'
import { useToast } from '../../lib/toast'
import { useConfirm } from '../../lib/confirm'

type SwInfo = {
  scope: string | null
  state: string | null
}

async function readSwInfo(): Promise<SwInfo> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { scope: null, state: null }
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return { scope: null, state: null }
    const sw = reg.active ?? reg.installing ?? reg.waiting
    return { scope: reg.scope, state: sw?.state ?? null }
  } catch {
    return { scope: null, state: null }
  }
}

async function nukeCachesAndUnregisterSw() {
  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    } catch {
      // ignore
    }
  }
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    } catch {
      // ignore
    }
  }
}

export function DebugSection() {
  const toast = useToast()
  const confirm = useConfirm()
  const [sw, setSw] = useState<SwInfo>({ scope: null, state: null })

  useEffect(() => {
    let cancelled = false
    void readSwInfo().then((info) => {
      if (!cancelled) setSw(info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onReload = () => {
    // Add a cache-buster so the HTML fetch goes around any stale CDN
    // entries. The SW may still intercept; that's why "Reset cache" is
    // the second button.
    const url = new URL(window.location.href)
    url.searchParams.set('_t', String(Date.now()))
    window.location.replace(url.toString())
  }

  const onResetAndReload = async () => {
    const ok = await confirm({
      title: 'Reset cache & reload?',
      body:
        "Clears the service worker and all cached assets, then fetches a fresh bundle. Use when a new deploy hasn't shown up after a normal reload. Your login stays signed in.",
      destructive: false,
      confirmLabel: 'Reset & reload',
    })
    if (!ok) return
    toast.showToast('Resetting cache…', 'info')
    await nukeCachesAndUnregisterSw()
    // Hard reload — replace so back-button doesn't return to the
    // mid-reset state.
    const url = new URL(window.location.href)
    url.searchParams.set('_t', String(Date.now()))
    window.location.replace(url.toString())
  }

  return (
    // Sunroom: card joins the Section paper tier (shadow-card) and the
    // heading steps up to the shared header size (Inter semibold 18px).
    <section
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-[var(--shadow-card)] p-4 space-y-3"
      aria-labelledby="debug-section-heading"
    >
      <h2
        id="debug-section-heading"
        className="text-lg font-semibold text-[var(--color-text-primary)]"
      >
        Debug
      </h2>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Force the app to fetch a fresh bundle from the server. Use when
        you&apos;ve just deployed and the old version is still showing.
      </p>

      <div className="flex flex-wrap gap-2">
        {/* Sunroom: the filled action is ink (Panther) — marmalade fills
            are reserved for links / focus / active / live signal. 44px
            touch floor on both. */}
        <button
          type="button"
          onClick={onReload}
          className="px-3 py-2 rounded-lg bg-[var(--color-surface-raised)] hover:border-[var(--color-border-strong)] text-[var(--color-text-primary)] text-sm font-medium border border-[var(--color-border)] transition-colors duration-150 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Reload app
        </button>
        <button
          type="button"
          onClick={onResetAndReload}
          className="px-3 py-2 rounded-lg bg-[var(--color-ink)] hover:bg-[var(--color-ink-hover)] text-white text-sm font-medium transition-colors duration-150 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Reset cache &amp; reload
        </button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs text-[var(--color-text-secondary)] font-mono pt-2 border-t border-[var(--color-border-subtle)]">
        <dt>Bundle</dt>
        <dd className="text-[var(--color-text-primary)] break-all">
          {typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}
        </dd>
        <dt>SW state</dt>
        <dd className="text-[var(--color-text-primary)]">
          {sw.state ?? 'none'}
        </dd>
        <dt>SW scope</dt>
        <dd className="text-[var(--color-text-primary)] break-all">
          {sw.scope ?? '—'}
        </dd>
      </dl>
    </section>
  )
}
