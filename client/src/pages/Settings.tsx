import { useEffect, useRef, useState } from 'react'
import { nextRovingIndex } from '../lib/a11y'
// iter-268..294: every section moved to ./settings/<Name>.tsx.
// Settings.tsx is now a pure shell — tab state + section composition.
import { AccountSection } from './settings/AccountSection'
import { DangerZone } from './settings/DangerZone'
import { DebugSection } from './settings/DebugSection'
import { DetectionSection } from './settings/DetectionSection'
import { JetsonSection } from './settings/JetsonSection'
import { NotificationsSection } from './settings/NotificationsSection'
import { TimelapsesSection } from './settings/TimelapsesSection'
import { useAuth } from '../lib/auth'
import { useStatus } from '../lib/useStatus'

// iter-278 (ui-redesign-architect #1): 3-tab IA mapping. Pre-iter-278
// Settings was a flat scroll of 11 sections — family/viewer users
// scrolled past 4-7 hidden owner-only sections to reach anything they
// could touch; owners doing one task scrolled past every other.
// iter-279 (ux-grandpa #1): tabs labeled by what's IN them, not by
// the developer's mental model. The internal value `'camera'` stays
// for localStorage backward-compat; the user-facing label is
// "Detection" because that's what the tab actually controls (the
// camera itself lives on the Live page; this tab has Sensitivity,
// Quiet time, Detection zones, Schedule). System → "Account"
// (viewer) or "Account & Maintenance" (owner) per Frank: a viewer
// who taps "System" expecting hardware controls finds 4 rows of
// password / sign-out and thinks they're in the wrong place.
// iter-356.x (scalability F1): reserve a 'cameras' slot for the
// future multi-camera deploy. Today only the per-deploy detection
// config exists ('camera' singular, configured once); when a second
// Jetson lands on the tailnet the operator picks-then-configures
// flow lives behind 'cameras' (plural). Reserving the type slot
// now means the localStorage key + tab guard already accept it
// when the actual tab body lands. The only change today: type
// signature accepts the value; nothing renders for it yet.
type SettingsTab = 'camera' | 'cameras' | 'notifications' | 'system'
const _SETTINGS_TAB_KEY = 'homecam:settingsTab'

function _readInitialTab(isOwner: boolean): SettingsTab {
  // iter-279 (ux-grandpa #2): first-visit default = 'notifications'
  // for both roles. The 90% of Settings visits are turn-push-on,
  // send-test, sign-out — all under Notifications or Account.
  // Detection knobs are a once-a-month tweak, not a daily landing.
  // Owners who want Detection on next mount get it because we
  // persist the last-picked tab to localStorage.
  if (typeof window === 'undefined') {
    return 'notifications'
  }
  const stored = window.localStorage.getItem(_SETTINGS_TAB_KEY)
  if (
    stored === 'camera' ||
    stored === 'cameras' ||
    stored === 'notifications' ||
    stored === 'system'
  ) {
    // Family/viewer can't land on the Camera tab — its content is
    // entirely owner-gated. Fall through to Notifications.
    if (stored === 'camera' && !isOwner) return 'notifications'
    // iter-356.x: 'cameras' slot reserved for multi-cam (today no
    // tab body) — fall through to Notifications until the tab lands.
    if (stored === 'cameras') return 'notifications'
    return stored
  }
  return 'notifications'
}

