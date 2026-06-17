// Cellular-adaptive streaming quality (2026-06-16 design).
//
// The Jetson's MediaMTX publishes three WHEP paths for the same camera:
//   - `cam`     — HQ  (full-bitrate NVENC bitstream)
//   - `cam_lq`  — SD  (data-saver transcode)
//   - `cam_uq`  — XS  (ultra-low / minimum bitrate)
// The client picks one. `auto` reads the browser's Network Information API
// (navigator.connection) and downshifts on cellular / metered / Save-Data
// links so a phone on LTE doesn't try to pull the full-bitrate stream.

export type StreamQuality = 'auto' | 'hq' | 'sd' | 'xs'

// The non-auto tiers, in descending bandwidth order. `auto` resolves to one
// of these at connect time.
export type ResolvedQuality = 'hq' | 'sd' | 'xs'

/**
 * The shape of `navigator.connection` (Network Information API) we read.
 * Every field is optional because the API is partial / absent on many
 * browsers (Safari, Firefox), in which case we fall through to HQ.
 */
export type ConnectionLike = {
  saveData?: boolean
  type?: string
  effectiveType?: string
}

/**
 * Map an actual link to a stream tier.
 *
 * Precedence (highest first):
 *   1. Save-Data header on  -> xs (the user explicitly asked to conserve).
 *   2. cellular link, OR effectiveType 2g/slow-2g -> xs (too thin for SD).
 *   3. effectiveType 3g -> sd.
 *   4. everything else (4g, wifi, ethernet, unknown, API missing) -> hq.
 */
export function resolveAutoQuality(
  conn: ConnectionLike | undefined | null,
): ResolvedQuality {
  if (!conn) return 'hq'
  if (conn.saveData === true) return 'xs'
  const eff = conn.effectiveType
  if (conn.type === 'cellular' || eff === 'slow-2g' || eff === '2g') return 'xs'
  if (eff === '3g') return 'sd'
  return 'hq'
}

// MediaMTX path per resolved tier.
const PATH_BY_QUALITY: Record<ResolvedQuality, string> = {
  hq: 'cam',
  sd: 'cam_lq',
  xs: 'cam_uq',
}

/**
 * The MediaMTX path for a chosen quality. `auto` resolves against the link
 * (optionally supplied; defaults to `navigator.connection`).
 */
export function pathForQuality(
  q: StreamQuality,
  conn?: ConnectionLike | undefined | null,
): string {
  const resolved: ResolvedQuality =
    q === 'auto'
      ? resolveAutoQuality(conn === undefined ? readConnection() : conn)
      : q
  return PATH_BY_QUALITY[resolved]
}

/**
 * Compose the same-origin WHEP URL for a MediaMTX path.
 *
 * iter-244b: same-origin path-based WHEP. Pre-iter-244b this composed
 * `<proto>//<host>:8889/cam/whep` directly — fine on LAN where the
 * browser can hit the Jetson's :8889 port over HTTP, broken over the
 * iter-244 Tailscale Serve HTTPS proxy because (a) the proxy only
 * forwards :443 not :8889, and (b) browsers refuse mixed-content
 * (HTTPS page → HTTP MediaMTX).
 *
 * Fix: route WHEP through the Tailscale Serve path proxy at
 * `/whep/*` (configured `tailscale serve --bg --https=443
 * --set-path=/whep http://localhost:8889`). Same origin as the page,
 * so HTTPS preserved, no mixed content, no extra port. Vite dev
 * server proxies `/whep` → `http://localhost:8889` for parity (see
 * vite.config.ts).
 */
export function whepUrlForPath(path: string): string {
  return `${window.location.origin}/whep/${path}/whep`
}

const STORAGE_KEY = 'homecam:streamQuality'
const DEFAULT_QUALITY: StreamQuality = 'auto'
const VALID: ReadonlySet<string> = new Set<StreamQuality>([
  'auto',
  'hq',
  'sd',
  'xs',
])

/**
 * Read the persisted quality choice. Tolerant of a missing key, a missing
 * localStorage (SSR / privacy mode throws), or a junk value — all fall back
 * to the `auto` default.
 */
export function getStreamQuality(): StreamQuality {
  if (typeof window === 'undefined') return DEFAULT_QUALITY
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null && VALID.has(stored)) return stored as StreamQuality
  } catch {
    // localStorage can throw in private-mode / disabled-storage contexts.
  }
  return DEFAULT_QUALITY
}

/** Persist the quality choice. Swallows storage errors (private mode). */
export function setStreamQuality(q: StreamQuality): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, q)
  } catch {
    // Best-effort — a failed write just means the choice won't survive reload.
  }
}

/** Best-effort read of the live `navigator.connection`. */
function readConnection(): ConnectionLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as Navigator & { connection?: ConnectionLike }).connection
}
