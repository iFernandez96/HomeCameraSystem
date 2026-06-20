import {
  getVapidPublicKey,
  sendTestPushReq,
  subscribePush,
  unsubscribePush,
} from './api'
import { log, errFields } from './log'

// Push endpoints are opaque per-device URLs whose path segment is a
// device secret. Log only the host (e.g. `fcm.googleapis.com`) so a
// failing provider is identifiable without persisting the secret tail.
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'invalid-endpoint'
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

export async function getPushState(): Promise<boolean> {
  if (!pushSupported()) return false
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return !!sub
}

export async function ensurePushSubscription(): Promise<boolean> {
  // docs/logging_plan.md §2 (push.ts enable-chain): every step below can
  // fail for a distinct reason (permission denied, VAPID key fetch 5xx,
  // browser/push-service subscribe reject, server persist fail). The
  // chain returned a bare `false` or threw with no breadcrumb of WHICH
  // step broke. Each step is logged at ERROR with a `step` tag.
  // GUARDRAIL: NEVER log the VAPID key bytes or the endpoint secret tail.
  if (!pushSupported()) {
    alert('Push not supported in this browser. On Android, use Chrome.')
    return false
  }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') {
    log.error('push:enable-failed', { step: 'permission', permission: perm })
    return false
  }
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    let key: string
    try {
      ;({ key } = await getVapidPublicKey())
    } catch (e) {
      log.error('push:enable-failed', { step: 'vapid-key', ...errFields(e) })
      throw e
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
    } catch (e) {
      log.error('push:enable-failed', { step: 'subscribe', ...errFields(e) })
      throw e
    }
  }
  try {
    await subscribePush(sub)
  } catch (e) {
    log.error('push:enable-failed', {
      step: 'server-persist',
      endpointHost: endpointHost(sub.endpoint),
      ...errFields(e),
    })
    throw e
  }
  return true
}

/**
 * Disable push: invalidate the browser-side subscription AND tell the
 * server to drop it from `push_subs.json`. Without the server call, the
 * stale subscription stays persisted until the next outbound push hits a
 * 410/404 from Apple/Google — which can be days if no events fire. The
 * server cleanup is best-effort: a network failure here doesn't change
 * the user-visible state (the browser sub is already gone), and the
 * server's 410-prune fallback will eventually catch it.
 */
export async function disablePushSubscription(): Promise<void> {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  // Capture endpoint before unsubscribe — calling .unsubscribe() on a
  // PushSubscription is allowed to clear .endpoint per the spec, so
  // reading it after would be undefined.
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  try {
    await unsubscribePush(endpoint)
  } catch (e) {
    // docs/logging_plan.md §2: was a bare console.warn. Promote to a
    // structured WARN carrying the endpoint HOST (NOT the secret path
    // tail) + status so a persistently-failing server-side unsubscribe
    // (stale sub never pruned) is visible. The browser sub is already
    // gone so this stays best-effort.
    log.warn('push:server-unsubscribe-failed', {
      endpointHost: endpointHost(endpoint),
      ...errFields(e),
    })
  }
}

/**
 * Returns the number of subscriptions pywebpush actually delivered the
 * test notification to. Callers that show user-facing toasts can use
 * this to be honest about "you'll see N notifications" vs "nothing
 * landed" — the latter happens when no subs are registered server-side
 * (or they all got pruned in send_all on prior 410/404 responses).
 */
export async function sendTestPush(): Promise<number> {
  const r = await sendTestPushReq()
  // Defensive `?? 0` in case the server omits `sent` (older deploy,
  // malformed response). Treat as zero so the caller's "no reachable
  // subs" branch fires instead of rendering "undefined devices".
  return r.sent ?? 0
}
