import { useEffect, useState } from 'react'
import { Button } from '../../components/primitives/Button'
import { ToggleSearchList } from '../../components/ToggleSearchList'
import {
  getKnownFilterOptions,
  getMyPushFilters,
  setMyPushFilters,
} from '../../lib/api'
import { formatError } from '../../lib/format'
import {
  disablePushSubscription,
  ensurePushSubscription,
  getPushState,
  pushSupported,
  sendTestPush,
} from '../../lib/push'
import { useToast } from '../../lib/toast'
import type { PushFilters } from '../../lib/types'
import { Mono, Row, Section, Toggle } from './parts'

// iter-289: extracted from Settings.tsx (~165 lines of inline JSX +
// 7 state hooks + 3 handlers + 2 effects). Pre-iter-289 the
// Notifications section was the largest remaining inline block in
// Settings — 200+ lines of state coupled tightly to the parent.
// Pulling it out lets the rest of Settings re-render without
// touching push state, makes the notification surface
// independently testable, and keeps the iter-267 audit trajectory
// (Settings.tsx 1969 → currently ~1100 lines after iter-268/269/289).
//
// Owns its own push-toggle + filter state. Parent passes only
// `pushSubsCount` from the status snapshot — that's the one piece
// of state Notifications can't derive locally.

// iter-209: HH:MM regex, mirrored from server-side `_HHMM_PATTERN`.
const _hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/

// iter-303 (user "instead of free-typing for the notifications,
// have a fuzzy search and a toggle on or off for each option"):
// Replaced the comma-separated parseList with structured state.
// Empty array → null on the wire (the iter-205 match-all semantic);
// non-empty array → those exact values.
function listToWire(items: string[]): string[] | null {
  return items.length === 0 ? null : items
}

type FiltersInput = {
  cameras: string[]
  person_names: string[]
  schedule_start: string
  schedule_end: string
}

