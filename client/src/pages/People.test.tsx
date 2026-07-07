import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PersonSummary } from '../lib/api'

// iter-326 (missing-feature #5, "Familiar Faces" log): the new
// per-person aggregation page lives at /people. Tests below pin
// the loading → ready / empty / error tri-state plus the
// per-row "N visits · last seen X ago" copy that drives the UI.

const listPeople = vi.fn()
const navigate = vi.fn()

vi.mock('../lib/api', () => ({
  listPeople: (...a: unknown[]) => listPeople(...a),
  // iter-356.66: People reads face_capture_enabled via the new
  // useFaceCaptureEnabled hook so it can render the household-trust
  // banner. Stub the call resolved-off so the existing test cases
  // see the no-banner shape they were authored against.
  getDetectionConfig: vi.fn().mockResolvedValue({
    face_capture_enabled: false,
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  )
  return { ...actual, useNavigate: () => navigate }
})

import { People } from './People'

function renderPeople() {
  return render(
    <MemoryRouter initialEntries={['/people']}>
      <People />
    </MemoryRouter>,
  )
}

describe('People page', () => {
  beforeEach(() => {
    listPeople.mockReset()
    navigate.mockReset()
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('given listPeople is in-flight, when the page mounts, then a role=status Loading cue is announced (iter-326b: NVDA needs role=status)', () => {
    // arrange
    listPeople.mockReturnValue(new Promise(() => {}))

    // act
    renderPeople()

    // assert
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/loading/i)
  })

  it('given listPeople rejects, when the page mounts, then an error message + Retry button appear (iter-326b: error must be recoverable, not a dead-end)', async () => {
    // arrange
    listPeople.mockRejectedValue(new Error('boom'))

    // act
    renderPeople()

    // assert
    await waitFor(() =>
      expect(screen.getByText(/could not load people/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/boom/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument()
  })

  it('given the user clicks Retry on the error state, when the click fires, then listPeople is called a second time (iter-326b)', async () => {
    // arrange
    listPeople
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ items: [], total: 0 })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const retry = await screen.findByRole('button', { name: /retry/i })
    await user.click(retry)

    // assert
    await waitFor(() =>
      expect(
        screen.getByText(/mushu doesn't know anyone yet/i),
      ).toBeInTheDocument(),
    )
    expect(listPeople).toHaveBeenCalledTimes(2)
  })

  it('given the server returns no people, when the page mounts, then a friendly empty-state explains why (iter-326b: copy drops "camera box" jargon)', async () => {
    // arrange
    listPeople.mockResolvedValue({ items: [], total: 0 })

    // act
    renderPeople()

    // assert
    await waitFor(() =>
      expect(
        screen.getByText(/mushu doesn't know anyone yet/i),
      ).toBeInTheDocument(),
    )
    // The empty-state copy must NOT contain the Frank-flagged
    // "camera box" jargon — replaced with "your camera setup"
    // in iter-326b. Pin this so a future copy edit doesn't
    // regress the readability win.
    expect(
      screen.queryByText(/camera box/i),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/face recognition/i),
    ).toBeInTheDocument()
  })

  it('given the server returns recognized people, when the page mounts, then one row per name renders with a visit-count and last-seen line', async () => {
    // arrange
    const now = Date.now() / 1000
    const items: PersonSummary[] = [
      {
        name: 'Alice',
        count: 3,
        last_seen_ts: now - 120, // 2 minutes ago
        first_seen_ts: now - 86400 * 7, // a week ago
        last_clip_url: '/api/clips/abc.mp4',
        last_thumb_url: '/api/snapshots/abc.jpg',
      },
      {
        name: 'Bob',
        count: 1,
        last_seen_ts: now - 3600 * 2, // 2 hours ago
        first_seen_ts: now - 3600 * 2,
        last_clip_url: null,
        last_thumb_url: null,
      },
    ]
    listPeople.mockResolvedValue({ items, total: items.length })

    // act
    renderPeople()

    // assert
    const aliceBtn = await screen.findByRole('button', {
      name: /alice/i,
    })
    expect(aliceBtn).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /bob/i }),
    ).toBeInTheDocument()
    // visit-count copy uses singular "visit" for count==1, plural otherwise.
    expect(aliceBtn.getAttribute('aria-label')).toMatch(/3 visits/i)
    expect(aliceBtn.getAttribute('aria-label')).toMatch(/2 minutes? ago/i)
    expect(
      screen
        .getByRole('button', { name: /bob/i })
        .getAttribute('aria-label'),
    ).toMatch(/1 visit\b/i)
  })

  it('given a person with no thumb_url, when the row renders, then the gradient-circle fallback shows the first letter of the name', async () => {
    // arrange
    listPeople.mockResolvedValue({
      total: 1,
      items: [
        {
          name: 'Zara',
          count: 1,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })

    // act
    renderPeople()

    // assert
    await waitFor(() =>
      expect(screen.getByText('Z')).toBeInTheDocument(),
    )
  })

  it('given the user clicks a person row, when onClick fires, then navigate is called with /events?person=NAME (iter-326b: deep-link wiring shipped)', async () => {
    // arrange
    listPeople.mockResolvedValue({
      total: 1,
      items: [
        {
          name: 'Alice',
          count: 2,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000 - 86400,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const row = await screen.findByRole('button', { name: /alice/i })
    await user.click(row)

    // assert: ?person= encoded so spaces / unicode don't break the
    // round-trip through Events.tsx's URLSearchParams.get('person').
    expect(navigate).toHaveBeenCalledWith('/events?person=Alice')
  })

  it('given a person with a space in the name, when the row is clicked, then the URL is properly URI-encoded (iter-326b)', async () => {
    // arrange
    listPeople.mockResolvedValue({
      total: 1,
      items: [
        {
          name: 'Mary Jane',
          count: 1,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const row = await screen.findByRole('button', { name: /mary jane/i })
    await user.click(row)

    // assert
    expect(navigate).toHaveBeenCalledWith('/events?person=Mary%20Jane')
  })

  it('given total > items.length, when the page renders, then a "Showing N of M" callout informs the user (iter-328 R2)', async () => {
    // arrange — server returns 2 items but reports total=147 (the
    // operator has 147 enrolled people, only the most-recent 2
    // returned in this view because of the route's limit).
    listPeople.mockResolvedValue({
      total: 147,
      items: [
        {
          name: 'Alice',
          count: 5,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000 - 86400 * 30,
          last_clip_url: null,
          last_thumb_url: null,
        },
        {
          name: 'Bob',
          count: 1,
          last_seen_ts: Date.now() / 1000 - 3600,
          first_seen_ts: Date.now() / 1000 - 86400,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })

    // act
    renderPeople()

    // assert — "Showing 2 of 147" copy. The exact wording is
    // load-bearing: a future copy edit that drops the numbers
    // would silently regress the "list is truncated" signal.
    await waitFor(() =>
      expect(screen.getByText(/showing 2 of 147/i)).toBeInTheDocument(),
    )
  })

  it('given fewer than 5 people, when the page renders, then NO search input is shown (iter-341: no UI noise on small-household deploys)', async () => {
    // arrange — 4 people = below threshold.
    const items: PersonSummary[] = ['Alice', 'Bob', 'Carol', 'Dan'].map(
      (n, i) => ({
        name: n,
        count: 1,
        last_seen_ts: Date.now() / 1000 - i * 60,
        first_seen_ts: Date.now() / 1000 - i * 86400,
        last_clip_url: null,
        last_thumb_url: null,
      }),
    )
    listPeople.mockResolvedValue({ items, total: 4 })

    // act
    renderPeople()

    // assert
    await screen.findByRole('button', { name: /alice/i })
    expect(
      screen.queryByRole('searchbox', { name: /search people/i }),
    ).not.toBeInTheDocument()
  })

  it('given 5+ people, when the page renders, then the search input is shown with a count placeholder (iter-341)', async () => {
    // arrange
    const items: PersonSummary[] = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'].map(
      (n, i) => ({
        name: n,
        count: 1,
        last_seen_ts: Date.now() / 1000 - i * 60,
        first_seen_ts: Date.now() / 1000 - i * 86400,
        last_clip_url: null,
        last_thumb_url: null,
      }),
    )
    listPeople.mockResolvedValue({ items, total: 5 })

    // act
    renderPeople()

    // assert
    const search = await screen.findByRole('searchbox', {
      name: /search people/i,
    })
    // iter-356.19: placeholder rewritten "Filter X by name" → "Search X".
    expect(search).toHaveAttribute('placeholder', 'Search 5 people')
  })

  it('given the user types into search, when the input changes, then only matching people render (iter-341)', async () => {
    // arrange
    const items: PersonSummary[] = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'].map(
      (n, i) => ({
        name: n,
        count: 1,
        last_seen_ts: Date.now() / 1000 - i * 60,
        first_seen_ts: Date.now() / 1000 - i * 86400,
        last_clip_url: null,
        last_thumb_url: null,
      }),
    )
    listPeople.mockResolvedValue({ items, total: 5 })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const search = await screen.findByRole('searchbox', {
      name: /search people/i,
    })
    await user.type(search, 'al')

    // assert — Alice matches; Bob/Carol/Dan/Eve do not.
    expect(screen.getByRole('button', { name: /alice/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^bob/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^carol/i })).not.toBeInTheDocument()
  })

  it('given a search with no matches, when the input has text, then a "No people match" status hint appears (iter-341)', async () => {
    // arrange
    const items: PersonSummary[] = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve'].map(
      (n) => ({
        name: n,
        count: 1,
        last_seen_ts: Date.now() / 1000,
        first_seen_ts: Date.now() / 1000,
        last_clip_url: null,
        last_thumb_url: null,
      }),
    )
    listPeople.mockResolvedValue({ items, total: 5 })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const search = await screen.findByRole('searchbox', {
      name: /search people/i,
    })
    await user.type(search, 'xyz_no_match')

    // assert
    expect(screen.getByText(/no results for/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /alice/i }),
    ).not.toBeInTheDocument()
  })

  it('given a mix of recent + old people, when the page renders, then Recent and "Not recently" section headings appear (iter-344+iter-347: 30-day partition + Frank-friendly heading)', async () => {
    // arrange — 2 recent (within 60d), 2 old (> 60d).
    const now = Date.now() / 1000
    const items: PersonSummary[] = [
      { name: 'Alice', count: 5, last_seen_ts: now - 60, first_seen_ts: now - 86400 * 30, last_clip_url: null, last_thumb_url: null },
      { name: 'Bob', count: 3, last_seen_ts: now - 86400 * 5, first_seen_ts: now - 86400 * 30, last_clip_url: null, last_thumb_url: null },
      { name: 'Carol', count: 2, last_seen_ts: now - 86400 * 90, first_seen_ts: now - 86400 * 200, last_clip_url: null, last_thumb_url: null },
      { name: 'Dan', count: 1, last_seen_ts: now - 86400 * 200, first_seen_ts: now - 86400 * 300, last_clip_url: null, last_thumb_url: null },
    ]
    listPeople.mockResolvedValue({ items, total: 4 })

    // act
    renderPeople()

    // assert
    await screen.findByRole('button', { name: /alice/i })
    // iter-356.19 (Maya 13th CRITICAL #1): heading vocabulary changed
    // — "Not recently" → "Earlier" (matches EventList vocabulary), and
    // count format went from " (2)" suffix to " · 2" separator.
    expect(
      screen.getByRole('heading', { name: /^recent\s+·\s*2$/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /^earlier\s+·\s*2$/i }),
    ).toBeInTheDocument()
  })

  it('given all people are recent, when the page renders, then NO section headings appear (flat list)', async () => {
    // arrange — all within 60 days.
    const now = Date.now() / 1000
    const items: PersonSummary[] = [
      { name: 'Alice', count: 1, last_seen_ts: now - 60, first_seen_ts: now - 86400, last_clip_url: null, last_thumb_url: null },
      { name: 'Bob', count: 1, last_seen_ts: now - 86400 * 5, first_seen_ts: now - 86400 * 5, last_clip_url: null, last_thumb_url: null },
    ]
    listPeople.mockResolvedValue({ items, total: 2 })

    // act
    renderPeople()

    // assert — no Recent/Earlier headings; just the flat row list.
    await screen.findByRole('button', { name: /alice/i })
    expect(screen.queryByRole('heading', { name: /^recent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^not recently/i })).not.toBeInTheDocument()
  })

  it('given an old person (>60 days), when the row renders, then last-seen displays as month-year not "N days ago"', async () => {
    // arrange — last_seen_ts is March 2024 (well past 60-day cutoff).
    const items: PersonSummary[] = [
      { name: 'Carol', count: 1, last_seen_ts: 1709856000, first_seen_ts: 1700000000, last_clip_url: null, last_thumb_url: null },
    ]
    listPeople.mockResolvedValue({ items, total: 1 })

    // act
    renderPeople()

    // assert — month name appears in the visible row text. The
    // exact rendered string depends on the test runner's locale but
    // SHOULD NOT contain "N days ago".
    const row = await screen.findByRole('button', { name: /carol/i })
    expect(row.textContent).not.toMatch(/\bdays? ago\b/i)
  })

  it('given the user searches with a query, when results render, then partition headings are HIDDEN even if mixed-recency (iter-344: search results stay flat)', async () => {
    // arrange — mixed recency, but search bar narrows it.
    const now = Date.now() / 1000
    const items: PersonSummary[] = Array.from({ length: 6 }, (_, i) => ({
      name: `Person${i}`,
      count: 1,
      last_seen_ts: i < 3 ? now - 60 : now - 86400 * 200,
      first_seen_ts: now - 86400 * 300,
      last_clip_url: null,
      last_thumb_url: null,
    }))
    listPeople.mockResolvedValue({ items, total: 6 })
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()

    // act
    renderPeople()
    const search = await screen.findByRole('searchbox')
    await user.type(search, 'Person')

    // assert — section headings absent during active search.
    expect(screen.queryByRole('heading', { name: /^recent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^not recently/i })).not.toBeInTheDocument()
  })

  it('given total === items.length, when the page renders, then NO truncation callout appears (iter-328 R2)', async () => {
    // arrange — small enrollment, route returned everything;
    // the callout would be noise.
    listPeople.mockResolvedValue({
      total: 2,
      items: [
        {
          name: 'Alice',
          count: 1,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000,
          last_clip_url: null,
          last_thumb_url: null,
        },
        {
          name: 'Bob',
          count: 1,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })

    // act
    renderPeople()

    // assert
    await screen.findByRole('button', { name: /alice/i })
    expect(screen.queryByText(/showing.*of/i)).not.toBeInTheDocument()
  })

  it('given the People page renders, when AT users query for the page heading, then a level-1 sr-only heading is present (iter-356.63: Slice D a11y — sr-only h1 per route)', () => {
    // arrange
    listPeople.mockResolvedValue({ people: [] })

    // act
    renderPeople()

    // assert — the visible "Faces" title is a <p> for visual reasons
    // (the WatchRibbon owns identity), but AT users still need a
    // level-1 heading per route. Playroom Modern (Task 9): "Familiar
    // faces" -> "Faces", matching the SideNav route label.
    expect(
      screen.getByRole('heading', { level: 1, name: /^faces$/i }),
    ).toBeInTheDocument()
  })

  // Playroom Modern (Task 9): identity system rollout — the header
  // spells out the color legend, and each known person's card wears
  // its own WhoMark badge (SVG role="img", named after the person)
  // in their stable wheel hue.
  it('given the People page renders, then the header explains the per-person color system (Task 9)', async () => {
    // arrange
    listPeople.mockResolvedValue({ items: [], total: 0 })

    // act
    renderPeople()

    // assert
    expect(
      screen.getByText(/everyone the camera knows gets their own color/i),
    ).toBeInTheDocument()
  })

  it('given the server returns a recognized person, when the row renders, then a WhoMark badge names that person (Task 9)', async () => {
    // arrange
    listPeople.mockResolvedValue({
      total: 1,
      items: [
        {
          name: 'Alice',
          count: 1,
          last_seen_ts: Date.now() / 1000,
          first_seen_ts: Date.now() / 1000,
          last_clip_url: null,
          last_thumb_url: null,
        },
      ],
    })

    // act
    renderPeople()

    // assert — WhoMark renders as an accessible img named after the
    // person (distinct from the button's own aria-label).
    await screen.findByRole('button', { name: /alice: 1 visit/i })
    expect(screen.getByRole('img', { name: 'Alice' })).toBeInTheDocument()
  })
})
