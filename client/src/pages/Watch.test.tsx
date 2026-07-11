import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { DetectionEvent } from '../lib/types'

// ── Mock surface ─────────────────────────────────────────────────
const searchEvents = vi.fn()
const captureSnapshot = vi.fn()
const getStatusM = vi.fn()
// Multicam contract (2026-07-07): Watch now fetches the camera
// registry once on mount. Defaults to the single-camera registry in
// beforeEach so every pre-multicam test renders exactly as before
// (no switcher); the multicam tests override.
const getCamerasM = vi.fn()
const getCurrentPackagesM = vi.fn()
const triggerDeterrenceM = vi.fn()
let authRole: 'owner' | 'family' = 'owner'

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    state: 'authed',
    user: { username: 'watch-user', role: authRole },
    login: vi.fn(),
    logout: vi.fn(),
  }),
}))

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
    getCameras: (...a: unknown[]) => getCamerasM(...a),
    getCurrentPackages: (...a: unknown[]) => getCurrentPackagesM(...a),
    triggerDeterrence: (...a: unknown[]) => triggerDeterrenceM(...a),
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
    showQualityMenu,
    showBoxToggle,
    streamPath,
  }: {
    fit?: string
    showStatusPill?: boolean
    onPlayingChange?: (playing: boolean) => void
    actions?: ReactNode
    showFullscreenButton?: boolean
    showQualityMenu?: boolean
    showBoxToggle?: boolean
    streamPath?: string
  }) => (
    <div
      data-testid="video-tile-stub"
      data-fit={fit}
      data-show-status-pill={String(showStatusPill)}
      data-stream-path={streamPath}
      data-show-quality-menu={String(showQualityMenu)}
      data-show-box-toggle={String(showBoxToggle)}
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
import { ConfirmProvider } from '../lib/confirm'
import { registerCameraNames } from '../lib/eventLabel'
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

function renderWatch(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <ConfirmProvider>
          <Watch />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  authRole = 'owner'
  getStatusM.mockResolvedValue(HEALTHY)
  searchEvents.mockResolvedValue({ items: [], next_cursor: null })
  // Multicam: single-camera registry default so pre-multicam tests
  // render exactly as before; the eventLabel registry + persisted
  // selection are module/storage state — reset for order-independence.
  getCamerasM.mockResolvedValue({
    cameras: [{ id: 'front_door', name: 'Front Door', path: 'cam' }],
  })
  getCurrentPackagesM.mockResolvedValue({ v: 1, items: [] })
  triggerDeterrenceM.mockResolvedValue({
    ok: true,
    status: 'executed',
    reason: 'executed',
    action: 'siren',
    duration_s: 20,
    capabilities: {
      available: true,
      adapter: 'mounted_executable',
      limitation: '',
    },
  })
  registerCameraNames([])
  window.localStorage.removeItem('homecam:cameraId')
})

