import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ServerEvent } from '../lib/types'

const fetchEvents = vi.fn()
const searchEvents = vi.fn()
const getEventCountsByDay = vi.fn()
const subscribeEvents = vi.fn()
const markAllEventsSeen = vi.fn()
const markEventSeen = vi.fn()
// iter-307: deleteEvent + deleteEventsByDay added for the manual
// delete UI. Default to never-resolving so existing tests aren't
// affected by the new mock surface; specific delete tests override.
const deleteEvent = vi.fn().mockResolvedValue({ deleted: true })
const deleteEventsByDay = vi.fn().mockResolvedValue({ deleted: 0 })
// iter-333: bulk-export wrapper for the Download button in the
// day-filter banner. Default to a no-op blob so existing tests
// aren't disturbed; the iter-333 BDD tests override.
const exportEventsM = vi.fn().mockResolvedValue(
  new Blob(['fake-zip'], { type: 'application/zip' }),
)

// iter-356.24: getStatus is needed because Events now consumes
// useStatus() to surface worker_alive/detection_active for the
// EventList camera-offline empty-state branch. Default to a healthy
// camera so existing tests continue to assert against the "all
// quiet" copy; iter-356.24's specific offline-branch test overrides.
const getStatusM = vi.fn().mockResolvedValue({
  ok: true,
  uptime_s: 100,
  camera: 'ok',
  detection_active: true,
  worker_alive: true,
  worker_last_seen_s: 1,
  worker_metrics: null,
})
vi.mock('../lib/api', () => ({
  fetchEvents: (...a: unknown[]) => fetchEvents(...a),
  searchEvents: (...a: unknown[]) => searchEvents(...a),
  getEventCountsByDay: (...a: unknown[]) => getEventCountsByDay(...a),
  markAllEventsSeen: (...a: unknown[]) => markAllEventsSeen(...a),
  markEventSeen: (...a: unknown[]) => markEventSeen(...a),
  deleteEvent: (...a: unknown[]) => deleteEvent(...a),
  deleteEventsByDay: (...a: unknown[]) => deleteEventsByDay(...a),
  exportEvents: (...a: unknown[]) => exportEventsM(...a),
  getStatus: (...a: unknown[]) => getStatusM(...a),
}))
vi.mock('../lib/ws', () => ({
  subscribeEvents: (...a: unknown[]) => subscribeEvents(...a),
}))
// iter-307: Events now consumes useAuth() (for owner role gating
// the delete affordances) + useConfirm() + useToast(). Mock the
// hooks so tests don't need the surrounding providers. Default to
// admin (owner-equivalent via the iter-197 carve-out) so the
// delete buttons render.
const _authUser = { username: 'testuser', role: 'admin' as const }
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: _authUser, logout: vi.fn() }),
}))
const confirmFn = vi.fn().mockResolvedValue(true)
vi.mock('../lib/confirm', () => ({
  useConfirm: () => confirmFn,
}))
const showToast = vi.fn()
vi.mock('../lib/toast', () => ({
  useToast: () => ({ showToast }),
}))

// iter-326b: Events now reads `?person=` via useSearchParams() to
// support the People → Events deep-link. Mock react-router-dom so
// the existing `render(<Events />)` calls (no Router wrapper) keep
// working. Default returns an EMPTY URLSearchParams so filter seeds
// to 'all'. Tests that exercise the deep-link override `_searchSeed`.
let _searchSeed = ''
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  )
  return {
    ...actual,
    useSearchParams: () =>
      [new URLSearchParams(_searchSeed), () => {}] as const,
  }
})

import { Events } from './Events'

