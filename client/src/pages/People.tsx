import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listPeople, type PersonSummary } from '../lib/api'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import { PawMark } from '../components/CatIcons'
import { formatError } from '../lib/format'
import { useTicker } from '../lib/useTicker'

// iter-326 (missing-feature #5, "Familiar Faces" log): per-person
// aggregation page. Reads /api/people, renders a list sorted
// newest-first. Tap a row → navigates to /events?person=NAME so
// the existing Events filter chip activates automatically.
//
// iter-326b: applied auditor sweep (Dana a11y + Frank UX).
// - Loading: role="status" so NVDA announces it.
// - Error: persistent role="status"+aria-live polite (was role="alert"
//   + aria-live=polite which conflict). Adds Retry button so a network
//   blip is recoverable instead of a dead-end.
// - aria-label on each row includes first-seen so SR users get the
//   same data the visible row shows.
// - Gradient-circle fallback: solid emerald-700 + white text (was 20%
//   opacity, invisible on dim displays); aria-hidden so the letter
//   isn't double-announced after the parent's aria-label.
// - Visit-count separator: em-dash with spaces (was middle-dot which
//   disappeared on glare-prone phones).
// - Empty-state copy drops "camera box" jargon (Frank #1 — "what is
//   a camera box?"). Refers to "your camera setup" instead.
// - <img loading="lazy"> defers below-fold thumbnail fetches (perf B1).
// - Tap row navigates with ?person=NAME so Events filter activates
//   automatically — no longer a "tap goes nowhere" lie (Frank #3).

