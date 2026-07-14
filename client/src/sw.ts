/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  applyBadge,
  buildNotification,
  parsePushData,
} from './lib/swPushHandler'

declare const self: ServiceWorkerGlobalScope
type PrecacheManifestEntry = { url: string; revision?: string | null } | string

const precacheManifest = self.__WB_MANIFEST as PrecacheManifestEntry[]

function manifestBuildId(entries: PrecacheManifestEntry[]): string {
  // H6.13: Workbox injectManifest writes content revisions into
  // self.__WB_MANIFEST at build time. index.html is the app-shell
  // revision the operator cares about for SW takeover observability,
  // so prefer that stable manifest hash. The fallback is a small
  // deterministic hash of the injected manifest for unusual builds
  // where index.html is absent or unrevised.
  const indexEntry = entries.find(
    (entry) =>
      typeof entry !== 'string' &&
      entry.url.replace(/^\.\//, '').replace(/^\//, '') === 'index.html' &&
      typeof entry.revision === 'string' &&
      entry.revision.length > 0,
  )
  if (typeof indexEntry !== 'string' && indexEntry?.revision) {
    return indexEntry.revision
  }

  const normalized = entries
    .map((entry) =>
      typeof entry === 'string'
        ? { url: entry, revision: null }
        : { url: entry.url, revision: entry.revision ?? null },
    )
    .sort((a, b) => a.url.localeCompare(b.url))
  const json = JSON.stringify(normalized)
  let hash = 0x811c9dc5
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `manifest-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const SW_BUILD_ID = manifestBuildId(precacheManifest)

function sendSwActivatedLog(buildId: string): void {
  try {
    void fetch('/api/_internal/client_log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        level: 'info',
        event: 'sw:activated',
        fields: { buildId },
        online: self.navigator.onLine,
        ua: self.navigator.userAgent.slice(0, 240),
      }),
    }).catch(() => {
      // Offline activation is normal; this observability ping is best-effort.
    })
  } catch {
    // fetch can throw synchronously in constrained SW contexts; ignore.
  }
}

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(precacheManifest)

self.addEventListener('activate', () => {
  sendSwActivatedLog(SW_BUILD_ID)
})

// H6.9 (harness #6): the app shell is precached, but Workbox did
// not have a navigation fallback. Offline navigations to deep SPA
// routes (measured: /events) escaped the precache and failed with
// ERR_INTERNET_DISCONNECTED. Serve index.html for browser
// navigations while denying every server-owned non-SPA path from
// server/app/main.py: /api, optional WHEP proxying, media file
// endpoints, Prometheus metrics, and health checks.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [
      /^\/api(?:\/|$)/,
      /^\/whep(?:\/|$)/,
      /^\/snapshots(?:\/|$)/,
      /^\/timelapses(?:\/|$)/,
      /^\/metrics$/,
      /^\/healthz$/,
    ],
  }),
)

// iter-356.65 (mobile slice A): cat PNG sprites are excluded from
// the precache (vite.config.ts globIgnores) because they're heavy
// and only show on empty-state / ambient surfaces. Cache them at
// runtime with CacheFirst — first hit fills the cache, subsequent
// loads are instant + work offline. 30-day expiration so a long-
// running install doesn't keep stale art forever.
registerRoute(
  ({ url, request }) =>
    request.destination === 'image' &&
    /\.png$/i.test(url.pathname) &&
    url.pathname.startsWith('/assets/'),
  new CacheFirst({
    cacheName: 'homecam-cat-art-v1',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({
        maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
        maxEntries: 60,
      }),
    ],
  }),
)

// iter-349 (Discovery #4 from iter-327, value 7, S): NetworkFirst
// runtime cache for the GET-only events surface. The PWA precaches
// the app shell but `/api/events*` was fetch-on-demand → blank
// Events page when the phone loses tunnel. NetworkFirst tries the
// network first; on failure (offline, server down, Tailscale blip)
// returns the last-cached response. Limits the cache to 200-OK
// responses (no caching 401s during session expiry) and a 1-hour
// TTL to prevent serving multi-day-stale events when the tunnel
// is up but the server is degraded.
//
// Match scope: /api/events (list), /api/events/search, /api/events/
// count_by_day, /api/events/unread_count. Excludes /api/events/
// {id}/seen (POST) since NetworkFirst is GET-only by default
// (Workbox skips non-GET methods automatically) AND excludes
// /api/events/export which is also a POST.
//
// Cache name `homecam-events-v1` so a future schema break can be
// invalidated by bumping the suffix without affecting the precache.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' && url.pathname.startsWith('/api/events'),
  new NetworkFirst({
    cacheName: 'homecam-events-v1',
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({
        // iter-349 sharp edge: ONLY cache 200s. Caching a 401
        // would serve stale "not authenticated" to a freshly-
        // re-authed client; caching a 304 makes no sense
        // (NetworkFirst handles 304 transparently anyway).
        statuses: [200],
      }),
      new ExpirationPlugin({
        // 1 hour max — long enough to survive a Tailscale blip
        // but not so long that a degraded server (returning
        // stale 200s) silently serves multi-day-old events.
        maxAgeSeconds: 60 * 60,
        maxEntries: 50,
      }),
    ],
  }),
)

// iter-282: push handler logic extracted to ./lib/swPushHandler so
// the per-event tag + setAppBadge logic is unit-testable without
// spinning up a real ServiceWorkerGlobalScope. The SW just wires
// the event.data parse to buildNotification + applyBadge.
//
// History recap of the call sites:
// - iter-188 (Feature #7): hero image in the notification.
// - iter-253: PNG icons (Firefox + Safari fell back to the browser
//   icon when given SVG).
// - iter-275 (widget-usability C1): per-event tag so detection
//   bursts don't silently collapse (was the literal "event" tag
//   for every push).
// - iter-275: renotify: true so the audible alert re-fires when
//   per-event tags stack.
// - iter-276 (widget-usability A1): home-screen app-icon badge from
//   the iter-276 unread_count server payload field.
self.addEventListener('push', (event) => {
  const data = parsePushData(event)
  const { title, options } = buildNotification(data)
  applyBadge(
    self.registration as unknown as Parameters<typeof applyBadge>[0],
    data,
  )
  event.waitUntil(self.registration.showNotification(title, options))
})

// notif-deeplink (UI/UX overhaul 2026-07-07): compose the click-through
// target from the notification's data. A REAL detection event carries
// event_id (buildNotification leaves it null for timelapse / test
// pushes), and the server payload's url is the plain '/events' list —
// so a body tap used to land the user on the list and make them hunt
// for the clip. Now the target is '/events?event=<id>' and Events.tsx
// auto-opens the ClipModal for that id on mount. Non-event
// notifications keep their payload url untouched. Exported as a pure
// helper so sw.test.ts can pin the mapping without a real SW global.
export function notificationClickTarget(
  data: { url?: string; event_id?: string | null } | null | undefined,
): string {
  const base = typeof data?.url === 'string' && data.url ? data.url : '/'
  const eventId =
    typeof data?.event_id === 'string' && data.event_id ? data.event_id : null
  // Same 'event' literal guard as the dismiss branch below — the
  // generic test-push tag must never masquerade as a real event id.
  if (!eventId || eventId === 'event') return base
  return `${base}${base.includes('?') ? '&' : '?'}event=${encodeURIComponent(eventId)}`
}

export function notificationActionTarget(
  action: string,
  data:
    | {
        url?: string
        event_id?: string | null
        deterrence_duration_s?: number
      }
    | null
    | undefined,
): string {
  if (action === 'talk') {
    const params = new URLSearchParams({ talk: '1' })
    if (data?.event_id) params.set('event', data.event_id)
    return `/?${params.toString()}`
  }
  if (action === 'light' || action === 'warning' || action === 'siren') {
    const params = new URLSearchParams({
      deterrence: action,
      duration: String(data?.deterrence_duration_s ?? 15),
    })
    if (data?.event_id) params.set('event', data.event_id)
    return `/?${params.toString()}`
  }
  return notificationClickTarget(data)
}

async function focusOrOpenWindow(target: string): Promise<WindowClient | null> {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of all) {
    if (!('focus' in client)) continue
    const win = client as WindowClient
    try {
      const url = new URL(win.url)
      const wanted = new URL(target, url.origin)
      if (url.pathname + url.search !== wanted.pathname + wanted.search) {
        await win.navigate(target)
      }
    } catch {
      await win.navigate(target)
    }
    return win.focus()
  }
  return self.clients.openWindow(target)
}

self.addEventListener('notificationclick', (event) => {
  // iter-332: branch on event.action. Empty string = body tap (the
  // default "open the app" flow); 'view' = explicit View action
  // button (same destination as body tap); 'dismiss' = Mark seen,
  // POST /api/events/{id}/seen and just close the notification
  // without focusing the PWA.
  const action = (event as unknown as { action?: string }).action ?? ''
  const data = event.notification.data as
    | { url?: string; event_id?: string; deterrence_duration_s?: number }
    | null
  const target = notificationActionTarget(action, data)
  const eventId = data?.event_id

  if (action === 'dismiss' && eventId && eventId !== 'event') {
    // Best-effort POST. The fetch carries the user's HttpOnly auth
    // cookie via `credentials: 'include'`. We don't await the
    // response — the user wanted dismissal, the badge will reconcile
    // on the next /unread_count poll if the server didn't ack.
    event.notification.close()
    event.waitUntil(
      fetch(`/api/events/${encodeURIComponent(eventId)}/seen`, {
        method: 'POST',
        credentials: 'include',
        // iter-333b (perf E2): no Content-Type header — the route
        // accepts a bodyless POST. The header was triggering a
        // CORS preflight on some configurations and adding 30+
        // bytes per dismissal action over the Tailscale tunnel.
      }).catch(() => {
        // Network failure is non-fatal — the iter-248 visibility
        // resume + iter-276 unread reconcile cover the gap on
        // next foreground.
      }),
    )
    return
  }

  if (action === 'protect' && eventId && eventId !== 'event') {
    event.notification.close()
    event.waitUntil(
      fetch(`/api/events/${encodeURIComponent(eventId)}/protection`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: true }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`protect failed: ${response.status}`)
        })
        // A failed lock-screen mutation must not disappear silently: open the
        // event so the user can retry from the authenticated foreground UI.
        .catch(() => focusOrOpenWindow(notificationClickTarget(data))),
    )
    return
  }

  // Default + 'view': close the notification and focus the PWA.
  event.notification.close()
  event.waitUntil(focusOrOpenWindow(target))
})
