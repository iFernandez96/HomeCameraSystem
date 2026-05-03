import {
  getVapidPublicKey,
  sendTestPushReq,
  subscribePush,
  unsubscribePush,
} from './api'

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
  if (!pushSupported()) {
    alert('Push not supported in this browser. On Android, use Chrome.')
    return false
  }
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    const { key } = await getVapidPublicKey()
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    })
  }
  await subscribePush(sub)
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
    console.warn('server-side push unsubscribe failed (will retry on next 410)', e)
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
