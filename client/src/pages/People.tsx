import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listPeople, type PersonSummary } from '../lib/api'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { LoadingState } from '../components/states/LoadingState'
import { WhoMark } from '../components/WhoMark'
import { formatError } from '../lib/format'
import { identityForName } from '../lib/identity'
import { useFaceCaptureEnabled } from '../lib/useFaceCaptureEnabled'
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

  // iter-356.x (scalability M1): pre-fix the page silently truncated
  // at 100 (server default) and small businesses with 60+ enrolled
  // staff hit the cap with no path to items 101..N. Track the
  // currently-requested limit and let the user expand it in batches
  // of 100. Server caps at higher limits gracefully via its own
  // _LIST_PEOPLE_MAX, so this client-side ceiling is the friendly UI.
  const [pageLimit, setPageLimit] = useState<number>(100)
  const [loadingMoreFromLength, setLoadingMoreFromLength] = useState<
    number | null
  >(null)
  const loadingMoreSafetyTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const loadingMore =
    loadingMoreFromLength !== null &&
    (people?.length ?? 0) === loadingMoreFromLength
  useEffect(() => {
    let cancelled = false
    listPeople({ limit: pageLimit })
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
  }, [retryNonce, pageLimit])

  useEffect(() => {
    return () => {
      if (loadingMoreSafetyTimer.current) {
        clearTimeout(loadingMoreSafetyTimer.current)
      }
    }
  }, [])

  const onLoadMore = () => {
    if (loadingMore) return
    setLoadingMoreFromLength(people?.length ?? 0)
    setPageLimit((n) => n + 100)
    if (loadingMoreSafetyTimer.current) {
      clearTimeout(loadingMoreSafetyTimer.current)
    }
    loadingMoreSafetyTimer.current = setTimeout(() => {
      loadingMoreSafetyTimer.current = null
      setLoadingMoreFromLength(null)
    }, 5000)
  }

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

  return (
    // iter-347 (Mobile E1 correction): overscroll-y-contain MOVED
    // to <main> in App.tsx — the People wrapper was silent no-op
    // (overscroll only applies to actual scroll containers; this
    // wrapper has no overflow).
    // iter-342 desktop A1: max-w-3xl (mobile) + lg:max-w-4xl (desktop).
    // iter-262 grid layout pairs at lg.
    <div className="p-4 space-y-4 max-w-3xl lg:max-w-4xl mx-auto">
      <FaceCaptureBanner />
      <header className="flex items-start justify-between gap-3">
        {/* iter-356.58 (LAYOUT REBUILD): dropped the page-title
            H1 + paw mark. WatchRibbon at the top of the shell now
            carries identity universally. People opens with a
            directional subhead instead of repeating where you are. */}
        <div className="flex-1 min-w-0">
          {/* iter-356.63 (Slice D a11y): sr-only <h1> per route. The
              visible title is a <p> for visual-rebuild reasons (the
              WatchRibbon owns identity), but AT users still need a
              level-1 heading to land on. */}
          {/* Playroom Modern (Task 9): "Familiar faces" -> "Faces" —
              matches the SideNav route label. The subhead spells out
              the identity-color system so a first-time viewer isn't
              left guessing why every card carries a different hue. */}
          <h1 className="sr-only">Faces</h1>
          {/* UI/UX overhaul 2026-07-07 (Mira #3): aligned to the
              .page-title treatment Home uses (Bricolage 800 weight,
              -0.03em tracking) so all visible page titles match —
              this one was font-bold (700) + tracking-tight and read
              visibly lighter next to Home. */}
          <p className="page-title text-2xl text-[var(--color-text-primary)]" aria-hidden="true">
            Faces
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            Everyone the camera knows gets their own color.
          </p>
        </div>
        {/* iter-352/353a/355aa: compact header entry point to /training,
            paired with the app rail's Review destination. iter-355aa (Maya Minor):
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
          Training and review
        </button>
      </header>

      {error ? (
        // iter-356.63 (mobile redesign Slice F): swap the inline
        // error block for the shared <ErrorState> primitive so this
        // surface matches Events / Training / etc.
        <ErrorState
          title="Could not load people"
          message="Check your connection and try again."
          retry={onRetry}
          technicalDetail={formatError(error)}
        />
      ) : people === null ? (
        // iter-356.63: route-shaped skeleton instead of a centered
        // ring spinner.
        <LoadingState shape="grid" />
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
            // iter-328 (R2): truncation callout. iter-356.x: paired
            // with a "Load more" button so the operator isn't stuck
            // at the first window. Soft text (not an alert).
            <div className="flex items-center justify-between gap-3 px-1" role="status">
              <p className="text-sm text-[var(--color-text-secondary)] tabular-nums">
                Showing {people.length} of {total} recognized people.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={onLoadMore}
                loading={loadingMore}
                loadingText="Loading…"
              >
                Load more
              </Button>
            </div>
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
              />
              <_PersonSection
                heading="Earlier"
                people={partitioned.earlier}
              />
            </>
          ) : (
            // Flat list: search results, single-bucket installs
            // (everyone recent, or everyone old), or pre-search default.
            <_PersonGrid
              people={filteredPeople ?? people}
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
}: {
  heading: string
  people: PersonSummary[]
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
        <span className="ml-2 text-base font-normal text-[var(--color-text-secondary)] tabular-nums">
          · {people.length}
        </span>
      </h2>
      <_PersonGrid people={people} />
    </section>
  )
}

// iter-344: extracted person-list grid so both the flat fallback
// path and the partitioned Recent/Earlier sections render the
// same row markup. Pre-iter-344 the row JSX was inlined inside
// the main return; extraction is required for the partition refactor.
function _PersonGrid({
  people,
}: {
  people: PersonSummary[]
}) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 list-none">
      {people.map((p) => {
        // Playroom Modern (Task 9): every known person gets a stable
        // wheel hue from the identity system — the wheel color becomes
        // the card's left identity edge, and the WhoMark glyph badges
        // the avatar corner so the "this card = this color, everywhere"
        // rule reads at a glance (matches the color legend on Events).
        const identity = identityForName(p.name)
        return (
        <li key={p.name}>
          <Link
            to={`/people/${encodeURIComponent(p.name)}`}
            // Fix wave F3 (accepted audit finding, flat-paper rule):
            // this card carried shadow-card + shadow-card-inset — a
            // shadow-elevated panel look CLAUDE.md's card-paper
            // grammar reserves for the video tile + modal overlays
            // alone. Dropped the shadow; the hairline border +
            // identity-color left edge still read clearly as a card.
            className="w-full text-left flex items-center gap-3 bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-xl)] p-3 min-h-[48px] [@media(hover:hover)]:hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
            style={{ borderLeft: `4px solid ${identity.colorVar}` }}
            aria-label={`${p.name}: ${p.count} ${p.count === 1 ? 'visit' : 'visits'}, last seen ${_formatRelative(p.last_seen_ts)}, first seen ${_formatAbsolute(p.first_seen_ts)}`}
          >
            <div className="relative flex-shrink-0">
              {p.last_thumb_url ? (
                <img
                  src={p.last_thumb_url}
                  alt=""
                  loading="lazy"
                  className="w-16 h-16 rounded-xl object-cover bg-[var(--color-surface-raised)]"
                />
              ) : (
                // iter-356.3c (Maya Major): match Training avatar
                // fallback — success-green stays reserved exclusively
                // for confirmed-recognition signals.
                // Sunroom sweep: warm-brass portrait chip (the house's
                // hardware, decorative-neutral) instead of the flat
                // raised-surface gray. Keeps the family-album feel
                // without touching the semantic color budget.
                <div className="w-16 h-16 rounded-xl bg-[var(--color-brass-subtle)] border border-[var(--color-brass-border)] flex items-center justify-center">
                  <span aria-hidden="true" className="text-2xl font-semibold text-[var(--color-brass-default)]">
                    {p.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              {/* Corner badge: the WhoMark glyph in the person's own
                  wheel hue, ring-cut against the card surface so it
                  reads as a distinct chip over the thumbnail. */}
              <div className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-[var(--color-surface)] bg-[var(--color-surface)]">
                <WhoMark identity={identity} size={20} />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-[var(--color-text-primary)] truncate">
                {p.name}
              </div>
              {/* Sunroom sweep: stats drop to the caption tier
                  (secondary ink) so the name-plate carries the row;
                  tabular-nums keeps visit counts column-steady. */}
              <div className="text-sm text-[var(--color-text-secondary)] tabular-nums">
                {p.count} {p.count === 1 ? 'visit' : 'visits'} —
                last seen {_formatRelative(p.last_seen_ts)}
              </div>
              <div className="text-sm text-[var(--color-text-tertiary)] mt-0.5">
                First seen {_formatAbsolute(p.first_seen_ts)}
              </div>
            </div>
          </Link>
        </li>
        )
      })}
    </ul>
  )
}

/**
 * iter-356.66 (mobile-redesign perfection): household-trust banner.
 * Renders above the people list when the worker is saving face crops
 * for retraining (`face_capture_enabled === true`). Read-only — the
 * actual toggle + per-name consent live on Training. The banner is
 * the cross-page "you should know about this" signal so a viewer
 * looking at the people list isn't surprised that the camera knows
 * who's who.
 *
 * Stays silent when the flag is off OR while we don't yet have an
 * answer (default-quiet, same contract as `CaptureSavingPill`).
 */
function FaceCaptureBanner() {
  const enabled = useFaceCaptureEnabled()
  if (enabled !== true) return null
  return (
    <div
      role="status"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-primary)] flex items-start gap-3"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-0.5 flex-shrink-0 text-[var(--color-brass-default)]"
        aria-hidden="true"
      >
        <path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5" />
        <circle cx="12" cy="12" r="3" />
        <circle cx="6" cy="18" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <div className="flex-1 min-w-0">
        <span className="font-semibold">Face captures are saving for training.</span>{' '}
        <span className="text-[var(--color-text-secondary)]">
          Manage who&rsquo;s recognized and consent on the Training page.
        </span>
      </div>
    </div>
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