export function NotificationsSection({
  pushSubsCount,
}: {
  pushSubsCount: number | null | undefined
}) {
  const { showToast } = useToast()
  const [pushEnabled, setPushEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  // iter-208 (Feature #4 slice 3b): per-user push filter management.
  // `filtersInput` mirrors the iter-207 GET /api/push/filters response
  // as comma-separated strings for two text inputs. Empty input on a
  // field => null on the wire (match-all); a non-empty list => those
  // exact values. All fields empty => null filters object (full reset
  // to legacy match-all). iter-209 (slice 4): schedule_window adds a
  // third dimension — time-of-day HH:MM bounds.
  const [filtersInput, setFiltersInput] = useState<FiltersInput | null>(null)
  const [filtersLoaded, setFiltersLoaded] = useState(false)
  const [filtersSaving, setFiltersSaving] = useState(false)
  // iter-303: known options for the toggle-list pickers. Populated
  // alongside the filters fetch so both arrive together — pre-iter-303
  // there was nothing to pick from (free-text). Empty arrays render
  // as "Nothing to choose from yet." in the picker.
  const [knownCameras, setKnownCameras] = useState<string[]>([])
  const [knownPersons, setKnownPersons] = useState<string[]>([])

  // pushSupported() is a browser-feature probe — Safari without a
  // homescreen install, or any browser missing the ServiceWorker
  // and PushManager APIs, returns false.
  const pushAvailable = pushSupported()

  useEffect(() => {
    getPushState().then(setPushEnabled)
  }, [])

  // iter-208: load current per-user filters when push is enabled.
  // GET /api/push/filters 404s when the user has no subscriptions
  // yet — treat that as "no filters set" (empty inputs, match-all).
  // Don't start the load until pushEnabled flips true; before that
  // the iter-207 route would 404 every mount.
  useEffect(() => {
    if (!pushAvailable || !pushEnabled) return
    let cancelled = false
    // iter-303: fetch filters AND known-options in parallel. The
    // toggle-list picker needs both to render correctly.
    Promise.all([getMyPushFilters(), getKnownFilterOptions()])
      .then(([filtersRes, optionsRes]) => {
        if (cancelled) return
        const f = filtersRes.filters
        setFiltersInput({
          cameras: f?.cameras ?? [],
          person_names: f?.person_names ?? [],
          schedule_start: f?.schedule_window?.start ?? '',
          schedule_end: f?.schedule_window?.end ?? '',
        })
        setKnownCameras(optionsRes.cameras)
        setKnownPersons(optionsRes.person_names)
        setFiltersLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        // 404 (no subs) or transient — treat as match-all so the
        // user can still set up filters from a clean slate.
        setFiltersInput({
          cameras: [],
          person_names: [],
          schedule_start: '',
          schedule_end: '',
        })
        setFiltersLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [pushAvailable, pushEnabled])

  const togglePush = async (v: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      if (v) {
        const ok = await ensurePushSubscription()
        setPushEnabled(ok)
        if (ok) showToast('Push notifications enabled', 'success')
      } else {
        await disablePushSubscription()
        setPushEnabled(false)
        showToast('Push notifications disabled', 'info')
      }
    } catch (e) {
      showToast('Could not change push state', 'error')
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  const onTestPush = async () => {
    try {
      const sent = await sendTestPush()
      if (sent === 0) {
        showToast('No reachable subscriptions on the server', 'info')
      } else {
        showToast(
          `Test push sent to ${sent} device${sent === 1 ? '' : 's'}`,
          'success',
        )
      }
    } catch (e) {
      showToast('Test push failed: ' + formatError(e), 'error')
    }
  }

  const onSaveFilters = async () => {
    if (!filtersInput || !filtersLoaded || filtersSaving) return
    const cameras = listToWire(filtersInput.cameras)
    const person_names = listToWire(filtersInput.person_names)
    const start = filtersInput.schedule_start.trim()
    const end = filtersInput.schedule_end.trim()
    const schedule_window =
      start && end && _hhmmRe.test(start) && _hhmmRe.test(end)
        ? { start, end }
        : null
    const next: PushFilters | null =
      cameras === null && person_names === null && schedule_window === null
        ? null
        : { cameras, person_names, schedule_window }
    setFiltersSaving(true)
    try {
      await setMyPushFilters(next)
      showToast('Notification filters saved', 'success')
    } catch (e) {
      showToast('Could not save filters: ' + formatError(e), 'error')
    } finally {
      setFiltersSaving(false)
    }
  }

  const scheduleStartTrim = filtersInput?.schedule_start.trim() ?? ''
  const scheduleEndTrim = filtersInput?.schedule_end.trim() ?? ''
  const scheduleHasOne = !!scheduleStartTrim || !!scheduleEndTrim
  const scheduleBothSet = !!scheduleStartTrim && !!scheduleEndTrim
  const scheduleValid =
    !scheduleHasOne ||
    (scheduleBothSet &&
      _hhmmRe.test(scheduleStartTrim) &&
      _hhmmRe.test(scheduleEndTrim))

  // iter-296 (user feedback "I don't understand the subscribed devices
  // notifications"): contextual helper for the device-count row.
  // Pre-iter-296 the row was a bare label + number — Frank-style users
  // had no idea what "Subscribed devices: 3" meant or whether THIS
  // device was one of the three. Combining `pushEnabled` (this
  // browser's local subscription state) with `pushSubsCount` (server-
  // wide total) lets us spell out "Just this one." vs "This device
  // isn't included yet." in plain English.
  const subsHelper = (() => {
    if (pushSubsCount == null) return null
    if (pushSubsCount === 0) {
      return "No phones or computers signed up yet — turn on the toggle above to add this one."
    }
    if (pushEnabled) {
      if (pushSubsCount === 1) {
        return 'Just this one.'
      }
      const others = pushSubsCount - 1
      return `This device, plus ${others} other${others === 1 ? '' : 's'}.`
    }
    if (pushSubsCount === 1) {
      return "1 other device is signed up — this one isn't included yet."
    }
    return `${pushSubsCount} other devices are signed up — this one isn't included yet.`
  })()

  return (
    <Section title="Notifications">
      {/* iter-296: plain-English intro so the rest of the panel
          reads without prior context. */}
      <div className="px-4 py-3 text-sm text-[var(--color-text-primary)] border-b border-[var(--color-border)]">
        Get a buzz on your phone or computer when the camera spots
        someone.
      </div>
      <Row
        label="Alert this device"
        right={
          pushAvailable ? (
            <Toggle
              checked={pushEnabled}
              onChange={togglePush}
              disabled={busy}
              ariaLabel="Enable push notifications"
            />
          ) : (
            <span
              className="text-xs text-[var(--color-text-secondary)]"
              aria-label="Push not supported in this browser"
            >
              not supported
            </span>
          )
        }
      />
      {!pushAvailable && (
        <p className="px-1 -mt-1 text-xs text-[var(--color-text-secondary)]">
          Web Push needs Service Worker + PushManager. On iOS, install
          this app to your Home Screen first; on desktop, use Chrome,
          Firefox, or Edge.
        </p>
      )}
      {pushAvailable && pushEnabled && (
        <Row
          label="Send a test alert"
          right={
            <button
              onClick={onTestPush}
              className="text-[var(--color-accent-default)] text-sm focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
              aria-label="Send test notification"
            >
              Send
            </button>
          }
        />
      )}
      {/* iter-155: server-side count of live push subscriptions.
          iter-296 reframed: the bare number was meaningless to
          non-technical users, so we now pair the count with a
          contextual helper line that spells out whether THIS device
          is included. */}
      {pushAvailable && pushSubsCount != null && (
        <>
          <Row
            label="Devices getting alerts"
            right={<Mono>{pushSubsCount}</Mono>}
          />
          {subsHelper && (
            // iter-302b (accessibility-auditor #3): wrap in role=status +
            // aria-live=polite so the helper text re-announces when the
            // count or push-enabled state flips. Pre-iter-302b a SR user
            // who toggled push had to navigate back to find out the
            // updated "Just this one." line.
            <p
              role="status"
              aria-live="polite"
              className="px-4 -mt-2 pb-2 text-xs text-[var(--color-text-secondary)]"
            >
              {subsHelper}
            </p>
          )}
        </>
      )}
      {/* iter-208 (Feature #4 slice 3b): per-user notification
          filters. iter-303 (user "instead of free-typing… have a
          fuzzy search and a toggle on or off for each option"):
          replaced two free-text inputs with searchable toggle
          lists driven by GET /api/push/known_filter_options.
          Wire shape preserved (string[] | null). */}
      {pushAvailable && pushEnabled && filtersInput && (
        <div className="space-y-3 pt-2 px-4 pb-3">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Only get alerts that match these. Leave a list empty to
            allow everything in that category.
          </p>
          <ToggleSearchList
            label="People"
            helper="Tap a name to allow alerts for that person."
            options={knownPersons}
            selected={filtersInput.person_names}
            onChange={(next) =>
              setFiltersInput({ ...filtersInput, person_names: next })
            }
            disabled={!filtersLoaded || filtersSaving}
            emptyMessage="No recognized faces yet — alerts will go through for everyone."
          />
          <ToggleSearchList
            label="Cameras"
            helper="Tap a camera to allow alerts from that source."
            options={knownCameras}
            selected={filtersInput.cameras}
            onChange={(next) =>
              setFiltersInput({ ...filtersInput, cameras: next })
            }
            disabled={!filtersLoaded || filtersSaving}
            emptyMessage="No cameras have produced events yet."
          />
          {/* iter-209 (slice 4): time-of-day window. HH:MM 24h local.
              Both blank = no time gating. The Save button disables
              when only one bound is set or either is malformed — UX
              gate before the route's regex 422s. */}
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="text-sm text-[var(--color-text-primary)]">From</span>
              <input
                type="time"
                value={filtersInput.schedule_start}
                onChange={(e) =>
                  setFiltersInput({
                    ...filtersInput,
                    schedule_start: e.target.value,
                  })
                }
                placeholder="HH:MM"
                aria-label="Schedule window start time"
                className="w-full mt-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-2 text-base text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                disabled={!filtersLoaded || filtersSaving}
              />
            </label>
            <label className="flex-1">
              <span className="text-sm text-[var(--color-text-primary)]">To</span>
              <input
                type="time"
                value={filtersInput.schedule_end}
                onChange={(e) =>
                  setFiltersInput({
                    ...filtersInput,
                    schedule_end: e.target.value,
                  })
                }
                placeholder="HH:MM"
                aria-label="Schedule window end time"
                className="w-full mt-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-2 text-base text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                disabled={!filtersLoaded || filtersSaving}
              />
            </label>
          </div>
          {!scheduleValid && (
            <p
              className="px-1 text-xs text-[var(--color-danger)]"
              role="alert"
              aria-label="Schedule window validation error"
            >
              Both From and To must be HH:MM (24-hour). Leave both blank
              for no time gating.
            </p>
          )}
          {/* iter-356.19 (Frank Round-5/6/7/8 carryover): bespoke
              save button → Button primitive. Pre-iter the raw
              <button> didn't have a 44px tap target (py-1.5 = ~32px),
              didn't share the same focus-ring + loading + disabled
              treatments as DangerZone three tabs over, and didn't
              announce "Saving…" via aria-busy. Now uses the iter-
              356.2 primitive everything else uses. */}
          <Button
            variant="primary"
            size="md"
            onClick={onSaveFilters}
            disabled={!filtersLoaded || filtersSaving || !scheduleValid}
            loading={filtersSaving}
            loadingText="Saving alert settings…"
            aria-label="Save notification filters"
          >
            Save alert settings
          </Button>
        </div>
      )}
    </Section>
  )
}

// iter-290: Toggle moved to ./parts.tsx as a shared primitive.
// NotificationsSection imports the canonical version above.
