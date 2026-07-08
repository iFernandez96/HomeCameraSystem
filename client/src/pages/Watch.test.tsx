import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { DetectionEvent } from '../lib/types'

// ── Mock surface ─────────────────────────────────────────────────
const searchEvents = vi.fn()
const captureSnapshot = vi.fn()
const getStatusM = vi.fn()

vi.mock('../lib/api', () => {
  // Defined inside the factory — vi.mock hoists above imports, so a
  // top-level class would be referenced before initialization.
  class HttpError extends Error {
    status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return {
    searchEvents: (...a: unknown[]) => searchEvents(...a),
    captureSnapshot: (...a: unknown[]) => captureSnapshot(...a),
    getStatus: (...a: unknown[]) => getStatusM(...a),
    HttpError,
  }
})

// The WebRTC tile owns WHEP wiring that jsdom can't exercise — stub
// it; Watch's job is the chrome AROUND it. Renders the `fit` and
// `showStatusPill` props as data-attributes so fuzz F4/F3 wiring
// (landscape-aware fit, docked-only status pill) is assertable
// without dragging WHEP into this test file.
vi.mock('../components/VideoTile', () => ({
  VideoTile: ({
    fit,
    showStatusPill,
    onPlayingChange,
    actions,
    showFullscreenButton,
  }: {
    fit?: string
    showStatusPill?: boolean
    onPlayingChange?: (playing: boolean) => void
    actions?: ReactNode
    showFullscreenButton?: boolean
  }) => (
    <div
      data-testid="video-tile-stub"
      data-fit={fit}
      data-show-status-pill={String(showStatusPill)}
    >
      {/* Status-truth fix test hooks: the real VideoTile fires
          onPlayingChange on confirmed 'live'/'error' transitions —
          these buttons let tests drive that signal without dragging
          WHEP mocking into this file. */}
      <button type="button" onClick={() => onPlayingChange?.(true)}>
        simulate-video-playing
      </button>
      <button type="button" onClick={() => onPlayingChange?.(false)}>
        simulate-video-error
      </button>
      {/* Control-overlap fix: the real VideoTile owns a single flex
          row for its docked corner and renders `actions` inside it —
          mirror that here (one shared row container) so tests can
          assert Watch's Snapshot/expand buttons are siblings inside
          ONE owner, and that a native fullscreen button isn't ALSO
          rendered when Watch opts out via showFullscreenButton=false. */}
      <div data-testid="video-tile-actions-row">
        {actions}
        {showFullscreenButton !== false && (
          <button type="button" aria-label="Enter fullscreen">
            stub-native-fullscreen
          </button>
        )}
      </div>
    </div>
  ),
}))
// ClipModal drags in <video> + tracks fetching; Watch only needs to
// know it opened with the right event.
vi.mock('../components/ClipModal', () => ({
  ClipModal: ({ event }: { event: DetectionEvent }) => (
    <div role="dialog" aria-label={`clip:${event.id}`} />
  ),
}))
vi.mock('../components/SnapshotPreview', () => ({
  SnapshotPreview: ({ url }: { url: string }) => (
    <div role="dialog" aria-label={`snapshot:${url}`} />
  ),
}))

import { ToastProvider } from '../lib/toast'
import { Watch } from './Watch'

const HEALTHY = {
  ok: true,
  uptime_s: 100,
  camera: 'ok',
  camera_label: 'Front Door',
  detection_active: true,
  worker_alive: true,
  worker_last_seen_s: 1,
  seconds_since_last_frame: 2,
  worker_metrics: null,
}

function ev(partial: Partial<DetectionEvent>): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: partial.id ?? 'e1',
    ts: partial.ts ?? Date.now() / 1000 - 60,
    camera_id: 'cam',
    label: partial.label ?? 'person',
    score: 0.9,
    boxes: [],
    thumb_url: null,
    ...partial,
  }
}

function renderWatch() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Watch />
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getStatusM.mockResolvedValue(HEALTHY)
  searchEvents.mockResolvedValue({ items: [], next_cursor: null })
})