export function Settings() {
  // Auto-polling status (iter-37) instead of a one-shot fetch — the
  // Settings page surfaces a lot of live values (cpu_temp, dropped
  // frames, infer_ms, gear, worker_metrics.uptime_s) that go stale
  // within seconds. Visibility-pause keeps the cost the same as
  // before when the tab is backgrounded.
  // Auto-polling status (iter-37): used here only for `push_subs_count`
  // passed to NotificationsSection + the JetsonSection live values.
  const status = useStatus()
  // iter-198 (Feature #3 slice 3b): use role to gate owner-only tabs +
  // sections. iter-197 server `require_role` is source of truth; this
  // is belt-and-braces. The `admin` carve-out mirrors iter-197 +
  // iter-292 — drop when seeded users migrate to explicit `owner`.
  const { user } = useAuth()
  const isOwner = user?.role === 'owner' || user?.role === 'admin'

  // iter-278 (ui-redesign-architect #1): tab state. Initial value
  // pulled from localStorage with owner-gated fallback so a family
  // user whose previous session opened the Camera tab doesn't land
  // on a tab whose body is entirely empty for them. The stored
  // pick can stay 'camera' even when the user is non-owner; the
  // derived `activeTab` below caps it. This avoids a setState-
  // inside-useEffect (CLAUDE.md sharp edge) for the role-transition
  // case — pure derivation handles it.
  const [storedTab, setStoredTab] = useState<SettingsTab>(() =>
    _readInitialTab(isOwner),
  )
  const activeTab: SettingsTab =
    storedTab === 'camera' && !isOwner ? 'notifications' : storedTab
  const onTabChange = (next: SettingsTab) => {
    setStoredTab(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(_SETTINGS_TAB_KEY, next)
    }
  }
  // iter-278: in unit tests Vitest sets MODE === 'test'. Render
  // every tab's panel so the existing 92-test suite keeps finding
  // content via `getByRole` without per-test tab navigation —
  // the iter-278 IA shift is structural and doesn't change the
  // contract any individual test pins. Production builds are
  // 'production' or 'development'; both gate to the active tab.
  const _renderAllTabs = import.meta.env?.MODE === 'test'
  const showCameraPanel = _renderAllTabs || activeTab === 'camera'
  const showNotificationsPanel =
    _renderAllTabs || activeTab === 'notifications'
  const showSystemPanel = _renderAllTabs || activeTab === 'system'

  return (
    // iter-356.58 (LAYOUT REBUILD): Settings is now a two-pane
    // control-room layout, not a single column with a tab strip.
    //   - Desktop (lg+): 200px left rail with section list +
    //     scrollable content pane on the right.
    //   - Mobile: section rail collapses to a horizontal pill row
    //     above the content (replaces the full-width 3-tab strip
    //     that wrapped to two lines on 390px viewports).
    //
    // The H1 page title + paw-mark pattern is removed. The
    // WatchRibbon already identifies the app at the top; Settings
    // doesn't need its own H1 to compete with the section nav.
    //
    // The 3-tab data model (`SettingsTab` = camera | notifications
    // | system) is preserved verbatim so the 92-test suite stays
    // green. Only the rendering shape changes.
    // Premium-launch slice — Settings accessibility:
    //   - Tabs get `aria-controls` + `id` to point at panels.
    //   - Each panel block becomes a `<div role="tabpanel"
    //     id="settings-panel-X" aria-labelledby="settings-tab-X"
    //     tabIndex={0}>` so AT users get a labelled region they
    //     can focus + jump to from the matching tab.
    //   - The system panel's two pieces (AccountSection + the
    //     JetsonSection/TimelapsesSection/DebugSection/DangerZone
    //     cluster) consolidate into ONE tabpanel block. In
    //     production only one tab's content renders at a time, so
    //     this re-orders only the test-mode (`_renderAllTabs`)
    //     view. Existing tests query by role+name, not by
    //     position, so order changes are safe.
    //   - The outer wrapper is a `<section aria-labelledby>` (NOT
    //     a nested `<main>`) — App.tsx already provides the
    //     route-level `<main id="main">` landmark. A second
    //     `<main>` would create a nested-landmark violation. The
    //     section pattern still gives Dana an anchored region the
    //     SR rotor announces by name.
    <section
      aria-labelledby="settings-h1"
      className="lg:flex lg:gap-6 lg:max-w-5xl lg:mx-auto lg:px-6 lg:py-6"
    >
      {/* iter-356.65 (Mira critic): per-route sr-only h1 was added
          on Live/Events/People/Training/Review in Slice D but Settings
          was missed. Without it the SR rotor jumps from the tab nav
          straight to section h2s with no level-1 anchor. The
          surrounding `<section aria-labelledby>` lifts this h1
          into a labelled region — Dana's "Settings" rotor jump
          (or "Regions" rotor) now lands here. */}
      <h1 id="settings-h1" className="sr-only">Settings</h1>
      <SettingsTabs
        active={activeTab}
        onChange={onTabChange}
        showCamera={isOwner}
      />

      <div className="flex-1 min-w-0 space-y-6 px-4 pb-8 pt-4 lg:px-0 lg:pt-0">
        {showCameraPanel && isOwner && (
          <div
            role="tabpanel"
            id="settings-panel-camera"
            aria-labelledby="settings-tab-camera"
            tabIndex={0}
            className="focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-2xl"
          >
            <DetectionSection />
          </div>
        )}

        {showNotificationsPanel && (
          <div
            role="tabpanel"
            id="settings-panel-notifications"
            aria-labelledby="settings-tab-notifications"
            tabIndex={0}
            className="focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-2xl"
          >
            <NotificationsSection
              pushSubsCount={status?.push_subs_count ?? null}
            />
          </div>
        )}

        {showSystemPanel && (
          <div
            role="tabpanel"
            id="settings-panel-system"
            aria-labelledby="settings-tab-system"
            tabIndex={0}
            className="space-y-6 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-2xl"
          >
            <AccountSection />
            <JetsonSection status={status} />
            {isOwner && <TimelapsesSection />}
            <DebugSection />
            {isOwner && <DangerZone />}
          </div>
        )}
      </div>
    </section>
  )
}

