import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
// iter-356-E (Slice E): EventHeatmap lazy-split. The component pulls
// in ~6 KB gzip of date math + SVG cells and is below-the-fold on
// mobile (the calendar is opened via the header button OR sits in the
// lg+ right rail). Deferring it cuts the Events route's first paint.
const EventHeatmap = lazy(() => import('../components/EventHeatmap.lazy'))
import { EventList } from '../components/EventList'
import { HourBand } from '../components/HourBand'
import { EventListSkeleton, HeatmapSkeleton } from '../components/Skeleton'
import { ErrorState } from '../components/states/ErrorState'
import { Button } from '../components/primitives/Button'
import {
  deleteEvent,
  deleteEventsByDay,
  exportEvents,
  fetchEvents,
  getDetectionConfig,
  markAllEventsSeen,
  markEventSeen,
  searchEvents,
} from '../lib/api'
import { nextRovingIndex } from '../lib/a11y'
import { clockTime } from '../lib/eventLabel'
import { identityForName } from '../lib/identity'
import { log, errFields } from '../lib/log'
import { useAuth } from '../lib/auth'
import { useConfirm } from '../lib/confirm'
import { formatError } from '../lib/format'
import { useStatus } from '../lib/useStatus'
import { useReportError, useToast } from '../lib/toast'
import { subscribeEvents } from '../lib/ws'
import type { DetectionEvent } from '../lib/types'

// iter-220 (Feature #6 slice 6): page size for the iter-219 search
// route. Initial fetchEvents() returns up to 100; once the user hits
// Load more, we ask the search route for another 50 older events
// per click. Smaller page = snappier UX while still amortizing the
// round-trip cost.
const _LOAD_MORE_PAGE = 50
// iter-272 (performance-auditor #2): hard cap the events array at
// 500 even on the Load-more path. Pre-iter-272 the live tail was
// capped at 200 (iter-? `[e, ...cur].slice(0, 200)` for incoming
// events) but `loadMore` was unbounded — a user with 6+ months of
// events tapping Load more enough times rendered N×6 EventCards
// (~6 DOM nodes each) and pegged the iter-? grid layout. The
// iter-219 server-side search route is the right surface for
// "find a specific event in 6 months of history" — Load more is
// for casual browsing of the recent past. 500 cards is well past
// the natural browse window and well before the React render cliff.
const _LOAD_MORE_CAP = 500

/** Filter token: 'all' = no filter, '__unknown__' = events without a face
 * match, any other string = exact person_name match. */
type PersonFilter = 'all' | '__unknown__' | string

