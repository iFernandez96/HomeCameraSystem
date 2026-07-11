const HEALTH_TIMEOUT_MS = 3_000

/**
 * Probe the Jetson process-liveness endpoint without credentials or caches.
 * A resolved 200 means the FastAPI event loop is scheduling requests. Any
 * network/TLS/timeout failure is deliberately collapsed to false: callers
 * must describe that state as "offline or unreachable", because a phone
 * cannot distinguish power loss from a broken route to the tailnet.
 */
export async function probeJetsonHealth(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch('/healthz', {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}
