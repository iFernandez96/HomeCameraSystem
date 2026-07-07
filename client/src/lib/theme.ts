/**
 * Theme preference + resolution (redesign/warm-boutique, 2026-07-02).
 *
 * Three-way preference: 'system' (default) | 'light' | 'dark'.
 * The RESOLVED theme is always concrete ('light' | 'dark') and lands
 * as `data-theme` on <html>, which index.css keys every token off.
 * A tiny inline script in index.html applies the same resolution
 * BEFORE first paint (no flash); this module owns it from then on:
 * persistence, live prefers-color-scheme tracking while pref is
 * 'system', cross-tab sync, and keeping the <meta name="theme-color">
 * pair in step so the Android status bar matches the app.
 *
 * Keep the resolution logic here EXACTLY in sync with the index.html
 * inline script (it is a 5-line copy of `resolveTheme`).
 */

export type ThemePref = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'homecam:theme'
/** Must match --color-bg in index.css for each theme. */
const THEME_BG: Record<ResolvedTheme, string> = {
  light: '#f3f1ea',
  dark: '#232019',
}
/** Window event fired after every apply — Settings' control re-renders off it. */
export const THEME_CHANGED_EVENT = 'homecam:theme-changed'

export function getThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : 'system'
  } catch {
    // Storage unavailable (private mode edge cases) — behave as system.
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

export function resolveTheme(pref: ThemePref = getThemePref()): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref
  return systemPrefersDark() ? 'dark' : 'light'
}

/** Apply the resolved theme to <html> + the theme-color metas. */
export function applyTheme(): ResolvedTheme {
  const resolved = resolveTheme()
  document.documentElement.dataset.theme = resolved
  // Both metas (the media-scoped pair in index.html) get the resolved
  // color so a manual override beats the media attribute.
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute('content', THEME_BG[resolved]))
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: resolved }))
  return resolved
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Persistence failing is non-fatal — the session still applies it.
  }
  applyTheme()
}

/**
 * Boot-time wiring: apply once, follow OS changes while pref is
 * 'system', follow other-tab changes via the storage event.
 * Returns a cleanup (used by tests; the app runs it for the tab's life).
 */
export function initTheme(): () => void {
  applyTheme()
  const mq =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  const onMq = () => {
    if (getThemePref() === 'system') applyTheme()
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) applyTheme()
  }
  mq?.addEventListener?.('change', onMq)
  window.addEventListener('storage', onStorage)
  return () => {
    mq?.removeEventListener?.('change', onMq)
    window.removeEventListener('storage', onStorage)
  }
}