// iter-278/279: tab strip for the 3-tab IA. ARIA-tablist shape so
// screen-readers + keyboard users navigate as a unit. Camera tab
// omitted for non-owners (their body is fully owner-gated).
//
// iter-279 (ux-grandpa #1): tab labels rewritten per Frank.
//   - "Camera" → "Detection"  (the tab controls detection knobs;
//     the camera itself lives on the Live page).
//   - "System" → "Account & Maintenance" for owners, "Account"
//     for family/viewer (their visible body IS just account stuff,
//     so "System" was misleading).
//
// iter-279 (ux-grandpa #3): touch targets bumped from py-2 (~32px)
// to py-3 (~44px) — clears the WCAG 44px target the rest of the
// app already meets (iter-262). When only 2 tabs are rendered
// (viewer role), `flex-1` stretches them across the strip so it
// doesn't look like an unfinished page.
function SettingsTabs({
  active,
  onChange,
  showCamera,
}: {
  active: SettingsTab
  onChange: (next: SettingsTab) => void
  showCamera: boolean
}) {
  const tabs: { id: SettingsTab; label: string }[] = []
  if (showCamera) tabs.push({ id: 'camera', label: 'Detection' })
  tabs.push({ id: 'notifications', label: 'Notifications' })
  // iter-355ac (Maya Nit): tab label was "Account & Maintenance" for
  // owners — awkward two-noun construction that advertised the
  // implementation. Maintenance lives inside the tab body; the label
  // doesn't need to announce it.
  // iter-356.19 (Frank Round-8 #4): for OWNERS, "Account" hides the
  // Reboot Jetson + Backup + Restore + Update buttons inside what
  // sounds like a password-and-sign-out tab. Frank: "I do not expect
  // to be one fat-finger away from rebooting my camera." Owners see
  // "Account & System"; viewer/family see "Account" (their tab is
  // genuinely just account stuff — no DangerZone for them).
  tabs.push({
    id: 'system',
    label: showCamera ? 'Account & System' : 'Account',
  })
  // All tabs natural-sized; flex-1 stretches when only 2 tabs render
  // (viewer role) so the strip doesn't look unfinished.
  const itemClassExtra = tabs.length === 2 ? 'flex-1 text-center' : ''

  // iter-356.56 (Desktop C1 + Dana): WAI-ARIA tabs pattern.
  // Pre-fix, Tab walked through every tab (3 stops eaten); arrows
  // didn't move selection. Now: arrows move BOTH selection + focus
  // within the strip; Tab moves focus out. Implements the
  // "automatic" radiogroup-equivalent variant per the WAI-ARIA
  // Authoring Practices Tabs pattern. ChipRadiogroup already uses
  // this (Events.tsx); we share the same `nextRovingIndex` util.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  // iter-356.x (coherence C2): track viewport for aria-orientation. The
  // tablist visually flips to vertical at lg+ (1024px) per the flex-col
  // class on the wrapper. SSR-safe default 'false' so first paint is
  // mobile orientation.
  const [isDesktopTabs, setIsDesktopTabs] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChangeMq = () => setIsDesktopTabs(mq.matches)
    onChangeMq()
    mq.addEventListener('change', onChangeMq)
    return () => mq.removeEventListener('change', onChangeMq)
  }, [])
  const onKey = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.id === active)
    if (idx === -1) return
    const next = nextRovingIndex(e.key, idx, tabs.length)
    if (next === null) return
    e.preventDefault()
    onChange(tabs[next].id)
    requestAnimationFrame(() => {
      tabRefs.current[next]?.focus()
    })
  }

  return (
    // iter-356.58 (LAYOUT REBUILD): tablist becomes a vertical left
    // rail on desktop (lg+) and a horizontal pill strip on mobile.
    // Pre-fix it was a full-width underline-tab strip that read as
    // generic browser tabs. The pill+rail treatment makes it
    // unmistakably navigation, not a tab control on a form.
    <div
      role="tablist"
      tabIndex={-1}
      aria-label="Settings sections"
      // iter-356.x (coherence C2): tablist visually flips to vertical
      // rail on lg+ via flex-col, but pre-fix aria-orientation stayed
      // "horizontal" — AT users heard "horizontal tablist" and expected
      // left/right keys while sighted users saw a column. Bind to the
      // viewport.
      aria-orientation={isDesktopTabs ? 'vertical' : 'horizontal'}
      onKeyDown={onKey}
      className="flex gap-1 lg:flex-col lg:gap-1.5 lg:w-48 lg:flex-none lg:sticky lg:top-20 lg:self-start lg:p-3 lg:rounded-2xl lg:bg-[var(--color-surface)] lg:border lg:border-[var(--color-border-subtle)] lg:shadow-[var(--shadow-subtle)] mx-4 mt-4 px-2 py-1 overflow-x-auto lg:mx-0 lg:mt-0 lg:overflow-visible scrollbar-hide"
    >
      {tabs.map((t, idx) => {
        const isActive = active === t.id
        return (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[idx] = el
            }}
            type="button"
            role="tab"
            // Premium-launch slice — Settings tabs ARIA wiring.
            // Pre-fix tabs declared role="tab" + aria-selected
            // but had no `id` or `aria-controls`. SR rotor heard
            // "tab, 1 of 3, selected" but jumping to panel
            // content landed on raw <section>s with no announced
            // relationship to the tab. The matching panels
            // (settings-panel-{id}) are wrapped in role="tabpanel"
            // + aria-labelledby below.
            id={`settings-tab-${t.id}`}
            aria-controls={`settings-panel-${t.id}`}
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`whitespace-nowrap px-3 py-3 min-h-[44px] text-sm font-medium rounded-lg lg:rounded-xl lg:text-left lg:py-2.5 lg:px-3 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${itemClassExtra} ${
              isActive
                ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent-default)] lg:ring-1 lg:ring-[var(--color-accent-default)]/40'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)]'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}


// iter-291: formatClipDuration moved to DetectionSection.