export function Events() {
  const { user } = useAuth()
  const isOwner = user?.role === 'owner' || user?.role === 'admin'
  const confirm = useConfirm()
  const { showToast } = useToast()
  // docs/logging_plan.md §1.3: pair destructive/export error-toasts
  // with structured log.error so the user message + device log align.
  const reportError = useReportError()
  // iter-356.24 (Frank carryover): pull worker_alive + detection_active
  // so the EventList empty state can branch between "all is calm" and
  // "camera is offline" instead of showing the same sleeping cat for
  // both. 5s poll cadence (the useStatus default) is right — the
  // empty-state-vs-offline distinction is a setup-time call, not a
  // millisecond-real-time one. Existing useStatus visibility-pause
  // (iter-37) handles backgrounded tabs.
  const status = useStatus()
  // iter-326b: read ?person=NAME from the URL on mount so the People
  // page (and any other deep-link source) can land users with the
  // chip pre-selected. Empty string / missing param → 'all' default.
  // We seed setFilter from the URL inside useState's lazy initializer
  // so the very-first fetchEvents call already carries person_name —
  // no flash of unfiltered list.
  const [searchParams] = useSearchParams()
  const [events, setEvents] = useState<DetectionEvent[]>([])
  const [loading, setLoading] = useState(true)
  // Store the raw thrown value so a future render can branch on
  // `error instanceof HttpError && error.status === N` (the iter-122
  // sharp edge). Pre-iter-166 we stringified at catch time, which
  // collapsed every error to plain text and made status-based
  // branching impossible. The render path below uses `formatError`
  // (lib/format.ts) for the user-visible message.
  const [error, setError] = useState<unknown>(null)
  // iter-203 (Feature #1 slice 3): row tap opens ClipModal which
  // tries the iter-201 `/api/events/{id}/clip` route, falling back
  // to the snapshot at `event.thumb_url` if the clip isn't recorded
  // yet (slice 2 not deployed) or has been pruned. We track the
  // whole event (NOT just thumb_url) because ClipModal needs both
  // `id` (for the clip URL) and `thumb_url` (for the fallback).
  const [selectedEvent, setSelectedEvent] = useState<DetectionEvent | null>(null)
  const [filter, setFilter] = useState<PersonFilter>(() => {
    // iter-326b: lazy initializer reads ?person= from URL once on
    // mount. Decoded already by URLSearchParams. Empty/missing →
    // 'all'. The chip-state setter still works post-mount so the
    // user can change the filter in-page.
    const seed = searchParams.get('person')
    return seed && seed.length > 0 ? (seed as PersonFilter) : 'all'
  })
  // iter-329 (missing-feature #1, Per-Object-Class Detection): when
  // detection emits multiple COCO classes (person + dog + car +
  // package etc.), let the user filter the event list by class
  // label. null = no label filter (show all classes). The chip
  // row above the existing person-name row only renders when 2+
  // distinct labels are present in the visible events — single-
  // class deploys see no UI noise.
  const [labelFilter, setLabelFilter] = useState<string | null>(null)
  // iter-220 (Feature #6 slice 6): pagination state. `hasMore`
  // starts true so the Load more button is shown when initial
  // fetchEvents fills the default page (100 events). Set to
  // false when a search returns next_cursor === null (last page).
  // `loadingMore` debounces concurrent clicks and shows a spinner.
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // iter-223 (Feature #6 slice 7b-client): selected day from the
  // heatmap. When set, the events list is replaced with that day's
  // events (`searchEvents({since_ts, until_ts})`) and a "Clear"
  // chip appears in the heatmap header. Null = no day filter.
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  // iter-322 (user "make it so I can check the captures for a
  // specific time of the day"): when a day filter is active,
  // optional HH:MM start + end narrow the window. null = use the
  // full day's midnight bounds. Both fields are independently
  // optional — leaving end null means "from start to end of day".
  const [dayStartTime, setDayStartTime] = useState<string | null>(null)
  const [dayEndTime, setDayEndTime] = useState<string | null>(null)

  // iter-251: calendar collapsed by default. The heatmap takes ~120
  // px of vertical space — for the typical "I just want to see the
  // last few events" flow that's pure noise. Toggle via the calendar
  // icon in the header; choice persists in localStorage so power
  // users get their preferred default back on next visit. Auto-opens
  // when a day filter is active so the user can see what they
  // selected without an extra tap.
  const [calendarOpen, setCalendarOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem('homecam:calendarOpen')
    if (stored !== null) return stored === '1'
    // iter-262: default OPEN on desktop (lg breakpoint, 1024px+),
    // CLOSED on mobile. Frank's review: the wife test fails because
    // the calendar is invisible by default. On desktop there's room
    // to keep it visible; on mobile space matters. Power users
    // override via the toggle and localStorage persists their choice.
    return typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)').matches
      : false
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      'homecam:calendarOpen',
      calendarOpen ? '1' : '0',
    )
  }, [calendarOpen])

  // iter-356.16: separate state to drive the desktop right-rail
  // heatmap visibility. Persistent across resize. The mobile inline
  // heatmap uses calendarOpen (toggle-controlled); the desktop rail
  // uses isDesktopWidth (purely viewport-driven). On lg+ the toggle
  // is hidden so the user can't make the rail disappear; on < lg
  // the rail doesn't mount at all (saves DOM nodes + lets test
  // assertions about "heatmap not in DOM" remain meaningful).
  const [isDesktopWidth, setIsDesktopWidth] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(min-width: 1024px)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = (e: MediaQueryListEvent) => setIsDesktopWidth(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // iter-223: heatmap day-cell click handler. Replaces the events
  // list with the selected day's results + disables Load more (a
  // single-day window doesn't paginate the same way — pagination
  // resumes when the user clears the filter).
  // iter-224 (Feature #6 polish): also forward the active chip's
  // person_name to the search so the day-filter result matches what
  // the heatmap was visualizing. Without this the user could tap a
  // day showing 5 alice-events and see a list with 50 events most
  // not matching alice.
  // iter-322 helper: clamp a `<since,until>` day window with optional
  // HH:MM bounds. Times resolve in LOCAL time (mirrors EventHeatmap
  // dayBounds + the iter-301 server TZ alignment). Returns the same
  // wide bounds when both inputs are null/empty/malformed.
  function _narrowDayWindow(
    sinceTs: number,
    untilTs: number,
    startHHMM: string | null,
    endHHMM: string | null,
  ): { since: number; until: number } {
    const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/
    let since = sinceTs
    let until = untilTs
    if (startHHMM && hhmmRe.test(startHHMM)) {
      const [h, m] = startHHMM.split(':').map(Number)
      since = sinceTs + h * 3600 + m * 60
    }
    if (endHHMM && hhmmRe.test(endHHMM)) {
      const [h, m] = endHHMM.split(':').map(Number)
      until = sinceTs + h * 3600 + m * 60
    }
    // Defensive: end before start collapses to empty window. UI
    // disables the field combination but the server would also
    // return zero rows on inverted bounds.
    if (until < since) until = since
    return { since, until }
  }

  const onSelectDay = async (sinceTs: number, untilTs: number, day: string) => {
    // iter-322: a fresh day click always resets the time-of-day
    // bounds back to "full day" — pre-iter-322 nothing-to-reset.
    setSelectedDay(day)
    setDayStartTime(null)
    setDayEndTime(null)
    await _runDayQuery(sinceTs, untilTs, null, null)
  }

  // iter-322: extracted from onSelectDay so the time-of-day inputs
  // can re-run the search without re-clicking the heatmap cell.
  const _runDayQuery = async (
    sinceTs: number,
    untilTs: number,
    startHHMM: string | null,
    endHHMM: string | null,
  ) => {
    setLoading(true)
    setError(null)
    setHasMore(false)  // pagination doesn't apply to a day filter
    const { since, until } = _narrowDayWindow(
      sinceTs, untilTs, startHHMM, endHHMM,
    )
    try {
      const filters: Parameters<typeof searchEvents>[0] = {
        since_ts: since,
        until_ts: until,
        limit: 1000,  // upper-bound a single day (route caps at 1000)
      }
      // iter-228: forward face_unrecognized for the __unknown__ chip;
      // person_name for known-name chips. Mutually exclusive.
      if (filter === '__unknown__') {
        filters.face_unrecognized = true
      } else if (filter !== 'all') {
        filters.person_name = filter
      }
      // iter-329: forward the active label chip so day-filtered
      // queries return only matching-class events.
      if (labelFilter !== null) {
        filters.label = labelFilter
      }
      const r = await searchEvents(filters)
      setEvents(r.items)
    } catch (e) {
      // docs/logging_plan.md §2 (Events): load fail ERROR with the op
      // name so the operator can tell which fetch surfaced the
      // ErrorState — this is the day-filtered search path.
      log.error('events:load-failed', {
        op: 'searchEvents:day',
        since,
        until,
        ...errFields(e),
      })
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  // iter-322: re-derive the day's midnight bounds from the
  // selectedDay string (YYYY-MM-DD) for re-runs after time changes.
  // Local-time semantics match `EventHeatmap.dayBounds` (iter-223
  // sharp edge: NOT Date.parse which interprets as UTC).
  const _dayMidnightBounds = (day: string): { since: number; until: number } => {
    const [y, m, d] = day.split('-').map(Number)
    const start = new Date(y, m - 1, d, 0, 0, 0, 0)
    const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
    return { since: start.getTime() / 1000, until: end.getTime() / 1000 }
  }

  // iter-322: triggered when either time-of-day input changes.
  const onTimeBoundsChange = async (
    nextStart: string | null,
    nextEnd: string | null,
  ) => {
    if (selectedDay === null) return
    setDayStartTime(nextStart)
    setDayEndTime(nextEnd)
    const { since, until } = _dayMidnightBounds(selectedDay)
    await _runDayQuery(since, until, nextStart, nextEnd)
  }

  const clearDayFilter = async () => {
    setSelectedDay(null)
    setDayStartTime(null)
    setDayEndTime(null)
    setLoading(true)
    setError(null)
    setHasMore(true)
    try {
      setEvents(await fetchEvents())
    } catch (e) {
      // docs/logging_plan.md §2 (Events): load fail ERROR (op name) —
      // clearing the day filter re-fetches the recent list.
      log.error('events:load-failed', { op: 'clearDayFilter', ...errFields(e) })
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  // iter-326b: snapshot the seeded filter into a ref so the
  // mount-effect can read it without `filter` becoming a reactive
  // dependency (which would re-run the WS subscribe + markAllSeen
  // every time the user toggles a chip — wrong). The mount-time
  // value is what matters for "did we arrive here from a
  // ?person=NAME deep-link"; subsequent chip changes are handled
  // by the existing chip-change effect downstream.
  const _seededFilterRef = useRef<PersonFilter>(filter)
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      // iter-326b: when a deep-linked person filter is set on mount
      // (?person=NAME from the People page), use the iter-219 search
      // route instead of plain fetchEvents — that way Alice's
      // events surface even if she hasn't appeared in the most-
      // recent 100 events. fetchEvents stays the default for the
      // no-filter case so the existing fast-path is preserved.
      const seeded = _seededFilterRef.current
      const fetcher = seeded !== 'all'
        ? searchEvents(
            seeded === '__unknown__'
              ? { face_unrecognized: true, limit: 100 }
              : { person_name: seeded, limit: 100 },
          ).then((r) => r.items)
        : fetchEvents()
      fetcher
        .then((evs) => {
          if (!cancelled) setEvents(evs)
        })
        .catch((e) => {
          // docs/logging_plan.md §2 (Events): initial / refresh load
          // fail ERROR (op name). Logged BEFORE the cancelled guard
          // (§1.3) so an in-flight failure during unmount / tab-switch
          // is still recorded. `seeded` tells deep-link search apart
          // from the default fetchEvents fast-path.
          log.error('events:load-failed', {
            op: seeded !== 'all' ? 'searchEvents:seeded' : 'fetchEvents',
            ...errFields(e),
          })
          if (!cancelled) setError(e)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    refresh()
    // iter-248: auto-clear unread on Events tab mount. Visiting the
    // page IS the read action — same convention as Slack / Discord
    // / iOS Mail. Server flips seen=1 in bulk; we then push 0 to the
    // app-icon badge so the home-screen indicator clears within RTT.
    // Fires once per mount, not on every WS event, to avoid network
    // chatter while the user is actively scrolling the list.
    markAllEventsSeen()
      .then(() => {
        const nav = navigator as Navigator & {
          clearAppBadge?: () => Promise<void>
        }
        nav.clearAppBadge?.().catch(() => {})
      })
      .catch((e) => {
        // docs/logging_plan.md §2 (Events): mark-seen drift WARN. Still
        // best-effort (the next /unread_count poll reconciles), but a
        // persistent failure means the home-screen badge never clears —
        // worth a WARN rather than full silence.
        log.warn('events:mark-all-seen-failed', errFields(e))
      })
    const unsub = subscribeEvents((e) => {
      if (e.type === 'detection') {
        setEvents((cur) => [e, ...cur].slice(0, 200))
      }
    })
    // When the tab comes back to visible (mobile resume, desktop
    // un-minimize), the WS may have been closed by the browser and
    // reconnected with no history replay. Re-fetch /api/events so any
    // detections that fired during the disconnect window land in the
    // list. The server-side history (deque maxlen=200) holds them; we
    // just need to read it again.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      unsub()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // Derive the filter chips from observed events. Sort alphabetically so the
  // chip order is stable as new events stream in (no jitter when a name's
  // count changes).
  const personNames = useMemo(() => {
    const names = new Set<string>()
    for (const e of events) {
      if (e.person_name) names.add(e.person_name)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b))
  }, [events])
  const hasUnmatched = useMemo(() => events.some((e) => !e.person_name), [events])

  // iter-356.62 (bug #4 — type-sync with Detection Settings): the
  // class-filter chip row used to be derived from observed events,
  // which meant a multi-class deploy couldn't pre-filter by a class
  // until at least one event of that class arrived, AND the chips
  // would show classes the user had since deselected in Settings.
  // Now we read the persisted DetectionConfig.classes (the user's
  // canonical "what should I be detecting" list) and derive the
  // chip values from THAT. Falls back to the observed-events set
  // until the config arrives so the test fixtures (which don't mock
  // getDetectionConfig) still see chips.
  const [configClasses, setConfigClasses] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    getDetectionConfig()
      .then((cfg) => {
        if (!cancelled) setConfigClasses(cfg.classes)
      })
      .catch(() => {
        // Fall back to observed-events derivation on failure.
        if (!cancelled) setConfigClasses(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // iter-329: derive distinct event labels (person/dog/car/...) for
  // the per-class chip row. Sort alphabetically for stable order
  // as new events stream in.
  // iter-356.62: prefer the persisted DetectionConfig.classes when
  // available so the chip set tracks Settings, not just whatever the
  // worker happens to have emitted recently.
  const labels = useMemo(() => {
    if (configClasses !== null) {
      return [...configClasses].sort((a, b) => a.localeCompare(b))
    }
    const set = new Set<string>()
    for (const e of events) {
      if (e.label) set.add(e.label)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [events, configClasses])

  const filtered = useMemo(() => {
    let pool = events
    // iter-329: client-side label filter is the same shape as the
    // server-side filter (used by /api/events/search?label=). Apply
    // FIRST so the person-chip filter operates on the label-narrowed
    // pool — letting the user say "show all dog events" without
    // re-deriving the person-chip set.
    if (labelFilter !== null) {
      pool = pool.filter((e) => e.label === labelFilter)
    }
    if (filter === 'all') return pool
    if (filter === '__unknown__') return pool.filter((e) => !e.person_name)
    return pool.filter((e) => e.person_name === filter)
  }, [events, filter, labelFilter])

  // Playroom Modern (Task 6): the "Today, hour by hour" band reuses
  // the already-fetched `events` state (no extra fetch) — it just
  // narrows to today's local-midnight window. `todayStartTs` is
  // computed once via useMemo (same lazy-init pattern EventHeatmap
  // uses for `currentMonth()`), not recomputed per render.
  const todayStartTs = useMemo(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
  }, [])
  const todaysEvents = useMemo(
    () => events.filter((e) => e.ts >= todayStartTs),
    [events, todayStartTs],
  )

  const retry = async () => {
    setLoading(true)
    setError(null)
    setHasMore(true)
    try {
      setEvents(await fetchEvents())
    } catch (e) {
      // docs/logging_plan.md §2 (Events): load fail ERROR (op name) —
      // user-initiated Retry from the ErrorState.
      log.error('events:load-failed', { op: 'retry', ...errFields(e) })
      setError(e)
    } finally {
      setLoading(false)
    }
  }

  // iter-220: Load more — call the iter-219 search route with the
  // oldest event's ts as cursor. Append rather than replace.
  // hasMore flips to false when the server returns next_cursor:null
  // OR when a network error breaks pagination (re-arms via retry()).
  // iter-221 (slice 7): when the user has a person-name chip active,
  // forward it as `person_name` so the server returns events that
  // already match the chip — much more efficient than fetching 50
  // unfiltered older events that the client would then drop.
  // iter-228 (Feature #6 polish, closes iter-221 follow-up): the
  // `__unknown__` chip now also forwards via the iter-227
  // `face_unrecognized=true` query param — server returns only
  // events with NULL person_name. Client-side fallback retired.
  const loadMore = async () => {
    if (loadingMore || !hasMore || events.length === 0) return
    setLoadingMore(true)
    try {
      const oldest = events[events.length - 1].ts
      const filters: Parameters<typeof searchEvents>[0] = {
        before_ts: oldest,
        limit: _LOAD_MORE_PAGE,
      }
      if (filter === '__unknown__') {
        filters.face_unrecognized = true
      } else if (filter !== 'all') {
        filters.person_name = filter
      }
      // iter-329: forward the active label-chip so older events
      // hit the same class filter — without this, Load more on a
      // dog-filtered view would fetch unfiltered older events that
      // the client immediately drops in the `filtered` memo.
      if (labelFilter !== null) {
        filters.label = labelFilter
      }
      const r = await searchEvents(filters)
      // Append older events. The server returns newest-first within
      // the slice; since they're all older than `oldest`, the
      // chronological order across the whole list is preserved.
      // iter-272: cap at _LOAD_MORE_CAP so a runaway Load-more loop
      // can't push the React render past the cliff. Once the cap
      // is reached, stop offering Load more — the user has the
      // iter-219 search route (chip + heatmap + per-day filter) for
      // anything older.
      setEvents((cur) => {
        const next = [...cur, ...r.items]
        return next.length > _LOAD_MORE_CAP
          ? next.slice(0, _LOAD_MORE_CAP)
          : next
      })
      if (
        r.next_cursor === null ||
        events.length + r.items.length >= _LOAD_MORE_CAP
      ) {
        setHasMore(false)
      }
    } catch (e) {
      // docs/logging_plan.md §2 (Events): loadMore catch{} ERROR.
      // Pre-fix this swallowed silently and set hasMore=false, so a
      // pagination failure was INDISTINGUISHABLE from a genuine
      // end-of-history (the Load more button just disappears). Log the
      // reason so the operator can tell "server 500'd mid-scroll" from
      // "user reached the last page."
      log.error('events:load-more-failed', { op: 'searchEvents:loadMore', ...errFields(e) })
      // Stop offering Load more on network/auth failure — the user
      // can re-arm via the existing Retry button (clears + refetches).
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }

  // Only surface the filter row when at least one face has been matched
  // OR a second detection class has arrived — otherwise the chips
  // would just be "All / Unrecognized" with nothing useful to slice on.
  // iter-330: extended to include `labels.length > 1` so a multi-class
  // deploy with NO recognized faces still gets the class-filter row.
  // iter-356.62 (bug #4): when configClasses is populated (synced
  // from Settings) we ALWAYS show the chip row so the user can see
  // the configured class set even with only one class — that's the
  // user's "what am I detecting today" answer.
  const showFilters =
    !loading &&
    !error &&
    (personNames.length > 0 ||
      labels.length > 1 ||
      (configClasses !== null && configClasses.length >= 1))

  // iter-312 (performance-auditor #5): stable handler refs so the
  // iter-312 EventCard memo equality check sees `===` between
  // renders. Pre-iter-312 the inline `(e) => {...}` closure was
  // a fresh function on every Events render, which busted the
  // per-card memo and caused all 200 cards to re-render on every
  // WS event arrival.
  const onSelectEvent = useCallback((e: DetectionEvent) => {
    // ClipModal handles the no-clip-yet case via snapshot fallback;
    // rows without thumb_url stay non-clickable upstream.
    setSelectedEvent(e)
    // iter-276: mark THIS event seen on tap. Best-effort —
    // failure is silent.
    void markEventSeen(e.id)
      .then(() => {
        window.dispatchEvent(new CustomEvent('homecam:badge-reconcile'))
      })
      .catch((err) => {
        // docs/logging_plan.md §2 (Events): mark-seen drift WARN. A
        // 422 here means the client/worker event-id drifted; any
        // failure leaves this event stuck unread in the badge count.
        log.warn('events:mark-seen-failed', { eventId: e.id, ...errFields(err) })
      })
  }, [])

  // iter-333 (missing-feature #4 follow-up): bulk-download up to 50
  // events from the currently-filtered visible list. Pairs with the
  // iter-330 single-event Download in ClipModal; uses the same
  // exportEvents() wrapper. Capped at 50 (matches the server's
  // _EXPORT_MAX_IDS in clips.py). Fires from the day-filter banner
  // when a day is active — that's the natural "I want all of today's
  // dog events" moment. Selection-mode-checkboxes for arbitrary
  // multi-select is iter-334+ candidate.
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const _BULK_EXPORT_CAP = 50

  // iter-356.x (desktop D1 / coherence audit): multi-select bulk-
  // delete. Pre-fix the desktop user reviewing 30 days of events had
  // to tap ✕ on each card individually. Now: enter selection mode
  // via the toolbar, click cards to add to a Set, then "Delete N" to
  // bulk-remove with one confirm. Mobile keeps swipe-to-delete; the
  // mode toggle is also available there for users who prefer
  // checkboxes. Owner-only — gated by isOwner upstream.
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const onToggleSelect = useCallback((e: DetectionEvent) => {
    setSelectedIds((cur) => {
      const next = new Set(cur)
      if (next.has(e.id)) next.delete(e.id)
      else next.add(e.id)
      return next
    })
  }, [])
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
  }, [])
  const onDownloadVisible = async () => {
    if (bulkDownloading) return
    const ids = filtered.slice(0, _BULK_EXPORT_CAP).map((e) => e.id)
    if (ids.length === 0) return
    setBulkDownloading(true)
    try {
      const blob = await exportEvents(ids)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // Filename includes day-key for the common day-filter case.
      const tag = selectedDay ?? new Date().toISOString().slice(0, 10)
      a.download = `homecam_events_${tag}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      const overflowed = filtered.length > _BULK_EXPORT_CAP
      showToast(
        overflowed
          ? `Downloaded oldest ${_BULK_EXPORT_CAP} of ${filtered.length} events`
          : `Downloaded ${ids.length} ${ids.length === 1 ? 'event' : 'events'}`,
        'success',
      )
    } catch (e) {
      // docs/logging_plan.md §2 (Events): bulk export fail ERROR with
      // the id count + status so a 413 over-cap / 503 semaphore is
      // greppable rather than toast-only.
      reportError(
        'events:bulk-export-failed',
        e instanceof Error ? `Download failed: ${e.message}` : 'Download failed',
        { count: ids.length, ...errFields(e) },
      )
    } finally {
      setBulkDownloading(false)
    }
  }

  // iter-356.62 (bug #1): header is no longer sticky, so the
  // ResizeObserver that fed `--day-header-top` is no longer needed.
  // The ref is retained because `<header ref={headerRef}>` keeps it
  // for any future feature that wants the live height.
  const headerRef = useRef<HTMLElement | null>(null)

  // iter-307 (user "be able to delete events manually with a
  // confirmation, or to delete all events for a day"): owner-only
  // destructive ops. Optimistic UI — remove from local state on
  // confirm, restore + toast on server failure. ClipModal closes if
  // the deleted event was open.
  // iter-312 (performance-auditor #5): wrapped in useCallback so the
  // EventCard memo equality check sees a stable `===` ref. Reads
  // `events` + `selectedEvent` via setState callback / ref, so the
  // dep array can stay narrow.
  const onDeleteOne = useCallback(async (e: DetectionEvent) => {
    if (!isOwner) return
    // iter-356.C (mobile-redesign Slice C — security clarity):
    // confirm body identifies WHICH event will be deleted. Pre-356.C
    // body said "The event and its recorded clip…" — generic enough
    // that a user mid-scroll couldn't tell which row their click
    // had armed.
    const personOrLabel = e.person_name || e.label
    const ok = await confirm({
      title: 'Delete this event?',
      body: `Delete the ${clockTime(e.ts)} ${personOrLabel} event? The clip will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    let snapshot: DetectionEvent[] = []
    setEvents((cur) => {
      snapshot = cur
      return cur.filter((ev) => ev.id !== e.id)
    })
    setSelectedEvent((cur) => (cur?.id === e.id ? null : cur))
    try {
      await deleteEvent(e.id)
      showToast('Event deleted', 'success')
    } catch (err) {
      setEvents(snapshot)
      // docs/logging_plan.md §2 (Events): delete fail ERROR with the
      // event id + status (destructive op rolled back optimistically).
      reportError(
        'events:delete-failed',
        'Could not delete event: ' + formatError(err),
        { eventId: e.id, ...errFields(err) },
      )
    }
  }, [isOwner, confirm, showToast, reportError])

  const onBulkDelete = async () => {
    if (!isOwner || selectedIds.size === 0 || bulkDeleting) return
    const ids = Array.from(selectedIds)
    const count = ids.length
    const ok = await confirm({
      title: `Delete ${count} event${count === 1 ? '' : 's'}?`,
      body: 'Each selected event and its clip will be removed. This cannot be undone.',
      confirmLabel: `Delete ${count}`,
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    setBulkDeleting(true)
    let snapshot: DetectionEvent[] = []
    setEvents((cur) => {
      snapshot = cur
      const idSet = new Set(ids)
      return cur.filter((ev) => !idSet.has(ev.id))
    })
    setSelectedEvent((cur) => (cur && selectedIds.has(cur.id) ? null : cur))
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteEvent(id)))
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        // docs/logging_plan.md §2 (Events): bulk delete per-id reasons.
        // The allSettled rejections were only COUNTED before; surface
        // each failed id + its express reason so a partial failure
        // ("3 of 10 failed") is actually diagnosable.
        const reasons = results
          .map((r, i) =>
            r.status === 'rejected'
              ? { id: ids[i], ...errFields(r.reason) }
              : null,
          )
          .filter((x): x is NonNullable<typeof x> => x !== null)
        log.error('events:bulk-delete-partial', {
          requested: count,
          failed,
          reasons: reasons.slice(0, 20),
        })
      }
      if (failed === 0) {
        showToast(`Deleted ${count} event${count === 1 ? '' : 's'}`, 'success')
      } else if (failed < count) {
        showToast(
          `Deleted ${count - failed} of ${count} — ${failed} failed`,
          'error',
        )
      } else {
        // All failed: restore.
        setEvents(snapshot)
        showToast('Could not delete events — try again', 'error')
      }
      exitSelectionMode()
    } catch (err) {
      setEvents(snapshot)
      // docs/logging_plan.md §2 (Events): bulk delete threw outright
      // (not a per-id rejection) — log the op + reason.
      reportError(
        'events:bulk-delete-failed',
        'Bulk delete failed: ' + formatError(err),
        { requested: count, ...errFields(err) },
      )
    } finally {
      setBulkDeleting(false)
    }
  }

  const onDeleteDay = async () => {
    if (!isOwner || !selectedDay) return
    const count = events.length
    const ok = await confirm({
      title: `Delete ${count} event${count === 1 ? '' : 's'} for ${selectedDay}?`,
      body: 'Every event from this day, plus any recorded clips, will be removed. This cannot be undone.',
      confirmLabel: `Delete ${count}`,
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    try {
      const r = await deleteEventsByDay(selectedDay)
      showToast(
        `Removed ${r.deleted} event${r.deleted === 1 ? '' : 's'} for ${selectedDay}`,
        'success',
      )
      // Refresh — the day filter will now return zero rows; bounce
      // back to the unfiltered recent list so the user can see what
      // remains.
      await clearDayFilter()
    } catch (err) {
      // docs/logging_plan.md §2 (Events): delete-by-day fail ERROR with
      // the day + status (destructive owner-only op).
      reportError(
        'events:delete-day-failed',
        'Could not delete events: ' + formatError(err),
        { day: selectedDay, ...errFields(err) },
      )
    }
  }

  return (
    <div
      // iter-320 (mobile-view-auditor E1): override the App.tsx
      // hardcoded `--day-header-top` (64px) with the live measured
      // header height so DayHeader's `top: var(--day-header-top)`
      // tracks the iter-298 calendar-open vs calendar-closed shift.
      // Falls through to the App.tsx default until the first
      // ResizeObserver tick lands. Includes safe-area padding so
      // standalone-mode iOS still clears the status bar.
      // iter-356.62 (bug #1): with the header no longer sticky, the
      // DayHeader pin offset reduces to just the safe-area inset.
      // Header height is no longer subtracted since the title band
      // scrolls away. Keep the variable in scope for descendant
      // components that read --day-header-top.
      //
      // iter-356.66 (real-device fix — mobile-view-auditor A2): on
      // iOS the WatchRibbon at the top of the shell is sticky AT 56
      // px below the safe-area-top inset (App.tsx default
      // `--day-header-top: calc(56px + env(safe-area-inset-top))`).
      // This page-level override drops the 56-px addend, so the
      // DayHeader pinned to `top: var(--day-header-top)` slides
      // BEHIND the ribbon on scroll — visible in screenshots as a
      // "Today's log" band sitting on top of an event row with no
      // back-of-band over the row. Restore the 56-px clearance to
      // match the App.tsx contract.
      style={
        {
          '--day-header-top': `calc(56px + env(safe-area-inset-top))`,
        } as React.CSSProperties
      }
    >
      {/* iter-287 (desktop-view-auditor A2): the sticky page header
          on a 1920 monitor used to span the full content viewport
          (~1664 px after iter-267 dropped the inner max-w-5xl), but
          the day-headers below cap themselves naturally at the
          EventList's grid container. Visually, the page header
          looked disjoint from the cards. Cap the inner content at
          max-w-6xl to mirror the iter-262 grid width on 2xl
          breakpoints, while the bg + border still span the full
          column for the sticky-blur effect. */}
      {/* iter-298: header is the sticky container. Title-row, chips,
          day-filter banner, AND the calendar heatmap all live inside
          so they scroll-pin together on desktop (user feedback:
          "events calendar needs to anchor to the top as you scroll").
          On mobile the calendar is collapsed by default (iter-262),
          so the sticky cost is small. */}
      {/* iter-319 (mobile-view-auditor A1): `pt-[env(safe-area-inset-top)]`
          on the sticky header. The App-level `<main>` already pads
          for safe-area, but a sticky header pinned to top:0 of the
          scrollable parent doesn't inherit that padding — when the
          user scrolls one pixel on iOS Safari standalone, the header
          would overlap the status bar. Adding the safe-area inline
          here keeps the pinned header below the iOS status bar in
          standalone mode. No-op on Android Chrome (env() is 0). */}
      {/* iter-356.62 (bug #1 — user "the top Watchlog area shouldn't
          follow the user as they scroll down"): the page header used
          to be `sticky top-0` (iter-298 + iter-319 chain) which made
          the title row, chips, day-banner, AND the calendar pin to
          the viewport top. The user explicitly asked for the band to
          scroll away normally. Drop the `sticky top-0` so the header
          flows in normal block layout. The DayHeader stays sticky
          (group-level pin is wanted — user did NOT object to those)
          but we adjust `--day-header-top` to safe-area-inset-top so
          day labels pin to the actual viewport top instead of
          beneath the now-gone sticky page header. */}
      {/* iter-356.66 (real-device user feedback round 2): user said
          "the only thing that should follow the scroll is the
          calendar icon. you don't need so much space for the
          header." Round-1 sticky'd the entire <header> — title +
          Last-N + filter chips, ~150 px tall. Too much real-estate.
          Reverting <header> to normal block flow; lifting JUST the
          calendar button into a `position: fixed` floating control
          at top-right of the viewport (rendered separately below).
          The header (Watch log title + filter chips) scrolls away
          naturally; the calendar icon alone follows the user. */}
      {/* iter-356.66 (round 4 — user feedback "too much padding on
          bottom and top"): dropped the pt-[env(safe-area-inset-top)]
          from this <header>. The WatchRibbon at the top of the App
          shell already pads for the iOS notch via its own safe-area
          inset; the page <main> sits below the ribbon, so adding
          another safe-area-top here was double-padding (~44 px of
          dead space on a notched iPhone before the title). Reduced
          inner padding from pt-4/pb-3 (16/12) to pt-2/pb-2 (8/8) so
          the title row sits closer to the top edge of the page. */}
      <header
        ref={headerRef}
        className="bg-[var(--color-bg)] border-b border-[var(--color-border)]"
      >
        {/* Landscape pass (Task 1): on a landscape phone (below `lg:`,
            so the desktop `lg:max-w-6xl` centering doesn't kick in
            yet) the filters/HourBand band used to run full-bleed
            edge-to-edge on a ~980px-wide short viewport — combined
            with the (now-fixed) nav overlay, real-device feedback
            called this "huge wasted horizontal space." Centering at a
            reader-friendly max-width mirrors the `lg:` treatment one
            breakpoint early instead of forcing a bespoke two-column
            filter layout. */}
        <div className="px-4 pt-2 pb-2 landscape-phone:pt-1.5 landscape-phone:pb-1.5">
        <div className="lg:max-w-6xl lg:mx-auto landscape-phone:max-w-2xl landscape-phone:mx-auto flex items-center justify-between gap-3">
          {/* iter-356.58 (LAYOUT REBUILD): killed the page-title
              H1 with PawMark. The WatchRibbon already says where
              you are; the day-headers further down ("Today's log")
              act as the section anchor for content. The Events
              page now opens directly into the filter chips +
              timeline, no decorative title row. */}
          {/* iter-356.63 (Slice D a11y): sr-only <h1> sibling so AT
              users get a level-1 heading per route. The visible
              "Watch log" stays aria-hidden + decorative (WatchRibbon
              already carries identity).

              Premium-launch slice (Maya Critical — log-label
              triplication): pre-fix the visible decorative
              `<span>Watch log</span>` echoed BOTH the sr-only h1
              AND the day-headers below ("Today's log", "Yesterday's
              log"). A user reads "Watch log → Today's log → entries"
              — three log labels stacking. The visible span is
              dropped; the day-headers become the visible section
              anchors. The sr-only h1 stays (route-level a11y
              landmark). The right-side meta cluster (Showing N +
              Select) stays where it is — its `flex justify-between`
              parent handles a single child by hugging the right
              edge, which is the same pattern Settings + Live use
              for their "page meta" row. */}
          <h1 className="sr-only">Watch log</h1>
          <div className="flex items-center gap-3 ml-auto">
            {!loading && !error && events.length > 0 && !selectionMode && (
              // iter-356.49: "100 recent" reads as a noun-phrase
              // riddle — "100 recent what?" Now: "Last 100" /
              // "X of last 100" so it's clear the system is
              // capped at the most-recent N events fetched.
              <span className="text-xs text-[var(--color-text-secondary)] tabular-nums">
                {/* iter-356.x (scalability T2): "Last N" was misleading
                    once WS prepends + the 200-cap dropped older events
                    silently — the array was a non-contiguous window,
                    not a contiguous suffix. "Showing N" is true either
                    way. */}
                {filter === 'all'
                  ? `Showing ${events.length}`
                  : `Showing ${filtered.length} of ${events.length}`}
              </span>
            )}
            {/* iter-356.x (desktop D1): selection-mode toggle. Only
                renders for owners with at least one event; rest of the
                roles never see the affordance. The bulk-delete bar
                below replaces the count text when active. */}
            {isOwner && !loading && !error && events.length > 0 && !selectionMode && (
              <button
                type="button"
                onClick={() => setSelectionMode(true)}
                className="text-xs font-medium text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded px-1 min-h-[44px] inline-flex items-center"
                aria-label="Enter selection mode to delete multiple events"
              >
                Select
              </button>
            )}
            {/* iter-356.66 (round 2): calendar toggle moved OUT of
                the in-header position into a fixed-positioned
                floating button rendered after </header> below.
                User feedback: "the only thing that should follow the
                scroll is the calendar icon. you don't need so much
                space for the header." Original position kept on
                lg+ via the desktop heatmap rail; the in-header
                slot is gone everywhere now. */}
          </div>
        </div>
        {showFilters && (
          <>
            {/* iter-330 (ux-grandpa Frank #3 + mobile A1): class
                chip row sits ABOVE the person row — Frank reads the
                broader "what was seen" filter first, then refines by
                person name. Folded INSIDE showFilters so it collapses
                with the rest of the filter UI when the user hides
                filters (no unbounded sticky-header growth). Renders
                only when 2+ classes have arrived (avoid noise on
                single-class deploys). iter-330 (Frank #2): renamed
                from "All classes" → "All types" — drops "classes"
                jargon. */}
            {(labels.length > 1 ||
              (configClasses !== null && configClasses.length >= 1)) && (
              <ChipRadiogroup
                ariaLabel="Filter events by detection type"
                values={[null as string | null, ...labels]}
                current={labelFilter}
                onSelect={setLabelFilter}
                renderLabel={(v) =>
                  v === null
                    ? 'All types'
                    : v === 'person'
                      ? 'People'
                      : v === 'cat'
                        ? 'Cats'
                        : v.charAt(0).toUpperCase() + v.slice(1)
                }
                // Playroom Modern (Task 6): who-chips carry a 12px
                // identity-color square — person=cobalt, cat=marmalade
                // per the mockup. Other classes (dog, car, ...) have
                // no dot; they're not part of the identity system.
                dotColor={(v) =>
                  v === 'person'
                    ? 'var(--color-id-person)'
                    : v === 'cat'
                      ? 'var(--color-id-mushu)'
                      : null
                }
                marginTopClass="mt-3"
              />
            )}
            <ChipRadiogroup
              ariaLabel="Filter events by person"
              values={[
                'all' as PersonFilter,
                ...personNames as PersonFilter[],
                ...((hasUnmatched ? ['__unknown__'] : []) as PersonFilter[]),
              ]}
              current={filter}
              onSelect={setFilter}
              renderLabel={(v) =>
                v === 'all'
                  ? 'Everyone'
                  : v === '__unknown__'
                  ? 'Unrecognized'
                  : v
              }
              // Playroom Modern (Task 6): 'all' has no dot (catch-all);
              // '__unknown__' gets the cobalt person dot (it's still an
              // unrecognized PERSON sighting); named individuals get
              // their stable per-name wheel hue from identityForName —
              // same color a named event's WhoMark renders with.
              dotColor={(v) =>
                v === 'all'
                  ? null
                  : v === '__unknown__'
                    ? 'var(--color-id-person)'
                    : identityForName(v).colorVar
              }
              marginTopClass="mt-2"
            />
          </>
        )}
        </div>
        {/* iter-251: calendar heatmap is collapsed by default. The
            "Showing events for <day>" bar replaces the heatmap when
            a day filter is active.
            iter-298: moved INTO the sticky header so the calendar
            anchors to the top as the events list scrolls. Toggle
            stays in the title row above. */}
        {selectedDay ? (
          <div className="px-4 py-2 bg-[var(--color-accent-subtle)] border-t border-[var(--color-border)] space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-[var(--color-accent-default)]">
                Showing events for {selectedDay}
                {(dayStartTime || dayEndTime) && (
                  <>
                    {' '}
                    <span className="text-[var(--color-accent-default)]">
                      {dayStartTime || '00:00'}–{dayEndTime || '24:00'}
                    </span>
                  </>
                )}
              </span>
              {/* iter-356.8 (mobile-desktop M1): flex-wrap so the
                  three Download / Delete day / Clear buttons
                  reflow onto multiple lines instead of overflowing
                  off-screen on a 320px iPhone SE viewport. */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                {/* iter-307: bulk-delete affordance for the active day.
                    Owner-only. Confirm dialog before destructive call.
                    iter-322: when a time window is also active, the
                    delete still affects the whole day (the server
                    DELETE route only takes ?day=, not a time range).
                    Aria-label clarifies. */}
                {/* iter-333: bulk-download the visible filtered list
                    for the active day. Capped at 50 server-side
                    (matches /api/events/export). Disabled while
                    in-flight to prevent double-trigger. Sits BEFORE
                    Delete to anchor the most-common (non-destructive)
                    bulk action on the left. */}
                {/* iter-356.3b (Maya iter-355ae Major): three
                    underlined text-link buttons → real pill buttons
                    with icons via Button primitive. Pre-iter-356.3b
                    Maya: "underlined links inside a banner read as
                    2008 web app, not premium app. Plus all three sit
                    at the same visual weight despite very different
                    consequences." Now: secondary outline for
                    Download (non-destructive), destructive ghost for
                    Delete day, ghost for Clear (escape). */}
                {filtered.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onDownloadVisible}
                    loading={bulkDownloading}
                    loadingText="Preparing…"
                    aria-label={`Download ${Math.min(filtered.length, 50)} events from ${selectedDay} as ZIP`}
                  >
                    Download ({Math.min(filtered.length, 50)})
                  </Button>
                )}
                {isOwner && events.length > 0 && (
                  // iter-356.C (mobile-redesign Slice C — security
                  // clarity): when a person or label filter is
                  // active, the "Delete day" wording is dishonest —
                  // the user sees a filtered subset but the API
                  // deletes the whole day. Smaller blast radius:
                  // disable + tooltip telling them to clear the
                  // filter first. (deleteEventsByDay has no filter
                  // param on the wire, so we'd have to either grow
                  // the API or grow client-side enumeration; both
                  // are out of slice C scope.)
                  (() => {
                    const filterActive =
                      filter !== 'all' || labelFilter !== null
                    const deleteDayHint = filterActive
                      ? 'Clear the filter to delete a whole day.'
                      : `Delete all events for ${selectedDay}`
                    return (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={onDeleteDay}
                        disabled={filterActive}
                        aria-label={deleteDayHint}
                        title={deleteDayHint}
                      >
                        Delete day
                      </Button>
                    )
                  })()
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearDayFilter}
                  aria-label="Clear day filter"
                >
                  Clear
                </Button>
              </div>
            </div>
            {/* Sunroom fix (2026-07-01): the disabled Delete day reason
                lived only in the title tooltip — invisible on touch.
                Surface it as a one-line visible hint when a filter
                blocks day-delete. aria semantics stay on the button. */}
            {isOwner &&
              events.length > 0 &&
              (filter !== 'all' || labelFilter !== null) && (
                <p className="text-xs text-[var(--color-text-secondary)]">
                  Clear the filter to delete a whole day
                </p>
              )}
            {/* iter-322 (user "make it so I can check the captures
                for a specific time of the day"): time-of-day pickers.
                Native <input type="time"> for the browser calendar
                + 24h picker on mobile. Empty input = use full day's
                midnight bound on that side. Reset link clears both
                back to full-day. */}
            {/* iter-356.56 (mobile audit D2): time inputs jump from
                `text-base` (15 px per token scale) to a hard 16 px so
                iOS Safari doesn't auto-zoom the viewport on tap. The
                `text-[16px]` arbitrary value is the canonical fix —
                15 px sits below the 16 px iOS auto-zoom threshold;
                bumping by 1 px clears it without changing the visual
                rhythm noticeably.
                iter-356.56 (mobile audit B2): Reset is now a real
                touch target — min-h-[44px] + horizontal padding +
                inline-flex so the click area meets WCAG 2.5.5. */}
            {/* redesign/warm-boutique: "From"/"to" are plain field
                labels, not signal — secondary ink, not marmalade
                (accent stays reserved for the active-filter status
                line above). */}
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="text-[var(--color-text-secondary)]">From</span>
              <input
                type="time"
                value={dayStartTime ?? ''}
                onChange={(e) =>
                  onTimeBoundsChange(e.target.value || null, dayEndTime)
                }
                aria-label="Filter from time of day"
                className="bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-1 text-[16px] text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
              />
              <span className="text-[var(--color-text-secondary)]">to</span>
              <input
                type="time"
                value={dayEndTime ?? ''}
                onChange={(e) =>
                  onTimeBoundsChange(dayStartTime, e.target.value || null)
                }
                aria-label="Filter to time of day"
                className="bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded px-2 py-1 text-[16px] text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
              />
              {(dayStartTime || dayEndTime) && (
                <button
                  type="button"
                  onClick={() => onTimeBoundsChange(null, null)}
                  className="inline-flex items-center min-h-[44px] px-2 text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] underline ml-1 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
                  aria-label="Reset time-of-day filter"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        ) : null}
      </header>
      {/* iter-356.66 (real-device user feedback round 3): top-right
          floating position overlapped the in-header "Last 100" text
          ("L..." peeking from behind the calendar circle). Moved to
          a bottom-right FAB pattern instead:
            - sits above the BottomNav (5rem + safe-area-bottom)
            - right: 12 px from edge
            - 56-px round button with elevated shadow + accent fill
              when the calendar overlay is open
            - mobile-only (lg:hidden) — desktop heatmap lives in the
              right rail, no toggle needed
          Bottom-right is the conventional mobile FAB position
          (Gmail / Instagram / Inbox) and lands directly under the
          right thumb's natural arc on a 6.7" phone. No overlap with
          any header content; visible at all scroll positions. */}
      <button
        type="button"
        onClick={() => setCalendarOpen((v) => !v)}
        aria-label={calendarOpen ? 'Hide calendar' : 'Show calendar'}
        aria-pressed={calendarOpen}
        // Landscape pass: this offset reserves room for the OLD
        // bottom-docked pebble nav. `landscape-phone:` docks the nav
        // as a LEFT rail instead (BottomNav.tsx) — nothing sits at
        // the bottom edge there, so the FAB can sit close to it
        // instead of floating ~92px up with a big dead gap below.
        className={`lg:hidden fixed bottom-[calc(5rem+env(safe-area-inset-bottom)+12px)] landscape-phone:bottom-[calc(0.75rem+env(safe-area-inset-bottom))] right-3 z-30 inline-flex items-center justify-center w-14 h-14 rounded-full shadow-[var(--shadow-card)] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
          calendarOpen
            ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent-default)] ring-2 ring-[var(--color-accent-border)]'
            : 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] ring-1 ring-[var(--color-border-strong)]'
        }`}
      >
        <CalendarIcon />
      </button>
      {/* iter-356.16 (Maya 10th + Priya 3rd CRITICAL): pulled
          EventHeatmap out of the sticky <header>. Pre-iter-356.16
          the heatmap lived inside the pin (iter-298) which made the
          sticky band balloon to ~280px on mobile (42% of an iPhone
          SE) and ~400px on desktop with chips + day-filter banner
          stacked. Now the heatmap renders below the header in scroll
          flow. On lg+ it ALSO mirrors as a right-rail sticky-to-self
          (320px) so desktop users get a calendar that's always
          visible while they scroll the cards — Priya's design. The
          two heatmap surfaces share `onSelectDay` + filter state
          and selecting in either one rolls up to the same handler.

          Day-filter banner stays inside the sticky header (it's a
          status + bulk-action surface that should pin while
          scrolling that day's cards). Calendar-toggle button on the
          header stays visible only on mobile (lg:hidden) — desktop
          users see the heatmap permanently in the rail. */}
      <div className="lg:max-w-6xl lg:mx-auto lg:flex lg:items-start lg:gap-4 lg:px-4 landscape-phone:max-w-2xl landscape-phone:mx-auto landscape-phone:px-4">
        <div className="flex-1 min-w-0">
          {/* iter-356.62 (bug #3 — user "calendar should anchor itself
              to the top no matter where they are when they are scrolled
              down"): the inline mobile heatmap used to render in scroll
              flow above the events list, so opening it mid-scroll
              dropped the user to whatever offset their thumb happened
              to be at. Now it renders via a portal as a fixed-position
              overlay anchored to the top of the viewport with a
              backdrop, regardless of scroll position. The desktop
              right-rail aside below stays unchanged (lg+ users have
              dedicated screen real-estate for the heatmap). */}
          {calendarOpen &&
            typeof document !== 'undefined' &&
            createPortal(
              <CalendarOverlay onClose={() => setCalendarOpen(false)}>
                <Suspense fallback={<HeatmapSkeleton />}>
                  <EventHeatmap
                    onSelectDay={(s, u, day) => {
                      onSelectDay(s, u, day)
                      setCalendarOpen(false)
                    }}
                    personName={
                      filter !== 'all' && filter !== '__unknown__' ? filter : undefined
                    }
                    faceUnrecognized={filter === '__unknown__' ? true : undefined}
                  />
                </Suspense>
              </CalendarOverlay>,
              document.body,
            )}
          {loading ? (
            <EventListSkeleton />
          ) : error ? (
            <ErrorState
              title="Could not load events"
              message="Check your connection and try again."
              retry={retry}
              technicalDetail={formatError(error)}
            />
          ) : (
            <>
              {/* Playroom Modern (Task 6): "Today, hour by hour" card
                  — 24-cell identity timeline above the list. Skipped
                  while a day filter is active (selectedDay browses a
                  different day than "today", so the band would be
                  misleading) and while there are zero events overall
                  (nothing to show yet, and the sleeping-cat empty
                  state below already communicates that). */}
              {!selectedDay && events.length > 0 && (
                <div className="card-paper px-2.5 py-3 mx-4 lg:mx-0 landscape-phone:mx-0 mb-3">
                  <h2 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">
                    Today, hour by hour
                  </h2>
                  <HourBand events={todaysEvents} dayStartTs={todayStartTs} />
                </div>
              )}
              {/* iter-356.x desktop D1: selection-mode action bar.
                  Sticky just below the page header so the bar stays
                  visible while scrolling through 100+ rows. Renders
                  Cancel + Delete-N. Cancel exits the mode without
                  destruction; Delete fires the bulk-confirm dialog. */}
              {selectionMode && (
                <div
                  role="region"
                  aria-label="Bulk selection actions"
                  className="sticky top-[var(--day-header-top,4rem)] z-20 mb-2 mx-4 lg:mx-0 landscape-phone:mx-0 px-3 py-2 rounded-xl bg-[var(--color-accent-subtle)] border border-[var(--color-accent-border)] flex items-center justify-between gap-3 shadow-[var(--shadow-subtle)]"
                >
                  <span className="text-sm font-semibold text-[var(--color-accent-default)] tabular-nums">
                    {selectedIds.size === 0
                      ? 'Tap events to select'
                      : `${selectedIds.size} selected`}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={exitSelectionMode}
                      disabled={bulkDeleting}
                      className="text-xs font-medium px-3 min-h-[44px] inline-flex items-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
                    >
                      Cancel
                    </button>
                    <Button
                      variant="destructive"
                      size="md"
                      onClick={onBulkDelete}
                      disabled={selectedIds.size === 0 || bulkDeleting}
                    >
                      {bulkDeleting
                        ? 'Deleting…'
                        : selectedIds.size === 0
                          ? 'Delete'
                          : `Delete ${selectedIds.size}`}
                    </Button>
                  </div>
                </div>
              )}
              <EventList
                events={filtered}
                // iter-307: per-row delete affordance for owners only.
                // Family/viewer roles see the list without the ✕ buttons.
                // iter-312: handler refs (`onDeleteOne`, `onSelectEvent`)
                // are useCallback'd so EventCard's React.memo equality
                // check sees stable refs across parent re-renders.
                onDelete={isOwner ? onDeleteOne : undefined}
                onSelect={onSelectEvent}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
                // iter-356.24 (Frank carryover from iter-356.22): wire
                // worker_alive + detection_active into the empty-state
                // branch so the sleeping cat is reserved for "camera
                // is on and nothing happened" — not "camera is dead
                // and the user wouldn't know." `status` may be null
                // briefly during cold-load; treat null as "still
                // healthy" (don't flash an offline message during the
                // first poll round-trip).
                cameraOffline={
                  status !== null &&
                  (status.worker_alive === false ||
                    status.detection_active === false)
                }
              />
              {/* iter-220 (Feature #6 slice 6): Load more button. Hidden
                  when there's no cursor left (last page reached) OR no
                  events at all. Loading state during the round-trip. */}
              {hasMore && events.length > 0 && (
                <div className="px-4 py-6 flex justify-center">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="text-sm bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] disabled:bg-[var(--color-surface)] disabled:text-[var(--color-text-tertiary)] rounded-full px-5 py-2 border border-[var(--color-border)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                    aria-label="Load older events"
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {/* Desktop right-rail heatmap (always visible, sticky-to-self).
            Gated on isDesktopWidth so the heatmap doesn't double-mount
            in jsdom (matchMedia returns false there). On real lg+
            viewports the rail is permanent — no toggle. */}
        {isDesktopWidth && (
          <aside
            aria-label="Detection calendar"
            className="w-80 shrink-0 sticky self-start py-4"
            style={{ top: 'calc(var(--day-header-top, 64px) + 8px)' }}
          >
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3">
              <Suspense fallback={<HeatmapSkeleton />}>
                <EventHeatmap
                  onSelectDay={onSelectDay}
                  personName={
                    filter !== 'all' && filter !== '__unknown__' ? filter : undefined
                  }
                  faceUnrecognized={filter === '__unknown__' ? true : undefined}
                />
              </Suspense>
            </div>
          </aside>
        )}
      </div>
      {selectedEvent && (
        <ClipModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          // Final whole-branch review fix batch #1: ClipModal's own
          // Delete pill (owner-only) succeeds server-side but this
          // page's `events` list is separate state — without pruning
          // it here the just-deleted row kept rendering until the
          // next unrelated refetch. Mirrors onDeleteOne's own
          // `setEvents((cur) => cur.filter(...))` pruning step above.
          onDeleted={(id) =>
            setEvents((cur) => cur.filter((ev) => ev.id !== id))
          }
        />
      )}
    </div>
  )
}

// iter-339 (a11y blocker #3): the chip is now `role="radio"` inside
// the parent `role="radiogroup"` (Events.tsx). Pre-iter-339 it was
// `role="tab"` inside `role="tablist"`, but ARIA `tablist` requires
// matching `tabpanel` regions which we never had — Dana flagged
// this as wrong semantics during the iter-333 broad audit. The
// roving-tabindex on `tabIndex` keeps only the selected chip in the
// Tab order; the parent radiogroup div handles arrow-key nav.
// iter-339 (a11y blocker #3): WAI-ARIA radiogroup wrapper for a
// horizontal chip strip. Replaces the iter-? `role="tablist"` with
// the correct semantics + arrow-key navigation. Generic over the
// value type so the same component handles both the person-name
// strip (PersonFilter type) and the iter-329 label-name strip
// (string | null). Uses roving-tabindex internally — only the
// selected chip is in the Tab order; arrow keys move within.
function ChipRadiogroup<T>({
  ariaLabel,
  values,
  current,
  onSelect,
  renderLabel,
  dotColor,
  marginTopClass = 'mt-2',
}: {
  ariaLabel: string
  values: T[]
  current: T
  onSelect: (v: T) => void
  renderLabel: (v: T) => string
  /** Playroom Modern (Task 6): optional 12px identity-color square
   * rendered before the chip label. Returns null for chips with no
   * identity color (catch-all "Everyone"/"All types"). */
  dotColor?: (v: T) => string | null
  marginTopClass?: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const idx = values.findIndex((v) => v === current)
  return (
    <div
      className={`lg:max-w-6xl lg:mx-auto flex gap-2 ${marginTopClass} -mx-1 px-1 min-h-[44px] items-center overflow-x-auto overscroll-x-contain scrollbar-hide`}
      role="radiogroup"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (idx === -1) return
        const next = nextRovingIndex(e.key, idx, values.length)
        if (next === null) return
        e.preventDefault()
        onSelect(values[next])
        // requestAnimationFrame: tabIndex flips to 0 in next paint
        // before .focus() so the browser doesn't refuse to focus a
        // tabIndex=-1 element. Same pattern as iter-335 ClipModal.
        requestAnimationFrame(() => {
          refs.current[next]?.focus()
        })
      }}
    >
      {values.map((v, i) => (
        <FilterChip
          key={String(v)}
          active={current === v}
          onClick={() => onSelect(v)}
          label={renderLabel(v)}
          dotColor={dotColor ? dotColor(v) : null}
          forwardedRef={(el) => {
            refs.current[i] = el
          }}
        />
      ))}
    </div>
  )
}

// iter-345: _nextChipIndex hoisted to `client/src/lib/a11y.ts` as
// `nextRovingIndex` (shared with iter-335 ClipModal speed-pill row).

function FilterChip({
  active,
  onClick,
  label,
  dotColor = null,
  forwardedRef,
}: {
  active: boolean
  onClick: () => void
  label: string
  /** Playroom Modern (Task 6): 12px identity-color square rendered
   * before the label (person=cobalt, cat=marmalade, named individuals
   * get their per-name wheel hue). null = no dot. */
  dotColor?: string | null
  /** iter-339: parent registers each chip in a refs array for
   * arrow-key focus shifting. Optional so non-radiogroup callers
   * (none today) still work. */
  forwardedRef?: (el: HTMLButtonElement | null) => void
}) {
  const base =
    'inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors capitalize border focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 flex-shrink-0'
  // Playroom Modern (Task 6): selected who-chip is an ink-fill pill —
  // same "selected = ink fill" grammar as Button's primary variant
  // (bg-ink / text-on-ink). Pre-Task-6 the selected state was a
  // two-tone accent/success tint; the mockup calls for one consistent
  // ink fill regardless of which chip (identity now lives in the dot).
  const cls = active
    ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)] border-[var(--color-ink)]'
    : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
  return (
    <button
      ref={forwardedRef}
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={`${base} ${cls}`}
    >
      {dotColor ? (
        <span
          aria-hidden="true"
          className="w-3 h-3 rounded-full shrink-0"
          style={{ background: dotColor }}
        />
      ) : null}
      {label}
    </button>
  )
}

// iter-356.62 (bug #3): viewport-anchored modal overlay for the
// mobile calendar heatmap. Mirrors the pattern in lib/confirm.tsx +
// ClipModal: fixed inset-0 backdrop, ESC + backdrop-click both
// dismiss, aria-modal="true" so AT users perceive a modal context.
// Anchored at the top of the viewport (items-start) so the calendar
// is always visible at the same place regardless of where the user
// was scrolled when they tapped the toggle.
function CalendarOverlay({
  onClose,
  children,
}: {
  onClose: () => void
  children: React.ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // iter-356.63 (Slice D a11y): focus capture/restore. The trigger
  // (the Show calendar button in the header rail) is whatever was
  // focused at mount; on close we restore focus there so the
  // keyboard user picks back up where they left off instead of
  // being dumped at the document root.
  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onClose])
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- role="dialog" is a focus-management context per ARIA APG; the keydown handler is the focus trap, not a click handler.
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Detection calendar"
      tabIndex={-1}
      // iter-356.63 (Slice D a11y): focus trap — Tab cycles inside
      // the dialog, doesn't escape to the muted page behind. Same
      // shape as ClipModal::iter-336.
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return
        if (!dialogRef.current) return
        const sel =
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(sel),
        ).filter((el) => el.getAttribute('tabindex') !== '-1')
        if (focusables.length === 0) return
        const active = document.activeElement as HTMLElement | null
        const idx = active ? focusables.indexOf(active) : -1
        if (e.shiftKey) {
          if (idx <= 0) {
            e.preventDefault()
            focusables[focusables.length - 1].focus()
          }
        } else {
          if (idx === focusables.length - 1) {
            e.preventDefault()
            focusables[0].focus()
          }
        }
      }}
      className="fixed inset-0 z-40 flex items-start justify-center pt-[env(safe-area-inset-top)] bg-black/60 backdrop-blur-sm lg:hidden"
    >
      <button
        type="button"
        aria-label="Close calendar"
        data-testid="calendar-backdrop"
        onClick={onClose}
        className="absolute inset-0 w-full h-full cursor-default"
      />
      <div className="relative w-full max-w-md mx-4 mt-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3 shadow-[var(--shadow-card)]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Calendar
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close calendar"
            className="inline-flex items-center justify-center w-11 h-11 rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-raised)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}
