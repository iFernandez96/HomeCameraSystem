import { useId, useMemo, useState } from 'react'

// iter-303 (user "instead of free-typing for the notifications, have
// a fuzzy search and a toggle on or off for each option"): a search
// box + scrollable checkbox list. Replaces the comma-separated text
// inputs in NotificationsSection.
//
// Wire contract preserved: parent state stays a `Set<string>` (or
// equivalently `string[]`); empty set / empty array means "match
// all" (the iter-205 server-side semantic). The component is a
// controlled widget — parent owns the selection.
//
// Search is a simple substring match (case-insensitive). "Fuzzy" in
// the user-facing sense — they can type "ali" and find "alice".
// We deliberately don't pull in fuse.js for this; the lists are
// short (≤ 200 names per the server's distinct_persons cap) and
// substring is plenty.

export type ToggleSearchListProps = {
  /** Section heading shown above the list. */
  label: string
  /** Plain-English explainer beneath the label. */
  helper?: string
  /** All available options. Pre-sorted by the caller. */
  options: string[]
  /** Currently-selected subset (empty = match all). */
  selected: string[]
  /** Fired with the new selection on every toggle. */
  onChange: (next: string[]) => void
  /** Disable interaction (e.g., while saving / loading). */
  disabled?: boolean
  /** Empty-list message. */
  emptyMessage?: string
}

export function ToggleSearchList({
  label,
  helper,
  options,
  selected,
  onChange,
  disabled = false,
  emptyMessage = 'Nothing to choose from yet.',
}: ToggleSearchListProps) {
  const [query, setQuery] = useState('')
  const queryId = useId()
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [options, query])

  const toggle = (opt: string) => {
    if (disabled) return
    const next = new Set(selectedSet)
    if (next.has(opt)) {
      next.delete(opt)
    } else {
      next.add(opt)
    }
    // Sort to keep the wire shape stable; the iter-205 server-side
    // filter is set-equality so order doesn't matter for matching,
    // but a deterministic order makes diffs in tests + persisted
    // state readable.
    onChange(Array.from(next).sort((a, b) => a.localeCompare(b)))
  }

  const allSelected = options.length > 0 && options.every((o) => selectedSet.has(o))
  const noneSelected = selected.length === 0

  return (
    <div className="space-y-2">
      <div>
        {/* Sunroom form rhythm: label = ink, helper = secondary. */}
        <span className="text-sm text-[var(--color-text-primary)] font-medium">{label}</span>
        {helper && (
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{helper}</p>
        )}
      </div>
      {options.length === 0 ? (
        <p className="text-xs text-[var(--color-text-tertiary)] italic px-1">
          {emptyMessage}
        </p>
      ) : (
        <>
          {/* iter-319 (mobile-view-auditor B1): `text-base` (16px) NOT
              `text-sm` (14px). iOS Safari triggers viewport zoom-to-fit
              on focus of any input under 16px font-size, even in PWA
              standalone mode, and doesn't zoom back cleanly. */}
          <input
            id={queryId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label={`Search ${label.toLowerCase()}`}
            disabled={disabled}
            className="w-full bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-base text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 disabled:opacity-50"
          />
          {/* Scrollable list. Cap height so 50 names don't push the
              save button off-screen. role=group with aria-label so
              SR users can jump in/out as a unit.
              iter-321 (desktop-view-auditor #1): bumped to lg:max-h-80
              (320 px ≈ 13 rows visible) on desktop so the user
              isn't squinting at an 8-row scroll window when the
              Settings panel has 800+ px of vertical real estate.
              Mobile keeps max-h-48 to leave room for the soft
              keyboard + Save button. */}
          <div
            role="group"
            aria-label={label}
            className="max-h-48 lg:max-h-80 overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border-subtle)]"
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-[var(--color-text-tertiary)] italic">
                No matches for &ldquo;{query}&rdquo;.
              </p>
            ) : (
              filtered.map((opt) => {
                const isOn = selectedSet.has(opt)
                return (
                  // Sunroom: selected rows sit on the accent-subtle peach
                  // paper (a LIGHT surface — text stays ink) so the "on"
                  // set scans at a glance; unselected rows warm on hover.
                  <label
                    key={opt}
                    className={`flex items-center gap-3 px-3 py-2 min-h-[44px] cursor-pointer transition-colors duration-150 ${
                      isOn
                        ? 'bg-[var(--color-accent-subtle)] hover:bg-[var(--color-accent-muted)]'
                        : 'hover:bg-[var(--color-surface-raised)] active:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={() => toggle(opt)}
                      disabled={disabled}
                      className="w-5 h-5 rounded accent-[var(--color-accent-default)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                      aria-label={`${isOn ? 'Allow' : "Don't allow"} ${opt}`}
                    />
                    <span className="text-sm text-[var(--color-text-primary)]">{opt}</span>
                  </label>
                )
              })
            )}
          </div>
          {/* Helper line under the list reflects the current
              selection state in plain English. Empty selection
              means match-all (server semantic); we surface that so
              the user doesn't think empty=zero-alerts.
              iter-321 (ux-grandpa Frank Gripe #1):
              - text-[var(--color-text-tertiary)] was barely-passing contrast (4:1
                on bg-zinc-950); bumped to text-[var(--color-text-secondary)].
              - Copy disambiguated: "no filter set" vs "all checked"
                vs "filter active". Active filter highlighted blue
                so the user knows the picker is doing something. */}
          <p
            role="status"
            aria-live="polite"
            className={`text-xs px-1 ${
              !noneSelected && !allSelected
                ? 'text-[var(--color-accent-default)]'
                : 'text-[var(--color-text-secondary)]'
            }`}
          >
            {noneSelected
              ? `No filter set — alerts come through for everyone.`
              : allSelected
                ? `All ${selected.length} checked — same as no filter.`
                : `Alerting for ${selected.length} of ${options.length} ${label.toLowerCase()}.`}
          </p>
        </>
      )}
    </div>
  )
}