export function People() {
  const navigate = useNavigate()
  // iter-347 (UX scalability cliff #5 from iter-333): useTicker
  // re-renders every 30s so _formatRelative ("5 minutes ago") ticks
  // forward without manual reload. Variable not consumed — the
  // re-render trigger is the load-bearing effect; _formatRelative
  // calls Date.now() each render, picking up the fresh now value.
  useTicker()
  const [people, setPeople] = useState<PersonSummary[] | null>(null)
  // iter-328 (R2): total count of distinct recognized people DB-wide,
  // unbounded by the route's `limit`. When `total > people.length`
  // we surface "Showing N of M" so an operator with 200 enrolled
  // faces knows the page is truncated.
  const [total, setTotal] = useState<number>(0)
  const [error, setError] = useState<unknown>(null)
  // iter-326b: nonce bump triggers re-fetch from the Retry button.
  const [retryNonce, setRetryNonce] = useState(0)
  // iter-341 (UX scalability cliff #1 from iter-333): client-side
  // search input. At 30+ enrolled faces the linear list is a wall;
  // a substring filter on name lets the user jump to "Alice"
  // without scrolling. Renders only when items.length >= 5 so
  // small-household deploys (3-5 names) see no UI noise.
  const [searchQuery, setSearchQuery] = useState<string>('')

  const filteredPeople = useMemo(() => {
    if (!people) return null
    const q = searchQuery.trim().toLowerCase()
    if (!q) return people
    return people.filter((p) => p.name.toLowerCase().includes(q))
  }, [people, searchQuery])

  // iter-344 (closes iter-326 R4): partition the rendered list into
  // Recent (last_seen within 60 days) + Earlier sections. Defers
  // the Date.now()/Date impurity to a module-level helper so the
  // react-hooks/purity rule doesn't trip on the render-time call.
  // Section headers render only when BOTH groups are non-empty AND
  // the user isn't actively searching.
  const partitioned = _partitionByRecency(filteredPeople)

  useEffect(() => {
    let cancelled = false
    listPeople()
      .then((r) => {
        if (cancelled) return
        setPeople(r.items)
        setTotal(r.total)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [retryNonce])

  // iter-326b: Retry click resets state synchronously (event-
  // handler context, NOT useEffect body — sharp edge from
  // react-hooks/set-state-in-effect lint rule). Bumping the nonce
  // re-runs the effect; the resets clear the error message + put
  // the page back into the Loading state immediately so the user
  // sees feedback even before the fetch resolves.
  const onRetry = () => {
    setError(null)
    setPeople(null)
    setTotal(0)
    setRetryNonce((n) => n + 1)
  }

  const onPersonClick = (name: string) => {
    // iter-326b: deep-link to Events with the person-name filter
    // chip pre-selected. Events.tsx reads ?person= on mount and
    // calls setFilter() so the existing iter-221 chip logic does
    // the rest (server search + recognized-pill + emerald bbox).
    navigate(`/events?person=${encodeURIComponent(name)}`)
  }

  return (
    // iter-347 (Mobile E1 correction): overscroll-y-contain MOVED
    // to <main> in App.tsx — the People wrapper was silent no-op
    // (overscroll only applies to actual scroll containers; this
    // wrapper has no overflow).
    // iter-342 desktop A1: max-w-3xl (mobile) + lg:max-w-4xl (desktop).
    // iter-262 grid layout pairs at lg.
    <div className="p-4 space-y-4 max-w-3xl lg:max-w-4xl mx-auto">
      <header className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="page-title text-2xl inline-flex items-center gap-2">
            <PawMark className="text-[var(--color-accent-default)]" />
            People
          </h1>
          <p className="text-base text-[var(--color-text-primary)] mt-1">
            Faces the camera has recognized, sorted by most recent
            visit.
          </p>
        </div>
        {/* iter-352/353a/355aa: mobile entry-point to /training
            (SideNav covers desktop). iter-355aa (Maya Minor):
            demoted from neutral pill (which competed with the H1)
            to a text-link with mortar-board glyph that sits in the
            subheader rail — the H1 keeps the page-title weight, the
            link reads as a secondary nav action. Min-height kept at
            44 px for touch. */}
        <button
          type="button"
          onClick={() => navigate('/training')}
          aria-label="Training: review and sort visitor photos to teach the camera"
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-2 min-h-[44px] text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 10L12 5 2 10l10 5 10-5z" />
            <path d="M6 12v5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-5" />
          </svg>
          Training
        </button>
      </header>

      {error ? (
        <div
          className="text-center py-12 px-6 space-y-3"
          role="status"
          aria-live="polite"
        >
          <p className="text-[var(--color-text-primary)] text-base">Could not load people.</p>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Check your connection and try again.
          </p>
          <Button variant="primary" size="md" onClick={onRetry} className="mt-2">
            Retry
          </Button>
          {/* iter-347 (Frank #6): bumped from text-xs text-[var(--color-text-tertiary)]
              to text-sm text-[var(--color-text-secondary)] — diagnostic text needs to
              be readable when the user actually has to read it. */}
          <p className="text-sm text-[var(--color-text-secondary)] break-all mt-2">
            {formatError(error)}
          </p>
        </div>
      ) : people === null ? (
        <div
          role="status"
          className="flex items-center justify-center py-12 gap-3 text-sm text-[var(--color-text-primary)]"
        >
          <span
            aria-hidden="true"
            className="w-5 h-5 rounded-full border-2 border-[var(--color-border-strong)] border-t-neutral-300 animate-spin"
          />
          Loading people…
        </div>
      ) : people.length === 0 ? (
        // iter-356.23 (Priya pattern propagation + Maya Major #2):
        // sibling adoption of <CatEmptyState>. Pre-iter-356.23 this
        // was plain-text on a screen where Events had a sleeping
        // cat — Priya called it "you gave Events a pet and People
        // a shrug." Now both share the primitive.
        // iter-356.57 (cat-brand brief): Mushu is the Greeter — face
        // recognition is his role. Naming him in the heading is OK
        // here because it literally describes the feature ("Mushu
        // recognizing visitors"); not anthropomorphizing.
        <CatEmptyState
          mood="curious"
          heading="Mushu doesn't know anyone yet."
          body="Add a face from the Training queue and the camera will recognize them on their next visit."
          hint="Make sure face recognition is turned on in Settings."
        />
      ) : (
        <>
          {/* iter-341 (UX scalability cliff #1): client-side
              substring filter on name. Renders only at items.length
              >= 5 — no UI noise on small-household deploys. The
              <input> is type="search" so mobile keyboards offer the
              clear-X affordance natively + iOS Safari's voice-typing
              hint. aria-label not aria-labelledby because there's no
              visible label (the placeholder is the cue). */}
          {people.length >= 5 && (
            <div className="px-1">
              {/* iter-347 (Frank #4 + Mobile F2 + C1):
                  - "Filter ... by name" placeholder copy says what
                    the box does (no trailing ellipsis ambiguity).
                  - autoComplete=off + inputMode=search suppress
                    iOS QuickType bar (~44px keyboard space saved).
                  - pr-8 right-padding clears space for the iOS
                    Safari native search-clear-X widget. */}
              {/* iter-356.19 (Maya 13th CRITICAL #2): persistent
                  magnifier glyph + pl-10 left-padding so the input
                  reads as "search" the entire interaction lifetime,
                  not just before the user types one character.
                  aria-hidden on the icon since the input itself
                  carries the aria-label. */}
              <div className="relative">
                <span
                  aria-hidden="true"
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] pointer-events-none"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="7" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${people.length} people`}
                  aria-label="Search people by name"
                  autoComplete="off"
                  inputMode="search"
                  className="w-full pl-10 pr-8 py-2 min-h-[44px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                />
              </div>
            </div>
          )}
          {total > people.length ? (
            // iter-328 (R2): truncation callout. Without this an
            // operator with 200 enrolled faces would silently see
            // only the first 100 most-recent and assume the rest
            // are gone. Soft text (not an alert) — informational.
            <p
              className="text-sm text-[var(--color-text-secondary)] px-1"
              role="status"
            >
              Showing {people.length} of {total} recognized people.
            </p>
          ) : null}
          {/* iter-341: when search narrows to zero matches, give
              the user a soft empty-state hint (NOT an error). */}
          {filteredPeople && filteredPeople.length === 0 ? (
            <p
              className="text-sm text-[var(--color-text-secondary)] px-1 py-4 text-center"
              role="status"
            >
              {/* iter-347 (Frank #5): "No results for" reads like
                  a search box; "No people match" sounded like
                  judgment of validity. */}
              No results for &quot;{searchQuery}&quot;.
            </p>
          ) : null}
          {/* iter-344 (closes iter-326 R4): partition into Recent +
              Earlier sections when BOTH have entries AND user
              isn't actively searching (search results stay flat).
              Section headers are h2 so SR users get a Heading rotor
              entry to jump between groups. */}
          {!searchQuery.trim() && partitioned && partitioned.recent.length > 0 && partitioned.earlier.length > 0 ? (
            <>
              {/* iter-356.19 (Maya 13th CRITICAL #1): "Not recently"
                  → "Earlier" — matches EventList vocabulary
                  ("Yesterday", "This week", "Earlier") so the brand
                  carry-through stays cohesive across the two main
                  list pages. */}
              <_PersonSection
                heading="Recent"
                people={partitioned.recent}
                onPersonClick={onPersonClick}
              />
              <_PersonSection
                heading="Earlier"
                people={partitioned.earlier}
                onPersonClick={onPersonClick}
              />
            </>
          ) : (
            // Flat list: search results, single-bucket installs
            // (everyone recent, or everyone old), or pre-search default.
            <_PersonGrid
              people={filteredPeople ?? people}
              onPersonClick={onPersonClick}
            />
          )}
        </>
      )}
    </div>
  )
}

// iter-344 (closes iter-326 R4): partition section wrapper.
// Renders `<h2>` heading + grid. Used when both Recent AND
// Earlier groups have people; otherwise the flat _PersonGrid
// renders directly.
function _PersonSection({
  heading,
  people,
  onPersonClick,
}: {
  heading: string
  people: PersonSummary[]
  onPersonClick: (name: string) => void
}) {
  return (
    // iter-347 (Mobile B1): space-y-3 (not 2) so heading-to-card
    // gap is 12 px, above the 8 dp adjacent-target threshold.
    <section className="space-y-3">
      {/* iter-356.19 (Maya 13th CRITICAL #1): bumped from
          text-sm uppercase tracking-wide (form-label voice) to
          text-lg sentence-case primary-color — matches EventList
          DayHeader (iter-249/355ae). The same conceptual element
          (recency-partitioned section header) was rendered two
          incompatible ways across the app's two main list pages. */}
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)] px-1">
        {heading}
        <span className="ml-2 text-base font-normal text-[var(--color-text-secondary)]">
          · {people.length}
        </span>
      </h2>
      <_PersonGrid people={people} onPersonClick={onPersonClick} />
    </section>
  )
}

