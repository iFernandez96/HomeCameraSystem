import { useRef, useState } from 'react'
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
import { PawMark } from '../components/CatIcons'
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
type SettingsTab = 'camera' | 'notifications' | 'system'
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
    stored === 'notifications' ||
    stored === 'system'
  ) {
    // Family/viewer can't land on the Camera tab — its content is
    // entirely owner-gated. Fall through to Notifications.
    if (stored === 'camera' && !isOwner) return 'notifications'
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
    // iter-286 (desktop-view-auditor A1): cap the Settings page at
    // max-w-4xl on desktop so the iter-278 tab strip doesn't run as
    // an empty horizontal rule across a 1920 monitor — pre-iter-286
    // the strip's content was ~480 px and the bottom border ran
    // ~1180 px right of the last tab. ManageUsersPanel rows and
    // ZoneEditor inherit the same cap. Mobile keeps the full-width
    // layout (no `max-w-*` below `lg:`).
    <div className="p-4 space-y-6 pb-8 lg:max-w-4xl lg:mx-auto">
      <h1 className="page-title text-2xl inline-flex items-center gap-2">
        <PawMark className="text-[var(--color-accent-default)]" />
        Settings
      </h1>

      {/* iter-278: 3-tab IA. Tabs are surface-level navigation; the
          underlying Section components are unchanged. Family/viewer
          users see Notifications + System; the Camera tab is hidden
          for them because its body is fully owner-gated. */}
      <SettingsTabs
        active={activeTab}
        onChange={onTabChange}
        showCamera={isOwner}
      />

      {/* iter-278: each tab's content lives in a `<div hidden=...>`
          panel rather than a conditional `{activeTab === X && (...)}`.
          The hidden attribute keeps inactive content out of the
          flow + accessibility tree (so SR users hear ONLY the
          active tab) while leaving it in the DOM. This preserves
          the React component state across tab switches AND lets
          test queries find content regardless of which tab is
          active — the behavioral contract of `screen.getByText('X')`
          is "is X anywhere in the rendered tree", and that intent
          is unchanged across the iter-278 IA shift. */}
      {/* iter-294: Account section + serverVersion state extracted
          to ./settings/AccountSection.tsx. */}
      {showSystemPanel && <AccountSection />}

      {showNotificationsPanel && (
        <NotificationsSection
          pushSubsCount={status?.push_subs_count ?? null}
        />
      )}

      {/* iter-198 (Feature #3 slice 3b): Detection knobs / What to
          detect / Detection zones / Schedule sections all PATCH
          /api/detection/config which iter-197 gated `require_role
          ("owner")`. Hide them entirely from non-owner users —
          presenting controls that would 403 on commit is bad UX.
          Server is still source of truth; this is belt-and-braces.
          iter-278: also gated by Camera tab; non-owners never see
          the panel (no Camera tab on the strip). The `isOwner`
          short-circuit stays so a malicious DOM mutation can't
          unhide owner-only knobs for a non-owner.
          iter-291: 240-line block extracted to
          ./settings/DetectionSection.tsx. */}
      {showCameraPanel && isOwner && <DetectionSection />}

      {showSystemPanel && (
      <>

      {/* iter-269: read-only Jetson health panel (~90 lines + 5
          helper components) moved to ./settings/JetsonSection.tsx
          to keep this file under the iter-267 audit threshold. */}
      <JetsonSection status={status} />

      {/* iter-214 (Feature #8 slice 3): owner-only timelapses
          section. iter-292 extracted to ./settings/TimelapsesSection.tsx. */}
      {isOwner && <TimelapsesSection />}

      {/* iter-356.37: Debug pane — Reload app / Reset cache & reload
          buttons + bundle ID + SW diagnostics. Available to ALL roles
          on the System tab; the buttons are local-only (no server
          side-effects), and the SW + cache state is harmless to view. */}
      <DebugSection />

      {/* iter-198/211/231/237: owner-only destructive ops
          (Backup / Update / Restore / Reboot). iter-293 extracted to
          ./settings/DangerZone.tsx. Visual gradient blue→amber→red
          maps to "safe → medium → destructive" preserved there. */}
      {isOwner && <DangerZone />}

      </>
      )}{/* end showSystemPanel */}

      {/* iter-355ac (Maya Major): footer "Home Camera" was decorative
          (no information, no interaction) and took up vertical space
          the user had to scroll past. Server version is already
          surfaced in the Account section. Drop it. */}
    </div>
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
    // iter-356.56: tabIndex={-1} on the tablist container satisfies
    // jsx-a11y/interactive-supports-focus for the role+onKeyDown
    // combination. The inner tabs carry the real Tab order via the
    // roving-tabindex pattern (active tab tabIndex=0, others -1) so
    // focusing the tablist itself is never the keyboard path.
    <div
      role="tablist"
      tabIndex={-1}
      aria-label="Settings sections"
      aria-orientation="horizontal"
      onKeyDown={onKey}
      className="flex gap-1 border-b border-[var(--color-border)]"
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
            aria-selected={isActive}
            // iter-356.56: roving-tabindex — only the active tab is in
            // the Tab order; arrow keys cycle within. Inactive tabs
            // have tabIndex=-1 so Tab leaves the strip after one stop.
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`px-4 py-3 text-sm -mb-px border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-t ${itemClassExtra} ${
              isActive
                ? 'border-[var(--color-accent-default)] text-[var(--color-text-primary)] font-semibold'
                // iter-356.56 (Desktop B1): added `hover:bg-...` so
                // cursor users get a fill change, not just text-color
                // shift. Inactive tabs were near-invisible on cream.
                : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] font-medium'
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

