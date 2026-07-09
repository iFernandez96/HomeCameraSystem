/**
 * Human-readable time formatting helpers shared by LiveStats / Settings.
 *
 * `formatUptime` is for cumulative durations (server / worker uptime,
 * "up 2h 5m"). `formatAge` is for elapsed time relative to "now"
 * ("worker 12s ago"); it stays one-unit-per-tick because the
 * consumer typically wants a quick glance, not a precise breakdown.
 *
 * Both take seconds (float) — the same unit as everything else in the
 * `/api/status` payload. `Math.floor` everywhere so a 59.9-second
 * uptime reads as "59s" not "60s" and the next tick advances cleanly
 * to "1m".
 */

export function formatUptime(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}h ${m}m`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return `${d}d ${h}h`
}

export function formatAge(s: number): string {
  if (s < 5) return 'just now'
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function formatSecondsAgo(s: number | null | undefined): string {
  if (s == null) return 'never'
  return `${formatAge(s)} ago`
}

export function formatTemp(c: number | null | undefined): string {
  if (c == null) return '—'
  return `${Math.round(c)} °C`
}

/**
 * Render an unknown thrown value (Error, HttpError, anything) as a short
 * user-facing string. Prefers `Error.message` over the JS default
 * `Error: <msg>` prefix that `String(err)` produces — `String(new
 * Error('boom'))` gives `'Error: boom'`, while this returns `'boom'`.
 *
 * For the typed `HttpError` from `lib/api.ts`, `e.message` is already
 * shaped as `'/api/path STATUS: detail'`, so this surfaces the status
 * inline without duplicating it. Pages that need to BRANCH on the
 * status (e.g. show a different UI on 503 vs 422) should keep the
 * raw error in state and check `e instanceof HttpError && e.status
 * === N` at render time — this helper is only for the leaf "what
 * string should I render to the user" decision.
 */
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * iter-214 (Feature #8 slice 3): byte-count → human-readable string.
 * Used for the timelapse listing in Settings ("12.5 MB"). Decimal
 * units (1 KB = 1000 bytes) match what most users see in their OS
 * file managers; the Jetson's storage cost calculations in
 * feature_8_state.md use the same convention. Single-unit display
 * (no "1.5 GB 200 MB" stacking) — concise glance, not precise.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return `${n} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}