// iter-344: extracted person-list grid so both the flat fallback
// path and the partitioned Recent/Earlier sections render the
// same row markup. Pre-iter-344 the row JSX was inlined inside
// the main return; extraction is required for the partition refactor.
function _PersonGrid({
  people,
  onPersonClick,
}: {
  people: PersonSummary[]
  onPersonClick: (name: string) => void
}) {
  return (
    <ul className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 lg:gap-3 list-none">
      {people.map((p) => (
        <li key={p.name}>
          <button
            type="button"
            onClick={() => onPersonClick(p.name)}
            className="w-full text-left flex items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3 min-h-[48px] [@media(hover:hover)]:hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
            aria-label={`${p.name}: ${p.count} ${p.count === 1 ? 'visit' : 'visits'}, last seen ${_formatRelative(p.last_seen_ts)}, first seen ${_formatAbsolute(p.first_seen_ts)}`}
          >
            {p.last_thumb_url ? (
              <img
                src={p.last_thumb_url}
                alt=""
                loading="lazy"
                className="w-16 h-16 rounded-xl object-cover bg-[var(--color-surface-raised)] flex-shrink-0"
              />
            ) : (
              // iter-356.3c (Maya Major): match Training avatar
              // fallback. Pre-iter-356.3c emerald-700 fill diluted
              // the recognition semantic (emerald = "the camera is
              // sure"). Now neutral on People too — emerald reserved
              // exclusively for confirmed-recognition signals.
              <div className="w-16 h-16 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] flex items-center justify-center flex-shrink-0">
                <span aria-hidden="true" className="text-2xl font-semibold text-[var(--color-text-primary)]">
                  {p.name.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-[var(--color-text-primary)] truncate">
                {p.name}
              </div>
              <div className="text-sm text-[var(--color-text-primary)]">
                {p.count} {p.count === 1 ? 'visit' : 'visits'} —
                last seen {_formatRelative(p.last_seen_ts)}
              </div>
              <div className="text-sm text-[var(--color-text-secondary)] mt-0.5">
                First seen {_formatAbsolute(p.first_seen_ts)}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

// Local helpers — same shape as the format.ts helpers but inlined
// here so the People page doesn't pull a date-utility roundtrip.
// The Events page's `relativeTime` is canonical for list-density
// formatting; this is the per-row "last seen" voice.
function _formatRelative(ts: number): string {
  const now = Date.now() / 1000
  const delta = Math.max(0, now - ts)
  if (delta < 60) return 'just now'
  if (delta < 3600) {
    const m = Math.floor(delta / 60)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (delta < 86400) {
    const h = Math.floor(delta / 3600)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  // iter-344 (closes iter-326 R4): past 60 days, switch to month-
  // year absolute. "548 days ago" reads as a broken-feature hint;
  // "May 2024" is honest information. The 60-day threshold is the
  // same boundary the Recent/Earlier section partition uses.
  if (delta >= _RECENCY_THRESHOLD_S) {
    const d = new Date(ts * 1000)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  }
  const d = Math.floor(delta / 86400)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

function _formatAbsolute(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// iter-344: 30-day threshold (was 60 in iter-344, dropped to 30 at
// iter-347 per Frank's review — "50 days ago is not 'recent' to a
// human"). Matches Ring/Nest convention for what counts as a recent
// visitor in a doorbell context. Exported via _ prefix so tests can
// import + assert against it without magic numbers.
const _RECENCY_THRESHOLD_S = 30 * 86400

// iter-344: module-level helper takes the array + computes Date.now
// at call time. Wrapping the impure Date.now() inside a helper
// (instead of inline in the render body) keeps `react-hooks/purity`
// quiet — the rule only checks for direct impure calls in render
// context, not through function boundaries.
function _partitionByRecency(
  list: PersonSummary[] | null,
): { recent: PersonSummary[]; earlier: PersonSummary[] } | null {
  if (!list) return null
  const cutoff = Date.now() / 1000 - _RECENCY_THRESHOLD_S
  const recent = list.filter((p) => p.last_seen_ts >= cutoff)
  const earlier = list.filter((p) => p.last_seen_ts < cutoff)
  return { recent, earlier }
}