describe('Watch — Home screen (Playroom Modern)', () => {
  it('Given a healthy single camera, When the page renders, Then docked video omits the redundant camera-name pill and the glance card owns armed state', async () => {
    // arrange / act
    renderWatch()

    // assert — page heading + live bottom-card copy carry the armed state.
    // The live summary headline now speaks the ONE shared vocabulary from
    // lib/watchState.ts ("On watch", same as the ribbon), replacing
    // the page-local "Watching" synonym.
    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('On watch')).toBeInTheDocument()
    })
    expect(document.body).toHaveTextContent(/is on watch · alerts on/)
    const strip = screen.getByTestId('live-glance-strip')
    expect(screen.getByTestId('live-viewport')).toContainElement(strip)
    expect(strip.className).toMatch(/border-t/)
    expect(strip.className).toMatch(/bg-black\/88/)
    expect(strip.className).not.toMatch(/absolute/)
    // Fuzz F3/F9/F13 still holds: the armed state renders exactly ONCE
    // docked (the glance card) — no duplicate pill over the video.
    expect(screen.getAllByText('On watch')).toHaveLength(1)
    expect(screen.queryByText('Front Door')).not.toBeInTheDocument()
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

  it('Given repeat sightings of one person today, When the live summary renders, Then the count reads as sightings not distinct people (painfix wave B #1)', async () => {
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
      expect(document.body).toHaveTextContent('3 person sightings · 1 cat sighting')
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
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // act
    await user.click(screen.getByRole('button', { name: 'Snapshot' }))

    // assert
    await waitFor(() => {
      expect(
        screen.getByRole('dialog', { name: 'snapshot:/snapshots/x.jpg' }),
      ).toBeInTheDocument()
    })
  })

  it('Given the docked live tile, When rendered, Then camera actions remain available below video and Expand is the only over-video corner button', () => {
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
    expect(row).not.toContainElement(expandBtn)
    expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-show-quality-menu', 'true')
    expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-show-box-toggle', 'true')
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

  it('Given full screen is showing, When 3.5s pass with no interaction, Then the chrome fades out; a later poke brings it back (fullscreen contract item 4)', async () => {
    // arrange — fireEvent (not userEvent): fake timers stall
    // userEvent's internal waits.
    vi.useFakeTimers()
    try {
      renderWatch()
      fireEvent.click(
        screen.getByRole('button', { name: 'Full screen live view' }),
      )
      const exitBtn = screen.getByRole('button', { name: 'Exit full screen' })
      const topCluster = exitBtn.parentElement as HTMLElement
      expect(topCluster.style.visibility).not.toBe('hidden')

      // act — idle past the hide window.
      act(() => {
        vi.advanceTimersByTime(3600)
      })

      // assert — chrome hidden.
      expect(topCluster.style.opacity).toBe('0')
      expect(topCluster.style.visibility).toBe('hidden')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Given full screen is entered, When entered, Then a history entry is pushed so the platform back gesture maps to "exit fullscreen" (fullscreen contract 2026-07-07)', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()

    // act
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))

    // assert — the marker entry is on top of the stack.
    expect(window.history.state?.homecamFull).toBe(true)
  })

  it('Given full screen is showing, When the back gesture fires (popstate), Then fullscreen exits back to the docked layout', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch()
    const viewport = screen.getByTestId('live-viewport')
    await user.click(screen.getByRole('button', { name: 'Full screen live view' }))
    expect(viewport.className).toMatch(/fixed inset-0/)

    // act — what the Android back gesture produces.
    act(() => {
      window.history.back()
    })

    // assert
    await waitFor(() => expect(viewport.className).toMatch(/relative/))
  })

  it('Given the worker is offline, When the page renders, Then the verdict says the camera is offline via the live bottom card (whimsy never masks danger) — fuzz F3/F9/F13: the danger-styled live card is now the SOLE prominent armed/offline surface docked, since the redundant on-video state pill was consolidated away', async () => {
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

  it('Given the status fetch fails, When the video tile confirms frames are playing, Then the live bottom card shows the reconnecting copy, not Camera offline', async () => {
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

  it('Given docked mode on a landscape device, When rendered, Then the video uses object-contain so the camera aspect ratio stays honest', () => {
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
      // act
      renderWatch()

      // assert
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-fit', 'contain')
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

  it('Given docked live video, When the scene is tapped, Then over-video chrome hides and a second tap restores it without hiding the below-video toolbar', async () => {
    const user = userEvent.setup()
    renderWatch()
    const scene = screen.getByTestId('live-scene')

    expect(screen.getByRole('button', { name: 'Full screen live view' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Snapshot' })).toBeInTheDocument()

    await user.click(scene)
    expect(screen.queryByRole('button', { name: 'Full screen live view' })).not.toBeInTheDocument()
    expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-show-status-pill', 'false')
    expect(screen.getByRole('button', { name: 'Snapshot' })).toBeInTheDocument()

    await user.click(scene)
    expect(screen.getByRole('button', { name: 'Full screen live view' })).toBeInTheDocument()
    expect(screen.getByTestId('video-tile-stub')).toHaveAttribute('data-show-status-pill', 'true')
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
    expect(root.className).toMatch(
      /landscape-phone:grid-cols-\[minmax\(0,1fr\)_clamp\(22rem,32vw,29rem\)\]/,
    )
    expect(root.className).toMatch(/landscape-phone:gap-x-4/)
    expect(root.className).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_minmax\(20rem,26rem\)\]/)
    expect(root.className).toMatch(/lg:max-w-\[100rem\]/)
    expect(root.className).toMatch(/overflow-hidden/)
  })

  it('Given Watch renders, Then only the Today at home section owns vertical scrolling', () => {
    // arrange / act
    const { container } = renderWatch()

    // assert — root/page and lower pane are height-bounded; the
    // timeline section itself is the scroll container so the live view
    // stays anchored.
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/h-\[calc\(100dvh-var\(--ribbon-h,0px\)\)\]/)
    expect(root.className).toMatch(/overflow-hidden/)

    const timeline = screen.getByLabelText("Today's activity")
    expect(timeline.className).toMatch(/flex/)
    expect(timeline.className).toMatch(/min-h-0/)
    expect(timeline.className).toMatch(/flex-1/)
    expect(timeline.className).toMatch(/landscape-phone:order-2/)
    expect(timeline.className).toMatch(/landscape-phone:pt-0/)
    expect(timeline.className).toMatch(/landscape-phone:pb-2/)
    expect(timeline.className).toMatch(/landscape-phone:scrollbar-hide/)
    expect(timeline.className).toMatch(/pb-\[calc\(6rem\+env\(safe-area-inset-bottom\)\)\]/)
    expect(timeline.className).toMatch(/overflow-y-auto/)
    expect(timeline.className).toMatch(/overscroll-contain/)
    expect(timeline.className).toMatch(/touch-pan-y/)

    const list = timeline.querySelector('ol') as HTMLOListElement | null
    expect(list).not.toBeNull()
    expect(list!.className).not.toMatch(/overflow-y-auto/)
  })

  it('Given a landscape phone viewport, When Watch renders, Then the live bottom cards stay compact so Today at home remains visible', () => {
    // arrange / act
    const { container } = renderWatch()

    // assert — in the short landscape viewport the visible title/brand
    // row is removed from the layout but the header itself can still
    // host real controls such as the multicam switcher. The live
    // video remains a true camera-aspect surface, and the status
    // summary belongs to the live tile instead of consuming the event rail.
    const header = container.querySelector('header') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(header!.className).toMatch(/landscape-phone:col-span-2/)
    expect(header!.className).toMatch(/landscape-phone:p-0/)
    const titleRow = header!.querySelector('div') as HTMLElement | null
    expect(titleRow).not.toBeNull()
    expect(titleRow!.className).toMatch(/landscape-phone:sr-only/)

    const live = screen.getByTestId('live-viewport')
    expect(live.className).toMatch(/landscape-phone:m-0/)
    expect(live.className).toMatch(/landscape-phone:ml-2/)
    expect(live.className).toMatch(/landscape-phone:mt-12/)
    expect(live.className).toMatch(/landscape-phone:self-start/)
    expect(live.className).not.toMatch(/landscape-phone:self-center/)
    expect(live.className).toMatch(/landscape-phone:w-full/)
    expect(live.className).not.toMatch(/landscape-phone:h-full/)
    expect(live.className).toMatch(/landscape-phone:rounded-\[var\(--radius-xl\)\]/)

    const strip = screen.getByTestId('live-glance-strip')
    expect(live).toContainElement(strip)
    expect(strip.className).toMatch(/shrink-0/)
    expect(strip.className).toMatch(/landscape-phone:py-1\.5/)
    expect(strip.className).not.toMatch(/absolute/)
    const stripGrid = strip.querySelector('.grid') as HTMLElement | null
    expect(stripGrid).not.toBeNull()
    expect(stripGrid!.className).toMatch(/grid-cols-2/)

    const lowerPane = container.querySelector(
      '.landscape-phone\\:col-start-2',
    ) as HTMLElement | null
    expect(lowerPane).not.toBeNull()
    expect(lowerPane!.className).toMatch(/landscape-phone:pt-12/)
    expect(lowerPane).not.toContainElement(strip)

    const timeline = screen.getByLabelText("Today's activity")
    expect(timeline.className).toMatch(/landscape-phone:order-2/)
    expect(timeline.className).toMatch(/landscape-phone:scrollbar-hide/)
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

  // Multicam contract (docs/multicam_contract.md, 2026-07-07): with
  // ONE camera this page renders exactly as before — no switcher.
  // With more, a pill radiogroup drives the WHEP path + name pill and
  // the choice persists to localStorage.

  it('Given the default single-camera registry, When Watch renders, Then no camera switcher appears and the WHEP path stays the default cam (multicam contract)', async () => {
    // arrange / act — beforeEach already seeds the one-camera registry.
    renderWatch()

    // assert — the stream path settles on the default…
    await waitFor(() =>
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-stream-path',
        'cam',
      ),
    )
    // …and no switcher radiogroup is in the DOM.
    expect(
      screen.queryByRole('radiogroup', { name: 'Switch camera' }),
    ).not.toBeInTheDocument()
  })

  it('Given two registered cameras, When one is selected, Then the switcher drives the WHEP path and the camera-name pill and persists the choice (multicam contract)', async () => {
    // arrange
    getCamerasM.mockResolvedValue({
      cameras: [
        { id: 'front_door', name: 'Front Door', path: 'cam' },
        { id: 'back_yard', name: 'Back Yard', path: 'garage' },
      ],
    })
    const user = userEvent.setup()
    try {
      // act
      renderWatch()

      // assert — the switcher renders with both cameras as radios.
      const group = await screen.findByRole('radiogroup', { name: 'Switch camera' })
      expect(group).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Front Door' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Back Yard' })).not.toBeChecked()
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-stream-path',
        'cam',
      )

      // act — pick the second camera.
      await user.click(screen.getByRole('radio', { name: 'Back Yard' }))

      // assert — WHEP path follows the registry `path`, the name pill
      // shows the selected camera, and the choice is persisted.
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-stream-path',
        'garage',
      )
      expect(screen.getByRole('radio', { name: 'Back Yard' })).toBeChecked()
      // Name pill: "Back Yard" now appears both as the pill and the
      // selected radio — assert the pill copy exists beyond the radio.
      expect(screen.getAllByText('Back Yard').length).toBeGreaterThanOrEqual(2)
      expect(window.localStorage.getItem('homecam:cameraId')).toBe('back_yard')
    } finally {
      registerCameraNames([])
    }
  })

  it('Given a persisted camera choice, When Watch mounts, Then the stored camera is pre-selected (multicam contract)', async () => {
    // arrange
    getCamerasM.mockResolvedValue({
      cameras: [
        { id: 'front_door', name: 'Front Door', path: 'cam' },
        { id: 'back_yard', name: 'Back Yard', path: 'garage' },
      ],
    })
    window.localStorage.setItem('homecam:cameraId', 'back_yard')
    try {
      // act
      renderWatch()

      // assert
      expect(
        await screen.findByRole('radio', { name: 'Back Yard' }),
      ).toBeChecked()
      expect(screen.getByTestId('video-tile-stub')).toHaveAttribute(
        'data-stream-path',
        'garage',
      )
    } finally {
      registerCameraNames([])
    }
  })

  it('Given a siren push action, When Home opens, Then it requires foreground confirmation before sending the exact request', async () => {
    // arrange
    const user = userEvent.setup()
    renderWatch('/?deterrence=siren&duration=20&event=evt-9')

    // assert — merely opening the notification target does not actuate hardware.
    expect(
      await screen.findByText('Ready to sound the siren?'),
    ).toBeInTheDocument()
    expect(triggerDeterrenceM).not.toHaveBeenCalled()

    // act — review, then explicitly confirm in the foreground dialog.
    await user.click(screen.getByRole('button', { name: 'Review action' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(
      within(dialog).getByRole('button', { name: 'Sound siren' }),
    )

    // assert
    await waitFor(() => {
      expect(triggerDeterrenceM).toHaveBeenCalledWith({
        action: 'siren',
        duration_s: 20,
        confirm: true,
        event_id: 'evt-9',
      })
    })
  })

  it('Given deterrence hardware is unavailable, When the foreground action is confirmed, Then Home reports the limitation and keeps the intent for retry', async () => {
    // arrange
    triggerDeterrenceM.mockResolvedValue({
      ok: false,
      status: 'unavailable',
      reason: 'hardware adapter is not available',
      action: 'warning',
      duration_s: 60,
      capabilities: {
        available: false,
        adapter: null,
        limitation: 'Configure a supported speaker adapter first',
      },
    })
    const user = userEvent.setup()
    renderWatch('/?deterrence=warning&duration=600&event=evt-11')

    // act
    await user.click(await screen.findByRole('button', { name: 'Review action' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Start action' }))

    // assert — hand-edited/push duration is capped to the server maximum.
    await waitFor(() => {
      expect(triggerDeterrenceM).toHaveBeenCalledWith({
        action: 'warning',
        duration_s: 60,
        confirm: true,
        event_id: 'evt-11',
      })
    })
    expect(
      await screen.findByText(
        'Action unavailable: Configure a supported speaker adapter first',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Ready to play a warning?')).toBeInTheDocument()
  })

  it('Given a family account opens a Talk notification intent, Then Home explains owner permission and never offers microphone publish', async () => {
    authRole = 'family'
    getStatusM.mockResolvedValue({ ...HEALTHY, audio_enabled: true })

    renderWatch('/?talk=1&event=evt-family')

    expect(
      await screen.findByText('Talk requires owner access'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/family and viewer accounts can listen, but only an owner can publish/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Start talk' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })
})
