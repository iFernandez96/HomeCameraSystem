/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst } from 'workbox-strategies'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  applyBadge,
  buildNotification,
  parsePushData,
} from './lib/swPushHandler'

declare const self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

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

self.addEventListener('notificationclick', (event) => {
  // iter-332: branch on event.action. Empty string = body tap (the
  // default "open the app" flow); 'view' = explicit View action
  // button (same destination as body tap); 'dismiss' = Mark seen,
  // POST /api/events/{id}/seen and just close the notification
  // without focusing the PWA.
  const action = (event as unknown as { action?: string }).action ?? ''
  const data = event.notification.data as
    | { url?: string; event_id?: string }
    | null
  const target = data?.url ?? '/'
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

  // Default + 'view': close the notification and focus the PWA.
  event.notification.close()
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of all) {
        if ('focus' in c) {
          // iter-356.7 (widget C2): skip the navigate when the client
          // is already at the target URL. Pre-iter-356.7 every
          // notification tap caused a full page reload of /events
          // even when the user was already viewing it — re-fired
          // markAllEventsSeen, dropped scroll position, felt sluggish.
          // The `c.url.endsWith(target)` check avoids false negatives
          // from the WindowClient.url including the origin
          // (`https://homecam.tail4a6525.ts.net/events`).
          const win = c as WindowClient
          try {
            const url = new URL(win.url)
            if (url.pathname !== target) {
              await win.navigate(target)
            }
          } catch {
            // If URL parsing fails, fall back to navigate.
            await win.navigate(target)
          }
          return win.focus()
        }
      }
      return self.clients.openWindow(target)
    })(),
  )
})
