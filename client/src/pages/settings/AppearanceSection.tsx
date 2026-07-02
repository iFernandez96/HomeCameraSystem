/**
 * Settings → Account & System → Appearance (dual-theme upgrade, 2026-07-02).
 *
 * Three-way theme preference: System / Light / Dark, wired to
 * lib/theme.ts (`getThemePref` / `setThemePref`). `setThemePref`
 * applies the resolved theme to <html data-theme> and fires
 * THEME_CHANGED_EVENT — this control re-reads the pref off that
 * event, so cross-tab changes (theme.ts's storage listener) and
 * OS flips while on 'system' stay in sync too.
 *
 * Radiogroup semantics mirror parts.tsx::RetentionPresetPicker (the
 * codebase's segmented-choice idiom); the selected tile speaks the
 * tint dialect: accent-subtle wash + accent text + accent border —
 * both sides of which flip with the theme, so the control previews
 * its own effect.
 */

import { useEffect, useState } from 'react'
import {
  getThemePref,
  setThemePref,
  THEME_CHANGED_EVENT,
  type ThemePref,
} from '../../lib/theme'
import { useRipple } from '../../lib/ripple'
import { Section } from './parts'

const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: 'System', hint: 'Match device' },
  { value: 'light', label: 'Light', hint: 'Sunroom' },
  { value: 'dark', label: 'Dark', hint: 'Lights off' },
]

export function AppearanceSection() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref())
  const ripple = useRipple()

  useEffect(() => {
    // Re-read the stored pref after every apply — covers this
    // control's own taps AND other-tab / OS-driven changes.
    const onThemeChanged = () => setPref(getThemePref())
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged)
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged)
  }, [])

  return (
    <Section
      title="Appearance"
      subtitle="System follows your device's day/night setting."
    >
      <div
        className="px-4 py-3"
        role="radiogroup"
        aria-label="Theme"
      >
        <div className="grid grid-cols-3 gap-2">
          {OPTIONS.map((opt) => {
            const active = pref === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => setThemePref(opt.value)}
                onPointerDown={ripple}
                // Roving tabindex + arrow keys (WAI-ARIA radiogroup
                // pattern): one Tab stop for the group; arrows move +
                // select. Handler lives on the focusable radios (the
                // group div itself isn't focusable — jsx-a11y).
                onKeyDown={(e) => {
                  const idx = OPTIONS.findIndex((o) => o.value === pref)
                  const delta =
                    e.key === 'ArrowRight' || e.key === 'ArrowDown'
                      ? 1
                      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                        ? -1
                        : 0
                  if (delta === 0) return
                  e.preventDefault()
                  const next =
                    OPTIONS[(idx + delta + OPTIONS.length) % OPTIONS.length]
                  setThemePref(next.value)
                  const group = e.currentTarget.closest('[role="radiogroup"]')
                  window.requestAnimationFrame(() => {
                    group
                      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
                      ?.focus()
                  })
                }}
                className={`relative overflow-hidden px-3 py-3 rounded-xl border text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                  active
                    ? 'bg-[var(--color-accent-subtle)] border-[var(--color-accent-border)] text-[var(--color-accent-default)]'
                    : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-border-strong)]'
                }`}
              >
                <div className="text-sm font-semibold">{opt.label}</div>
                <div
                  className={`text-[11px] mt-0.5 ${
                    active
                      ? 'text-[var(--color-accent-default)]'
                      : 'text-[var(--color-text-secondary)]'
                  }`}
                >
                  {opt.hint}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </Section>
  )
}
