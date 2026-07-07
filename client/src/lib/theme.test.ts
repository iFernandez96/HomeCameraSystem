import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_CHANGED_EVENT,
  applyTheme,
  getThemePref,
  initTheme,
  resolveTheme,
  setThemePref,
} from './theme'

// jsdom has no matchMedia — install a controllable stub.
let prefersDark = false
type MqListener = () => void
let mqListeners: MqListener[] = []

function installMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('dark') ? prefersDark : false,
    media: query,
    addEventListener: (_: string, cb: MqListener) => mqListeners.push(cb),
    removeEventListener: (_: string, cb: MqListener) => {
      mqListeners = mqListeners.filter((l) => l !== cb)
    },
  })) as unknown as typeof window.matchMedia
}

function addThemeColorMetas() {
  for (const scheme of ['light', 'dark']) {
    const m = document.createElement('meta')
    m.setAttribute('name', 'theme-color')
    m.setAttribute('media', `(prefers-color-scheme: ${scheme})`)
    document.head.appendChild(m)
  }
}

beforeEach(() => {
  prefersDark = false
  mqListeners = []
  localStorage.clear()
  installMatchMedia()
  addThemeColorMetas()
})

afterEach(() => {
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.remove())
  delete document.documentElement.dataset.theme
})

describe('theme preference resolution', () => {
  it('Given no stored preference, When the OS prefers dark, Then the resolved theme is dark', () => {
    // arrange
    prefersDark = true

    // act
    const resolved = resolveTheme()

    // assert
    expect(getThemePref()).toBe('system')
    expect(resolved).toBe('dark')
  })

  it('Given a stored light preference, When the OS prefers dark, Then the explicit preference wins', () => {
    // arrange
    prefersDark = true
    setThemePref('light')

    // act / assert
    expect(resolveTheme()).toBe('light')
  })
})

describe('applying the theme', () => {
  it('Given a dark preference, When applied, Then <html> data-theme and BOTH theme-color metas flip to the dark values', () => {
    // arrange
    setThemePref('dark')

    // act
    applyTheme()

    // assert
    expect(document.documentElement.dataset.theme).toBe('dark')
    const metas = Array.from(
      document.querySelectorAll('meta[name="theme-color"]'),
    )
    expect(metas).toHaveLength(2)
    for (const m of metas) expect(m.getAttribute('content')).toBe('#232019')
  })

  it('Given a listener on the change event, When the preference is set, Then the event fires with the resolved theme', () => {
    // arrange
    const seen: string[] = []
    const onChange = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener(THEME_CHANGED_EVENT, onChange)

    // act
    setThemePref('dark')
    window.removeEventListener(THEME_CHANGED_EVENT, onChange)

    // assert
    expect(seen).toEqual(['dark'])
  })
})

describe('initTheme live tracking', () => {
  it('Given pref=system, When the OS scheme flips to dark, Then the applied theme follows', () => {
    // arrange
    const cleanup = initTheme()
    expect(document.documentElement.dataset.theme).toBe('light')

    // act — flip the OS preference and fire the media-query listener
    prefersDark = true
    mqListeners.forEach((l) => l())

    // assert
    expect(document.documentElement.dataset.theme).toBe('dark')
    cleanup()
  })

  it('Given an explicit light pref, When the OS scheme flips, Then the applied theme does NOT follow', () => {
    // arrange
    setThemePref('light')
    const cleanup = initTheme()

    // act
    prefersDark = true
    mqListeners.forEach((l) => l())

    // assert
    expect(document.documentElement.dataset.theme).toBe('light')
    cleanup()
  })
})