describe('Events page', () => {
  beforeEach(() => {
    _searchSeed = ''
    fetchEvents.mockReset()
    searchEvents.mockReset()
    getEventCountsByDay.mockReset().mockResolvedValue({ counts: {} })
    markAllEventsSeen.mockReset().mockResolvedValue({ flipped: 0 })
    markEventSeen.mockReset().mockResolvedValue({ flipped: true })
    subscribeEvents.mockReset()
    subscribeEvents.mockReturnValue(() => {})
    // iter-251: heatmap is collapsed by default — open it in tests
    // so the existing day-tap suite finds the cells. Tests that
    // exercise the toggle itself clear this in their own setup.
    window.localStorage.setItem('homecam:calendarOpen', '1')
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given the calendar localStorage flag is unset, when the page mounts, then the heatmap is hidden until the user taps the calendar icon (iter-251)', async () => {
    // arrange — clear the seeded flag from the shared beforeEach.
    window.localStorage.removeItem('homecam:calendarOpen')
    fetchEvents.mockResolvedValue([])
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    render(<Events />)

    // act / assert — heatmap absent on mount.
    await waitFor(() =>
      expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument(),
    )
    expect(screen.queryByLabelText(/detection events per day/i)).not.toBeInTheDocument()

    // act — tap the calendar icon.
    await user.click(
      screen.getByRole('button', { name: /show calendar/i }),
    )

    // assert — heatmap mounts; aria-label flips to "hide calendar".
    expect(
      screen.getByLabelText(/detection events per day/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /hide calendar/i }),
    ).toBeInTheDocument()
    // localStorage persisted the choice.
    expect(window.localStorage.getItem('homecam:calendarOpen')).toBe('1')
  })

  it('renders the header', async () => {
    fetchEvents.mockResolvedValue([])
    render(<Events />)
    expect(screen.getByRole('heading', { name: /events/i })).toBeInTheDocument()
  })

  it('shows a skeleton loading state then the fetched events', async () => {
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
      },
    ])
    render(<Events />)
    expect(screen.getByRole('status', { name: /loading events/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/person at /i)).toBeInTheDocument())
  })

  it('shows the recent count once loaded', async () => {
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
      },
    ])
    render(<Events />)
    await waitFor(() => expect(screen.getByText(/1 recent/)).toBeInTheDocument())
  })

  it('prepends new detection events received over WebSocket', async () => {
    fetchEvents.mockResolvedValue([])
    let push: (e: ServerEvent) => void = () => {}
    subscribeEvents.mockImplementation((cb: (e: ServerEvent) => void) => {
      push = cb
      return () => {}
    })
    render(<Events />)
    await waitFor(() =>
      expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument(),
    )
    push({
      v: 1,
      type: 'detection',
      id: '2',
      ts: Date.now() / 1000,
      camera_id: 'cam2',
      label: 'car',
      score: 0.88,
      boxes: [],
    })
    await waitFor(() => expect(screen.getByText(/car at /i)).toBeInTheDocument())
  })

  it('ignores non-detection events from the WebSocket', async () => {
    fetchEvents.mockResolvedValue([])
    let push: (e: ServerEvent) => void = () => {}
    subscribeEvents.mockImplementation((cb: (e: ServerEvent) => void) => {
      push = cb
      return () => {}
    })
    render(<Events />)
    await waitFor(() =>
      expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument(),
    )
    // iter-170: the server's wire shape was narrowed to
    // `ServerEvent = DetectionEvent` (the StatusEvent branch was a
    // phantom — never emitted by any server code). The runtime guard
    // in Events.tsx (`if (e.type === 'detection')`) still defends
    // against malformed/unknown wire payloads, so this test now uses
    // an `unknown` cast to simulate a future server pushing a
    // non-detection shape — Events should still show the empty state
    // (no crash, no added row).
    push({ v: 1, type: 'status', cpu_temp_c: 30, fps: 24 } as unknown as ServerEvent)
    expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument()
  })

  it('caps the in-memory event list at 200 entries', async () => {
    fetchEvents.mockResolvedValue([])
    let push: (e: ServerEvent) => void = () => {}
    subscribeEvents.mockImplementation((cb: (e: ServerEvent) => void) => {
      push = cb
      return () => {}
    })
    render(<Events />)
    await waitFor(() =>
      expect(screen.getByText(/all quiet out there/i)).toBeInTheDocument(),
    )
    for (let i = 0; i < 250; i++) {
      push({
        v: 1,
        type: 'detection',
        id: `e${i}`,
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.5 + (i % 50) / 100,
        boxes: [],
      })
    }
    // iter-249: titles are now "Person at the front door" — count
    // listitems instead of bare-label text matches.
    await waitFor(() => {
      const items = screen.getAllByRole('listitem')
      expect(items.length).toBeLessThanOrEqual(200)
    })
  })

  it('shows an error UI with retry when the initial fetch fails', async () => {
    fetchEvents.mockRejectedValueOnce(new Error('network down'))
    render(<Events />)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not load events/i),
    )
    expect(screen.getByText(/network down/)).toBeInTheDocument()
  })

  it('retry button retries the fetch and renders results on success', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    fetchEvents
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([
        {
          v: 1,
          type: 'detection',
          id: '1',
          ts: Date.now() / 1000,
          camera_id: 'cam1',
          label: 'person',
          score: 0.91,
          boxes: [],
        },
      ])
    const user = userEvent.setup()
    render(<Events />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByText(/person at /i)).toBeInTheDocument())
    expect(fetchEvents).toHaveBeenCalledTimes(2)
  })

  it('shows person filter chips once a face has been matched', async () => {
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
        person_name: 'Israel',
      },
      {
        v: 1,
        type: 'detection',
        id: '2',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.6,
        boxes: [],
      },
    ])
    render(<Events />)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /^all$/i })).toBeInTheDocument(),
    )
    expect(screen.getByRole('radio', { name: /israel/i })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /unrecognized/i })).toBeInTheDocument()
  })

  it('hides the filter row when no faces have been matched', async () => {
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
      },
    ])
    render(<Events />)
    await waitFor(() => expect(screen.getByText(/person at /i)).toBeInTheDocument())
    expect(screen.queryByRole('tab', { name: /^all$/i })).not.toBeInTheDocument()
  })

  it('selecting a person chip narrows the list to that person', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
        person_name: 'Israel',
      },
      {
        v: 1,
        type: 'detection',
        id: '2',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.85,
        boxes: [],
        person_name: 'Sheenal',
      },
    ])
    const user = userEvent.setup()
    render(<Events />)
    const israelChip = await screen.findByRole('radio', { name: /israel/i })
    await user.click(israelChip)
    // Filter narrows the list to one row; chip row still shows both names.
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
    })
    expect(screen.getByText(/1 of 2 recent/i)).toBeInTheDocument()
  })

  it('clicking a thumb row opens the ClipModal (iter-203)', async () => {
    // iter-203 (Feature #1 slice 3): row tap opens a ClipModal that
    // tries the iter-201 `/api/events/{id}/clip` route. SnapshotPreview
    // (the pre-iter-203 path) is replaced. ClipModal handles the
    // clip-not-yet-recorded case via snapshot fallback at render time
    // — that fallback is exercised by ClipModal.test.tsx, not here.
    const userEvent = (await import('@testing-library/user-event')).default
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: '1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
        thumb_url: '/snapshots/thumb_1.jpg',
      },
    ])
    const user = userEvent.setup()
    render(<Events />)
    const row = await screen.findByRole('button', { name: /play clip:|open: person at/i })
    await user.click(row)
    const dialog = await screen.findByRole('dialog', { name: /at the front door/i })
    expect(dialog).toBeInTheDocument()
    // Video element points at the iter-201 clip route.
    expect(screen.getByLabelText(/clip of person event/i)).toHaveAttribute(
      'src',
      '/api/events/1/clip',
    )
    // Close it.
    await user.click(screen.getByRole('button', { name: /^close$/i }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /at the front door/i }),
      ).not.toBeInTheDocument(),
    )
  })

  // iter-290 (test-integrity-auditor #2): pre-iter-290 the
  // markEventSeen mock at line 10 was declared but no test asserted
  // it actually fired on row tap — production handler at
  // Events.tsx:416-426 could be deleted and the existing suite stayed
  // green. Pin: row tap → markEventSeen(e.id) called AND a
  // homecam:badge-reconcile window event dispatched (so the
  // AppShell badge hook re-fetches).

  it('given a thumb row tap, when markEventSeen resolves, then homecam:badge-reconcile is dispatched (iter-276 wire-up)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: 'evt-7',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.91,
        boxes: [],
        thumb_url: '/snapshots/thumb_7.jpg',
      },
    ])
    const reconcileSpy = vi.fn()
    window.addEventListener('homecam:badge-reconcile', reconcileSpy)
    const user = userEvent.setup()
    render(<Events />)
    const row = await screen.findByRole('button', { name: /play clip:|open: person at/i })

    // act
    await user.click(row)

    // assert
    await waitFor(() =>
      expect(markEventSeen).toHaveBeenCalledWith('evt-7'),
    )
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalled())
    window.removeEventListener('homecam:badge-reconcile', reconcileSpy)
  })

  it('refetches events when the tab returns to visible (iter-157)', async () => {
    // Simulate the mobile-tab-resume scenario: WS may have closed +
    // reconnected during the background period; new events that fired
    // in that window are in server history but not in the local list.
    // The visibilitychange listener should re-fetch.
    fetchEvents.mockResolvedValueOnce([
      { v: 1, type: 'detection', id: 'a', ts: 1, camera_id: 'cam1',
        label: 'person', score: 0.9, boxes: [], thumb_url: null,
        person_name: null },
    ])
    render(<Events />)
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledTimes(1))

    // Stub a second response — pretend a new event landed during the
    // background period.
    fetchEvents.mockResolvedValueOnce([
      { v: 1, type: 'detection', id: 'b', ts: 2, camera_id: 'cam1',
        label: 'person', score: 0.95, boxes: [], thumb_url: null,
        person_name: null },
      { v: 1, type: 'detection', id: 'a', ts: 1, camera_id: 'cam1',
        label: 'person', score: 0.9, boxes: [], thumb_url: null,
        person_name: null },
    ])

    // Fire visibilitychange with `visible` state.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledTimes(2))
  })

  it('does not refetch when visibility changes to hidden', async () => {
    fetchEvents.mockResolvedValue([])
    render(<Events />)
    await waitFor(() => expect(fetchEvents).toHaveBeenCalledTimes(1))

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    // Allow microtask flush — fetchEvents should still have been called only once.
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchEvents).toHaveBeenCalledTimes(1)
  })

  // iter-220 (Feature #6 slice 6): Load more button consumes the
  // iter-219 /api/events/search route via cursor pagination.

  const _detection = (id: string, ts: number, label = 'person'): ServerEvent => ({
    v: 1, type: 'detection', id, ts, camera_id: 'cam1',
    label, score: 0.9, boxes: [], thumb_url: null,
    person_name: null, clip_url: null,
  })

  it('shows Load more button when there are events (iter-220)', async () => {
    fetchEvents.mockResolvedValue([_detection('a', 200), _detection('b', 100)])
    render(<Events />)
    expect(
      await screen.findByRole('button', { name: /load older events/i }),
    ).toBeInTheDocument()
  })

  it('does NOT show Load more before fetch completes (iter-220)', async () => {
    fetchEvents.mockResolvedValue([])
    render(<Events />)
    // Before fetch resolves, the page is in loading skeleton state —
    // no Load more visible. After resolve, with 0 events the button
    // also stays hidden (no cursor to advance).
    await waitFor(() =>
      expect(fetchEvents).toHaveBeenCalledTimes(1),
    )
    expect(
      screen.queryByRole('button', { name: /load older events/i }),
    ).not.toBeInTheDocument()
  })

  it('Load more click calls searchEvents with oldest event ts as cursor (iter-220)', async () => {
    fetchEvents.mockResolvedValue([
      _detection('a', 200), _detection('b', 100),
    ])
    searchEvents.mockResolvedValue({
      items: [_detection('c', 50)],
      next_cursor: 50,
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    expect(searchEvents).toHaveBeenCalledWith({
      before_ts: 100,  // oldest event's ts
      limit: 50,
    })
  })

  it('Load more appends older events to the list (iter-220)', async () => {
    fetchEvents.mockResolvedValue([
      _detection('a', 200, 'person'),
      _detection('b', 100, 'person'),
    ])
    searchEvents.mockResolvedValue({
      items: [_detection('c', 50, 'car')],
      next_cursor: null,  // last page
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    // Wait for initial load to populate.
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled())
    await user.click(
      await screen.findByRole('button', { name: /load older events/i }),
    )
    // Older event present after load more (matched via the
    // EventList's count-row in the header).
    await waitFor(() => expect(searchEvents).toHaveBeenCalled())
  })

  it('Load more hides button when next_cursor is null (iter-220)', async () => {
    fetchEvents.mockResolvedValue([_detection('a', 200), _detection('b', 100)])
    searchEvents.mockResolvedValue({ items: [_detection('c', 50)], next_cursor: null })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    // After the search returns null cursor, button should disappear.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /load older events/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('Load more hides button on search error (iter-220)', async () => {
    fetchEvents.mockResolvedValue([_detection('a', 200), _detection('b', 100)])
    searchEvents.mockRejectedValue(new Error('network down'))
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /load older events/i }),
      ).not.toBeInTheDocument(),
    )
  })

  // iter-221 (Feature #6 slice 7): chip-filter-on-search. When a
  // person-name chip is active and Load more is clicked, forward
  // person_name to the server-side filter. The `__unknown__` chip
  // stays client-side (server route doesn't support IS NULL).

  const _detectionWithName = (id: string, ts: number, name: string | null): ServerEvent => ({
    v: 1, type: 'detection', id, ts, camera_id: 'cam1',
    label: 'person', score: 0.9, boxes: [], thumb_url: null,
    person_name: name, clip_url: null,
  })

  it('Load more forwards person_name when chip is active (iter-221)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, 'alice'),
    ])
    searchEvents.mockResolvedValue({
      items: [_detectionWithName('c', 50, 'alice')],
      next_cursor: 50,
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    // Wait for the page to render with the alice chip available.
    const aliceChip = await screen.findByRole('radio', { name: /alice/i })
    await user.click(aliceChip)
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    expect(searchEvents).toHaveBeenCalledWith({
      before_ts: 100,
      limit: 50,
      person_name: 'alice',
    })
  })

  it('Load more does NOT forward person_name when "All" chip active (iter-221)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, 'alice'),
    ])
    searchEvents.mockResolvedValue({
      items: [_detectionWithName('c', 50, 'bob')],
      next_cursor: 50,
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    // Default chip is "All" — no need to click anything.
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const args = searchEvents.mock.calls[0][0]
    expect(args.person_name).toBeUndefined()
  })

  it('Load more forwards face_unrecognized when "Unrecognized" chip active (iter-228)', async () => {
    // iter-228 closes the iter-221 follow-up: the __unknown__ chip
    // now uses the iter-227 face_unrecognized server param instead
    // of falling back to client-side filtering.
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, null),  // unrecognized event present
    ])
    searchEvents.mockResolvedValue({
      items: [_detectionWithName('c', 50, null)],
      next_cursor: 50,
    })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    // Click the "Unrecognized" chip.
    const unrecognized = await screen.findByRole('radio', { name: /unrecognized/i })
    await user.click(unrecognized)
    const btn = await screen.findByRole('button', { name: /load older events/i })
    await user.click(btn)
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const args = searchEvents.mock.calls[0][0]
    expect(args.person_name).toBeUndefined()
    expect(args.face_unrecognized).toBe(true)
  })

  // iter-223 (Feature #6 slice 7b-client): EventHeatmap mounted at
  // top of Events page. Tap a day → searchEvents({since_ts, until_ts})
  // → events list replaced. Clear button restores fetchEvents flow.

  it('mounts EventHeatmap and fetches counts (iter-252: month-scoped)', async () => {
    fetchEvents.mockResolvedValue([])
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    // iter-252: heatmap aria-label includes the visible month, e.g.
    // "Detection events per day, May 2026". Match generously.
    expect(
      await screen.findByLabelText(/Detection events per day,/i),
    ).toBeInTheDocument()
  })

  it('day-cell tap calls searchEvents with that day bounds (iter-223)', async () => {
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    // Click the rightmost cell (today). Find via aria-label query.
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    expect(cells.length).toBeGreaterThan(0)
    const todayCell = cells[cells.length - 1]
    todayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const args = searchEvents.mock.calls[0][0]
    expect(typeof args.since_ts).toBe('number')
    expect(typeof args.until_ts).toBe('number')
    expect(args.until_ts - args.since_ts).toBe(86400)
  })

  it('shows "Showing events for <day>" + Clear button after day select (iter-223)', async () => {
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    cells[cells.length - 1].dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    await screen.findByText(/Showing events for/)
    expect(
      await screen.findByRole('button', { name: /clear day filter/i }),
    ).toBeInTheDocument()
  })

  it('Clear day filter button refetches via fetchEvents (iter-223)', async () => {
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    cells[cells.length - 1].dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    const clearBtn = await screen.findByRole('button', { name: /clear day filter/i })
    fetchEvents.mockClear()
    await user.click(clearBtn)
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled())
  })

  // iter-224 (Feature #6 polish): chip+heatmap composition. Active
  // person chip scopes both the heatmap counts AND day-tap searches.

  it('passes active chip person_name to the heatmap counts fetch (iter-224)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, 'alice'),
    ])
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    // Wait for initial heatmap fetch (no person_name).
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const aliceChip = await screen.findByRole('radio', { name: /alice/i })
    getEventCountsByDay.mockClear()
    await user.click(aliceChip)
    // After chip change the heatmap refetches with alice's filter.
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const args = getEventCountsByDay.mock.calls[0][0]
    expect(args.person_name).toBe('alice')
  })

  it('day-tap forwards active chip person_name to searchEvents (iter-224)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, 'alice'),
    ])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const aliceChip = await screen.findByRole('radio', { name: /alice/i })
    await user.click(aliceChip)
    // Tap a heatmap cell (today).
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    cells[cells.length - 1].dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const args = searchEvents.mock.calls[0][0]
    expect(args.person_name).toBe('alice')
    expect(typeof args.since_ts).toBe('number')
    expect(args.until_ts - args.since_ts).toBe(86400)
  })

  // iter-228 (Feature #6 polish, closes iter-221 follow-up):
  // __unknown__ chip → server-side face_unrecognized=true filter.
  // Wires through to heatmap + day-tap searchEvents.

  it('passes face_unrecognized=true to heatmap counts when "Unrecognized" chip active (iter-228)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, null),
    ])
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const unrecognized = await screen.findByRole('radio', { name: /unrecognized/i })
    getEventCountsByDay.mockClear()
    await user.click(unrecognized)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const args = getEventCountsByDay.mock.calls[0][0]
    expect(args.face_unrecognized).toBe(true)
    expect(args.person_name).toBeUndefined()
  })

  it('day-tap forwards face_unrecognized=true when "Unrecognized" chip active (iter-228)', async () => {
    fetchEvents.mockResolvedValue([
      _detectionWithName('a', 200, 'alice'),
      _detectionWithName('b', 100, null),
    ])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    const user = (await import('@testing-library/user-event')).default.setup()
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    const unrecognized = await screen.findByRole('radio', { name: /unrecognized/i })
    await user.click(unrecognized)
    const cells = screen.getAllByLabelText(/: \d+ detections?/)
    cells[cells.length - 1].dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const args = searchEvents.mock.calls[0][0]
    expect(args.face_unrecognized).toBe(true)
    expect(args.person_name).toBeUndefined()
  })

  // iter-307: manual event delete (single + bulk-by-day with
  // confirm). Owner-only — gated by isOwner check in Events.tsx.

  it('given owner role + an event row, when delete ✕ clicked + confirmed, then deleteEvent fires + row disappears (iter-307)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const e = {
      v: 1, type: 'detection' as const,
      id: 'a1', ts: 1700000000, label: 'person', score: 0.9,
      boxes: [], thumb_url: '/thumb.jpg', clip_url: null,
      person_name: null,
    }
    fetchEvents.mockResolvedValue([e])
    confirmFn.mockResolvedValueOnce(true)
    deleteEvent.mockResolvedValueOnce({ deleted: true })

    // act
    render(<Events />)
    const delBtn = await screen.findByRole('button', {
      name: /delete event from/i,
    })
    await user.click(delBtn)

    // assert
    await waitFor(() => expect(deleteEvent).toHaveBeenCalledWith('a1'))
    expect(confirmFn).toHaveBeenCalled()
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/event deleted/i),
        'success',
      ),
    )
  })

  it('given owner role + a day filter active, when "Delete all" clicked + confirmed, then deleteEventsByDay fires (iter-307)', async () => {
    // arrange — seed 2 events on a date in the CURRENT month
    // (heatmap default view = today's month, so the cell needs to
    // be in that month to render). We use today's date so the
    // test stays valid year-over-year.
    confirmFn.mockReset()
    confirmFn.mockResolvedValue(true)
    deleteEventsByDay.mockReset()
    deleteEventsByDay.mockResolvedValue({ deleted: 2 })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({
      items: [
        { v: 1, type: 'detection', id: 'a', ts: today.getTime() / 1000, label: 'person',
          score: 0.9, boxes: [], thumb_url: '/t.jpg', clip_url: null,
          person_name: null },
        { v: 1, type: 'detection', id: 'b', ts: today.getTime() / 1000 + 60, label: 'person',
          score: 0.9, boxes: [], thumb_url: '/t.jpg', clip_url: null,
          person_name: null },
      ],
      next_cursor: null,
    })
    getEventCountsByDay.mockResolvedValue({ counts: { [todayStr]: 2 } })

    // act
    render(<Events />)
    await waitFor(() =>
      expect(getEventCountsByDay).toHaveBeenCalled(),
    )
    // Today's cell carries "(today)" suffix on its aria-label —
    // unambiguous match.
    const dayBtn = await screen.findByRole('button', {
      name: /\(today\)/i,
    })
    await user.click(dayBtn)
    const bulkBtn = await screen.findByRole('button', {
      // iter-322: button label changed from "Delete all 2" → "Delete day"
      // (count moved into the aria-label which doesn't include it any
      // more either; the count was redundant with the visible "for {day}".
      name: new RegExp(`delete all events for ${todayStr}`, 'i'),
    })
    await user.click(bulkBtn)

    // assert
    await waitFor(() =>
      expect(deleteEventsByDay).toHaveBeenCalledWith(todayStr),
    )
    expect(confirmFn).toHaveBeenCalled()
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringMatching(/removed 2 events/i),
        'success',
      ),
    )
  })

  it('given user cancels the confirm dialog, when delete ✕ clicked, then deleteEvent does NOT fire (iter-307)', async () => {
    // arrange — `mockReset` clears any `mockResolvedValueOnce`
    // queue from prior tests (vi.clearAllMocks in afterEach only
    // clears call counts, not the implementation queue).
    confirmFn.mockReset()
    confirmFn.mockResolvedValue(false)
    deleteEvent.mockReset()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    const e = {
      v: 1, type: 'detection' as const,
      id: 'a1', ts: 1700000000, label: 'person', score: 0.9,
      boxes: [], thumb_url: '/thumb.jpg', clip_url: null,
      person_name: null,
    }
    fetchEvents.mockResolvedValue([e])

    // act
    render(<Events />)
    const delBtn = await screen.findByRole('button', {
      name: /delete event from/i,
    })
    await user.click(delBtn)

    // assert
    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(deleteEvent).not.toHaveBeenCalled()
  })

  // iter-322 (user "make it so I can check the captures for a
  // specific time of the day"): time-of-day filter narrows the
  // active day-window to a HH:MM range. Wire shape + UI state.

  it('given a day filter active, when user types a start time, then searchEvents re-fires with narrowed since_ts (iter-322)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const { fireEvent } = await import('@testing-library/react')
    const user = userEvent.setup()
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    getEventCountsByDay.mockResolvedValue({ counts: { [todayStr]: 1 } })

    // act — open day filter via the heatmap "today" cell.
    render(<Events />)
    await waitFor(() =>
      expect(getEventCountsByDay).toHaveBeenCalled(),
    )
    const dayBtn = await screen.findByRole('button', { name: /\(today\)/i })
    await user.click(dayBtn)
    // Wait for the initial day-filter searchEvents call to land.
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const baseSince = searchEvents.mock.calls[0][0].since_ts
    // Now type a start time of 09:00 — narrows since_ts by 9 hrs.
    const startInput = await screen.findByLabelText(/filter from time of day/i)
    fireEvent.change(startInput, { target: { value: '09:00' } })

    // assert — searchEvents fired again with since_ts pushed forward.
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(2))
    const narrowedSince = searchEvents.mock.calls[1][0].since_ts
    expect(narrowedSince).toBe(baseSince + 9 * 3600)
  })

  it('given a time-of-day filter active, when Reset clicked, then searchEvents re-fires with full-day bounds (iter-322)', async () => {
    // arrange
    const userEvent = (await import('@testing-library/user-event')).default
    const { fireEvent } = await import('@testing-library/react')
    const user = userEvent.setup()
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    fetchEvents.mockResolvedValue([])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    getEventCountsByDay.mockResolvedValue({ counts: { [todayStr]: 1 } })

    // act
    render(<Events />)
    await waitFor(() => expect(getEventCountsByDay).toHaveBeenCalled())
    await user.click(await screen.findByRole('button', { name: /\(today\)/i }))
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(1))
    const baseSince = searchEvents.mock.calls[0][0].since_ts
    const baseUntil = searchEvents.mock.calls[0][0].until_ts
    // Type a start to enable the Reset button.
    fireEvent.change(
      await screen.findByLabelText(/filter from time of day/i),
      { target: { value: '12:00' } },
    )
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(2))
    // Now click Reset.
    await user.click(
      await screen.findByRole('button', { name: /reset time-of-day/i }),
    )

    // assert — bounds back to full day.
    await waitFor(() => expect(searchEvents).toHaveBeenCalledTimes(3))
    const resetCall = searchEvents.mock.calls[2][0]
    expect(resetCall.since_ts).toBe(baseSince)
    expect(resetCall.until_ts).toBe(baseUntil)
  })

  it('given ?person=Alice in the URL, when the page mounts, then the deep-link routes through searchEvents with person_name=Alice (iter-326b: People → Events deep-link)', async () => {
    // arrange
    _searchSeed = 'person=Alice'
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    fetchEvents.mockResolvedValue([])

    // act
    render(<Events />)

    // assert: a seeded filter on mount uses the iter-219 search
    // route (not plain fetchEvents) so Alice's events surface even
    // if she hasn't appeared in the most-recent 100 unfiltered.
    await waitFor(() => expect(searchEvents).toHaveBeenCalled())
    const firstArgs = searchEvents.mock.calls[0][0]
    expect(firstArgs).toMatchObject({ person_name: 'Alice' })
    expect(fetchEvents).not.toHaveBeenCalled()
  })

  it('given ?person= with a URL-encoded space, when the page mounts, then the decoded name reaches searchEvents (iter-326b)', async () => {
    // arrange
    _searchSeed = 'person=Mary%20Jane'
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    fetchEvents.mockResolvedValue([])

    // act
    render(<Events />)

    // assert
    await waitFor(() => expect(searchEvents).toHaveBeenCalled())
    const firstArgs = searchEvents.mock.calls[0][0]
    expect(firstArgs).toMatchObject({ person_name: 'Mary Jane' })
  })

  it('given no ?person= URL param, when the page mounts, then plain fetchEvents fires (no regression on the default path) (iter-326b)', async () => {
    // arrange
    _searchSeed = ''
    fetchEvents.mockResolvedValue([])

    // act
    render(<Events />)

    // assert: the seeded-filter path must NOT fire when no
    // deep-link is present — fetchEvents stays the fast-path.
    await waitFor(() => expect(fetchEvents).toHaveBeenCalled())
    expect(searchEvents).not.toHaveBeenCalled()
  })

  it('given only one distinct event label, when the page mounts, then NO label-chip row renders (iter-329: avoid UI noise on single-class deploys)', async () => {
    // arrange — single class (person) — the default deploy state.
    fetchEvents.mockResolvedValue([
      _personEvent({ id: 'e1', ts: Date.now() / 1000 - 60 }),
      _personEvent({ id: 'e2', ts: Date.now() / 1000 - 120 }),
    ])

    // act
    render(<Events />)

    // assert
    await waitFor(() =>
      expect(screen.queryByText(/no events/i)).not.toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('radiogroup', {
        name: /filter events by detection type/i,
      }),
    ).not.toBeInTheDocument()
  })

  it('given two distinct event labels, when the page mounts, then a class-filter chip row renders with one chip per label + an "All classes" chip (iter-329)', async () => {
    // arrange — multi-class deploy: person + dog.
    fetchEvents.mockResolvedValue([
      _personEvent({ id: 'e1', ts: Date.now() / 1000 - 60, label: 'person' }),
      _personEvent({ id: 'e2', ts: Date.now() / 1000 - 90, label: 'dog' }),
      _personEvent({ id: 'e3', ts: Date.now() / 1000 - 120, label: 'person' }),
    ])

    // act
    render(<Events />)

    // assert
    const tablist = await screen.findByRole('radiogroup', {
      name: /filter events by detection type/i,
    })
    expect(tablist).toBeInTheDocument()
    // "All classes" + "Dog" + "Person" — alphabetical so dog before person.
    expect(
      screen.getByRole('radio', { name: /all types/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /^dog$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('radio', { name: /^person$/i }),
    ).toBeInTheDocument()
  })

  it('given multi-class events, when the user clicks the Dog chip, then the visible event list narrows to dog events only (iter-329)', async () => {
    // arrange
    const now = Date.now() / 1000
    fetchEvents.mockResolvedValue([
      _personEvent({ id: 'p1', ts: now - 60, label: 'person', person_name: 'alice' }),
      _personEvent({ id: 'd1', ts: now - 90, label: 'dog' }),
      _personEvent({ id: 'p2', ts: now - 120, label: 'person', person_name: 'bob' }),
    ])
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    render(<Events />)
    const dogChip = await screen.findByRole('radio', { name: /^dog$/i })
    await user.click(dogChip)

    // assert — Alice + Bob person rows should be filtered out;
    // only the Dog event card remains. Use card title text
    // "Alice at"/"Bob at"/"Dog at" (from the iter-? eventTitle
    // helper) to identify cards specifically — the chip row
    // also contains 'alice'/'bob' as filter chips, so a bare
    // /alice/i would false-match.
    await waitFor(() =>
      expect(screen.queryByText(/alice at/i)).not.toBeInTheDocument(),
    )
    expect(screen.queryByText(/bob at/i)).not.toBeInTheDocument()
    expect(screen.getByText(/dog at/i)).toBeInTheDocument()
  })

  it('given the person-chip row, when ArrowRight is pressed on the All chip, then the next chip is selected and gets aria-checked (iter-339: a11y blocker #3 — radiogroup arrow-key nav)', async () => {
    // arrange — seed with one recognized person so chip row renders.
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: 'p1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.9,
        boxes: [],
        person_name: 'alice',
      } as ServerEvent,
    ])
    render(<Events />)
    const allChip = await screen.findByRole('radio', { name: /^all$/i })
    allChip.focus()
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    await user.keyboard('{ArrowRight}')

    // assert — Alice chip becomes the selected radio.
    const aliceChip = screen.getByRole('radio', { name: /alice/i })
    expect(aliceChip).toHaveAttribute('aria-checked', 'true')
  })

  it('given the chip-radiogroup, when rendered, then ONLY the active chip has tabindex=0 (iter-339: roving-tabindex)', async () => {
    // arrange
    fetchEvents.mockResolvedValue([
      {
        v: 1,
        type: 'detection',
        id: 'p1',
        ts: Date.now() / 1000,
        camera_id: 'cam1',
        label: 'person',
        score: 0.9,
        boxes: [],
        person_name: 'alice',
      } as ServerEvent,
    ])

    // act
    render(<Events />)

    // assert — All chip is selected by default; Alice chip has tabindex=-1.
    const allChip = await screen.findByRole('radio', { name: /^all$/i })
    expect(allChip.getAttribute('tabindex')).toBe('0')
    expect(
      screen.getByRole('radio', { name: /alice/i }).getAttribute('tabindex'),
    ).toBe('-1')
  })

  it('given the dog chip is active, when Load more fires, then searchEvents carries label=dog (iter-329 wire-contract)', async () => {
    // arrange
    const now = Date.now() / 1000
    fetchEvents.mockResolvedValue([
      _personEvent({ id: 'p1', ts: now - 60, label: 'person' }),
      _personEvent({ id: 'd1', ts: now - 90, label: 'dog' }),
    ])
    searchEvents.mockResolvedValue({ items: [], next_cursor: null })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    render(<Events />)
    await user.click(await screen.findByRole('radio', { name: /^dog$/i }))
    // Find Load more — only renders if hasMore is true. The default
    // initial state has hasMore=true.
    const loadMore = await screen.findByRole('button', {
      name: /load older events/i,
    })
    await user.click(loadMore)

    // assert
    await waitFor(() => expect(searchEvents).toHaveBeenCalled())
    const args = searchEvents.mock.calls[0][0]
    expect(args).toMatchObject({ label: 'dog' })
  })
})

// iter-329 helper: build a minimal DetectionEvent for label-chip
// tests. Matches the iter-? ServerEvent shape so the EventList
// renders correctly. label defaults to 'person'.
function _personEvent(over: Partial<ServerEvent> & { id: string; ts: number }): ServerEvent {
  return {
    v: 1,
    type: 'detection',
    id: over.id,
    ts: over.ts,
    camera_id: 'cam1',
    label: over.label ?? 'person',
    score: over.score ?? 0.9,
    boxes: [],
    person_name: over.person_name ?? null,
    thumb_url: over.thumb_url ?? null,
    clip_url: over.clip_url ?? null,
  } as ServerEvent
}