describe('Watch — Home screen (Playroom Modern)', () => {
  it('Given a healthy armed camera, When the page renders, Then the heading reads Home, the docked video shows only the camera-name pill, and the glance card owns the armed state in the shared ribbon vocabulary (overhaul W1 item 2)', async () => {
    // arrange / act
    renderWatch()

    // assert — page heading + glance card copy carry the armed state.
    // The glance headline now speaks the ONE shared vocabulary from
    // lib/watchState.ts ("On watch", same as the ribbon), replacing
    // the page-local "Watching" synonym.
    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('On watch')).toBeInTheDocument()
    })
    expect(screen.getByText(/is on watch · alerts on/)).toBeInTheDocument()
    // Fuzz F3/F9/F13 still holds: the armed state renders exactly ONCE
    // docked (the glance card) — no duplicate pill over the video.
    expect(screen.getAllByText('On watch')).toHaveLength(1)
    expect(screen.getByText('Front Door')).toBeInTheDocument()
  })

  it("Given events today, When the timeline loads, Then rows show who appeared and tapping one opens the clip", async () => {
    // arrange
    const known = ev({ id: 'k1', person_name: 'Israel' })
    const stranger = ev({ id: 's1', ts: Date.now() / 1000 - 120 })
    searchEvents.mockResolvedValue({ items: [known, stranger], next_cursor: null })
    const user = userEvent.setup()

    // act
    renderWatch()
    await waitFor(() => {
      expect(screen.getByText('Israel at cam')).toBeInTheDocument()
    })

    // assert — unrecognized row renders too + clip opens for the tapped row
    expect(screen.getByText('Person at cam')).toBeInTheDocument()
    await user.click(screen.getByText('Israel at cam'))
    expect(screen.getByRole('dialog', { name: 'clip:k1' })).toBeInTheDocument()
  })

  it('Given repeat sightings of one person today, When the glance card renders, Then the count reads as sightings not distinct people (painfix wave B #1)', async () => {
    // arrange — the same person crossing the porch many times in one
    // day used to read "50 people"; every row here is label 'person'
    // so the honest word is "sightings", not a head count.
    const items = Array.from({ length: 3 }, (_, i) =>
      ev({ id: `p${i}`, label: 'person', ts: Date.now() / 1000 - i * 60 }),
    )
    items.push(ev({ id: 'c1', label: 'cat', ts: Date.now() / 1000 - 300 }))
    searchEvents.mockResolvedValue({ items, next_cursor: null })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('3 person sightings · 1 cat sighting')).toBeInTheDocument()
    })
  })

  it('Given no events yet today, When the timeline loads, Then the cat empty state explains the quiet', async () => {
    // arrange / act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('All quiet so far')).toBeInTheDocument()
    })
  })

  it('Given the snapshot button, When tapped and the API resolves, Then the snapshot preview opens', async () => {
    // arrange
    captureSnapshot.mockResolvedValue({ ok: true, url: '/snapshots/x.jpg' })
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Snapshot' }))

    // assert
    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: 'snapshot:/snapshots/x.jpg' }),
      ).toBeInTheDocument()
    })
  })

  it('Given the docked live tile, When rendered, Then Snapshot + expand are the ONLY corner buttons and sit inside VideoTile-owned single row, not a second Watch-owned overlay (control-overlap fix)', () => {
    // arrange / act
    renderWatch()

    // assert — Snapshot and expand are children of the row VideoTile
    // renders `actions` into (single owner of the docked corner), not
    // a second absolutely-positioned Watch overlay stacked on top of
    // it.
    const row = screen.getByTestId('video-tile-actions-row')
    const snapshotBtn = screen.getByRole('button', { name: 'Snapshot' })
    const expandBtn = screen.getByRole('button', { name: 'Full screen live view' })
    expect(row).toContainElement(snapshotBtn)
    expect(row).toContainElement(expandBtn)
    // VideoTile's own native-fullscreen button must be suppressed —
    // Watch's CSS docked/full toggle is the one canonical "make it
    // bigger" affordance; two competing fullscreen buttons was part
    // of the original overlap bug.
    expect(
      screen.queryByRole('button', { name: 'stub-native-fullscreen' }),
    ).not.toBeInTheDocument()
  })

  it('Given the docked viewport, When Full screen is tapped, Then the viewport goes full-bleed with a combined armed+camera pill and Exit restores it', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()
    const viewport = screen.getByTestId('live-viewport')
    expect(viewport.className).toMatch(/relative/)

    // act — enter full screen
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — fixed overlay + the ONE consolidated status cluster
    // (fuzz F3/F9/F13: was 3 separate pieces — state pill, camera
    // pill, "Live now" text — now one "{state} · {camera}" pill).
    expect(viewport.className).toMatch(/fixed inset-0/)
    await waitFor(() => {
      expect(screen.getByText('On watch · Front Door')).toBeInTheDocument()
    })
    // Fuzz F11: the "Talk · soon" placeholder is gone — two-way audio
    // is out-of-scope hardware work, not a fullscreen-worthy button.
    expect(
      screen.queryByRole('button', { name: /Talk/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Snapshot/ })).toBeInTheDocument()

    // act — exit
    await user.click(screen.getByRole('button', { name: 'Exit full screen' }))
    expect(viewport.className).toMatch(/relative/)
  })

  it('Given the worker is offline, When the page renders, Then the verdict says the camera is offline via the glance card (whimsy never masks danger) — fuzz F3/F9/F13: the danger-styled glance card is now the SOLE prominent armed/offline surface docked, since the redundant on-video state pill was consolidated away', async () => {
    // arrange
    getStatusM.mockResolvedValue({
      ...HEALTHY,
      worker_alive: false,
      detection_active: true,
    })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Check its power, then see Settings.'),
    ).toBeInTheDocument()
  })

  // Status-truth fix (server-restart contradiction, 2026-07-07): a
  // user saw "camera is down" while the live feed visibly streamed —
  // /api/status was briefly unreachable during a server restart. The
  // three cases below pin the new truth model: status-unreachable +
  // video-playing must NOT claim the camera is down; status-confirmed
  // -dead always wins regardless of video; status-unreachable +
  // video-confirmed-not-playing is a real "both channels dark" outage.

  it('Given the status fetch fails, When the video tile confirms frames are playing, Then the glance card shows the reconnecting copy, not Camera offline', async () => {
    // arrange — /api/status errors on every poll (simulates the
    // server-restart window); the stubbed VideoTile drives its own
    // onPlayingChange signal via the test-hook button.
    getStatusM.mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()

    // act
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'simulate-video-playing' }))

    // assert — headline is the low-alarm shared-vocabulary
    // "Reconnecting…", sublabel is honest about the API, no danger
    // copy anywhere.
    await waitFor(() => {
      expect(screen.getByText('Status reconnecting…')).toBeInTheDocument()
    })
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    expect(screen.queryByText('Camera offline')).not.toBeInTheDocument()
  })

  it('Given /api/status confirms the worker is dead, When the video tile ALSO confirms frames are playing, Then the Offline danger state still shows (status-confirmed-down wins regardless of video)', async () => {
    // arrange
    getStatusM.mockResolvedValue({
      ...HEALTHY,
      worker_alive: false,
      detection_active: true,
    })
    const user = userEvent.setup()

    // act
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'simulate-video-playing' }))

    // assert
    await waitFor(() => {
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
    })
    expect(
      screen.getByText('Check its power, then see Settings.'),
    ).toBeInTheDocument()
  })

  it('Given the status fetch fails AND the video tile confirms frames are NOT playing, When the page renders, Then the danger state shows (both channels dark)', async () => {
    // arrange
    getStatusM.mockRejectedValue(new Error('network down'))
    const user = userEvent.setup()

    // act
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'simulate-video-error' }))

    // assert
    await waitFor(() => {
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
    })
    expect(
      screen.getByText("Can't reach the camera. Check its connection."),
    ).toBeInTheDocument()
  })

  it('Given the status fetch fails and the video tile has not resolved yet, When the page renders, Then it stays neutral instead of flashing Camera offline (cold-mount guard)', async () => {
    // arrange — neither channel has confirmed anything yet (the
    // pre-fix cold-mount state). Must not read as a danger.
    getStatusM.mockRejectedValue(new Error('network down'))

    // act
    renderWatch()

    // assert — neutral "Checking…" (shared vocabulary), no danger copy.
    await waitFor(() => {
      expect(screen.getByText('Checking…')).toBeInTheDocument()
    })
    expect(screen.queryByText('Camera offline')).not.toBeInTheDocument()
  })

  it('Given the worker is offline, When the page renders, Then the glance headline reads "Camera offline" (not an off-duty synonym) — final review fix batch #8 + overhaul W1 item 2', async () => {
    // arrange — pre-fix the glance card said "Paused" for offline,
    // which reads as "detection is paused" rather than "the camera
    // itself is unreachable." Danger styling + the existing detail
    // line ("Check its power, then see Settings.") are unchanged.
    getStatusM.mockResolvedValue({
      ...HEALTHY,
      worker_alive: false,
      detection_active: true,
    })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('Camera offline')).toBeInTheDocument()
    })
    expect(screen.queryByText('Off duty')).not.toBeInTheDocument()
    expect(
      screen.getByText('Check its power, then see Settings.'),
    ).toBeInTheDocument()
  })

  // Fuzz F4: landscape fullscreen wasted ~45% of the width because
  // `object-contain` letterboxes a 16:9 stream inside a much-wider
  // landscape phone viewport. Fix flips to `object-cover` only when
  // BOTH full AND the physical device is landscape-oriented.

  it('Given fullscreen on a portrait device, When rendered, Then the video keeps object-contain so the scene is never cropped (fuzz F4)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert
    await waitFor(() =>
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-fit', 'contain'),
    )
  })

  it('Given fullscreen on a landscape device, When rendered, Then the video switches to object-cover to fill the wide viewport (fuzz F4)', async () => {
    // arrange — matchMedia('(orientation: landscape)') reports landscape.
    const originalMatchMedia = window.matchMedia
    const mql = {
      matches: true,
      media: '(orientation: landscape)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia
    try {
      const user = userEvent.setup()
      renderWatch()

      // act
      await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

      // assert
      await waitFor(() =>
        expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-fit', 'cover'),
      )
    } finally {
      window.matchMedia = originalMatchMedia
    }
  })

  it('Given the docked viewport, When rendered, Then VideoTile owns the ONE status pill (showStatusPill=true) and fullscreen turns it off in favor of the combined cluster (fuzz F3/F7/F13)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()

    // assert — docked
    await waitFor(() =>
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-show-status-pill',
        'true',
      ),
    )

    // act — enter full screen
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — fullscreen suppresses the tile's own pill (the combined
    // "{state} · {camera}" cluster + scrubber LIVE pill cover it).
    await waitFor(() =>
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-show-status-pill',
        'false',
      ),
    )
  })

  // Fuzz F5: the fullscreen thumb rail (Snapshot) clipped under the
  // status-bar / camera-cutout area on a real landscape device.

  it('Given fullscreen, When the thumb rail renders, Then it carries safe-area-inset top/right padding (fuzz F5)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))
    const rail = await screen.findByRole('button', { name: /Snapshot/ })

    // assert — jsdom drops bare env() from computed style, so assert
    // against the raw style attribute string (see project memory:
    // jsdom-env-style-drop).
    const style = rail.parentElement?.getAttribute('style') ?? ''
    expect(style).toMatch(/padding-top:\s*max\(0\.5rem,\s*env\(safe-area-inset-top\)\)/)
    expect(style).toMatch(/padding-right:\s*max\(0\.5rem,\s*env\(safe-area-inset-right\)\)/)
  })

  // Fuzz F8: the story-row subline was always the constant "Tap to
  // review" — dead weight since the row is already a button.

  it('Given an unrecognized person event, When the story row renders, Then the subline names the recognition state instead of "Tap to review" (fuzz F8)', async () => {
    // arrange
    const stranger = ev({ id: 's1', label: 'person', ts: Date.now() / 1000 - 90 })
    searchEvents.mockResolvedValue({ items: [stranger], next_cursor: null })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText(/Not recognized · /)).toBeInTheDocument()
    })
    expect(screen.queryByText('Tap to review')).not.toBeInTheDocument()
  })

  it('Given a cat event, When the story row renders, Then the subline shows relative time instead of the generic "Tap for the clip" (fuzz F8)', async () => {
    // arrange
    const cat = ev({ id: 'c1', label: 'cat', ts: Date.now() / 1000 - 90 })
    searchEvents.mockResolvedValue({ items: [cat], next_cursor: null })

    // act
    renderWatch()

    // assert
    await waitFor(() => {
      expect(screen.getByText('1m ago')).toBeInTheDocument()
    })
    expect(screen.queryByText('Tap for the clip')).not.toBeInTheDocument()
  })

  // Fuzz F1: the fullscreen hour scrubber colored activity cells flat
  // orange and the NOW cell solid green — two colors that mean
  // nothing in the Playroom identity system (which colors WHO
  // appeared: cobalt person, marmalade cat, per-person wheel hues).

  it('Given a person event near the start of today, When fullscreen renders, Then the owning scrubber cell uses the identity dark hex instead of the old flat accent orange (fuzz F1)', async () => {
    // arrange — bucket 0 covers the first ~1/16th of the elapsed day;
    // an event a minute after local midnight always lands there.
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const personEvent = ev({
      id: 'p1',
      label: 'person',
      ts: midnight.getTime() / 1000 + 60,
    })
    searchEvents.mockResolvedValue({ items: [personEvent], next_cursor: null })
    const user = userEvent.setup()

    // act
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — dark-range person hex (#6c8ff0, jsdom normalizes to
    // rgb()), not the old `--color-accent-bright` orange fill.
    await waitFor(() => {
      const cell = screen.getByTestId('hour-cell-0')
      expect(cell.getAttribute('style')).toMatch(/background:\s*rgb\(108,\s*143,\s*240\)/)
      expect(cell.getAttribute('style')).not.toMatch(/accent-bright/)
    })
  })

  // Overhaul W1 item 5 (hari GESTURE-2): the fullscreen strip used to
  // be DRESSED as a seek scrubber (12AM/6AM/12PM/NOW axis + a ringed
  // NOW cell) while actually being one nav button to /events — a
  // misleading affordance. It is now an honestly-labeled activity
  // button; the identity-colored cells stay as a glanceable summary.

  it('Given fullscreen, When the activity strip renders, Then it is a labeled history button with no fake time-axis dress-up (overhaul W1 item 5)', async () => {
    // arrange
    const user = userEvent.setup()

    // act
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — the visible label says exactly what a tap does…
    const strip = await screen.findByRole('button', {
      name: /Today's activity.*Open history/,
    })
    expect(strip).toBeInTheDocument()
    // …and the seek-scrubber costume is gone: no time axis, no ringed
    // NOW cell, no --color-success fill anywhere in the strip.
    expect(screen.queryByText('12 AM')).not.toBeInTheDocument()
    expect(screen.queryByText('6 AM')).not.toBeInTheDocument()
    expect(screen.queryByText('12 PM')).not.toBeInTheDocument()
    expect(screen.queryByText('NOW')).not.toBeInTheDocument()
    expect(screen.queryByTestId('hour-cell-now')).not.toBeInTheDocument()
    const lastCell = screen.getByTestId('hour-cell-15')
    expect(lastCell.className).not.toMatch(/color-success/)
    expect(lastCell.getAttribute('style') ?? '').not.toMatch(/color-success/)
  })

  it('Given fullscreen, When the activity strip is tapped, Then it exits fullscreen (navigates to full history) (overhaul W1 item 5)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))
    const viewport = screen.getByTestId('live-viewport')
    expect(viewport.className).toMatch(/fixed inset-0/)

    // act
    await user.click(
      await screen.findByRole('button', { name: /Today's activity.*Open history/ }),
    )

    // assert — the docked layout is restored (navigate('/events') is a
    // MemoryRouter no-op here; the observable half is the exit).
    expect(viewport.className).toMatch(/relative/)
  })

  // Overhaul W1 item 3 (mira#4, hari GESTURE-4): the timeline error
  // used to be a bare red <p> telling users to "pull to refresh" — a
  // gesture that does not exist anywhere in the app, with no retry.

  it("Given today's events fail to load, When the timeline renders, Then the designed error state shows with a working Retry button and no phantom pull-to-refresh copy (overhaul W1 item 3)", async () => {
    // arrange — first fetch rejects, the retried fetch succeeds.
    searchEvents.mockRejectedValueOnce(new Error('boom'))
    const user = userEvent.setup()

    // act
    renderWatch()

    // assert — designed error surface, honest copy.
    await waitFor(() => {
      expect(screen.getByText("Couldn't load today's events")).toBeInTheDocument()
    })
    expect(screen.queryByText(/pull to refresh/i)).not.toBeInTheDocument()

    // act — Retry refetches through the same refetch-key mechanism.
    searchEvents.mockResolvedValue({
      items: [ev({ id: 'r1', person_name: 'Israel' })],
      next_cursor: null,
    })
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    // assert
    await waitFor(() => {
      expect(screen.getByText('Israel at cam')).toBeInTheDocument()
    })
    expect(screen.queryByText("Couldn't load today's events")).not.toBeInTheDocument()
  })

  // Overhaul W1 item 9 (frank I1): a silently-revoked notification
  // permission was only discoverable inside Settings → Alerts.

  it('Given notification permission is denied, When Home renders, Then an "Alerts are off" chip shows and tapping it deep-links to Settings → Alerts (overhaul W1 item 9)', async () => {
    // arrange — jsdom has no Notification global; install one.
    vi.stubGlobal('Notification', { permission: 'denied' })
    window.localStorage.removeItem('homecam:settingsTab')
    const user = userEvent.setup()
    try {
      // act
      renderWatch()
      const chip = screen.getByRole('button', { name: /Alerts are off/ })

      // assert — visible, honest copy (no jargon).
      expect(chip).toHaveTextContent('Notifications are blocked for this app.')

      // act — tapping seeds the Settings tab key and navigates.
      await user.click(chip)

      // assert — Settings has no URL tab param; the deep-link works by
      // seeding the localStorage key Settings reads on mount.
      expect(window.localStorage.getItem('homecam:settingsTab')).toBe('notifications')
    } finally {
      vi.unstubAllGlobals()
      window.localStorage.removeItem('homecam:settingsTab')
    }
  })

  it('Given notification permission is granted, When Home renders, Then no alerts chip shows (overhaul W1 item 9)', () => {
    // arrange
    vi.stubGlobal('Notification', { permission: 'granted' })
    try {
      // act
      renderWatch()

      // assert
      expect(
        screen.queryByRole('button', { name: /Alerts are off/ }),
      ).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // Overhaul W1 item 1 (landscape-desktop Top/A1): Watch was the only
  // route with zero lg: treatment.

  it('Given a desktop viewport, When Watch renders, Then the page root carries the lg two-pane grid with an overall width ceiling (overhaul W1 item 1)', () => {
    // arrange / act
    const { container } = renderWatch()

    // assert — class pins (jsdom can't lay out; the grid classes are
    // the contract, mirroring the proven landscape-phone pattern).
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/lg:grid /)
    expect(root.className).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_minmax\(20rem,26rem\)\]/)
    expect(root.className).toMatch(/lg:max-w-\[100rem\]/)
    expect(root.className).toMatch(/lg:overflow-hidden/)
  })

  it('Given fullscreen, When the exit control renders, Then it meets the 44px touch floor (overhaul W1 item 4, frank#1 / hari REACH-2)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — w-11/h-11 (44px), not the old sub-target w-9.
    const exit = screen.getByRole('button', { name: 'Exit full screen' })
    expect(exit.className).toMatch(/w-11/)
    expect(exit.className).toMatch(/h-11/)
    expect(exit.className).not.toMatch(/w-9/)
  })
})
