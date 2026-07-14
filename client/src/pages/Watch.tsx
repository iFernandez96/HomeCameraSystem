import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ClipModal } from '../components/ClipModal'
import { CatEmptyState } from '../components/CatEmptyState'
import { EventRow } from '../components/EventRow'
import { SnapshotPreview } from '../components/SnapshotPreview'
import { ErrorState } from '../components/states/ErrorState'
import { PackageStatusCard } from '../components/PackageStatusCard'
import { VideoTile } from '../components/VideoTile'
import { BrandMarkRow } from '../components/WhoMark'
import { captureSnapshot, getCameras, searchEvents, setDetectionEnabled, triggerDeterrence, HttpError, type Camera } from '../lib/api'
import { nextRovingIndex } from '../lib/a11y'
import { clockTime, recognizedNames, registerCameraNames, relativeTime } from '../lib/eventLabel'
import { DEFAULT_CAMERA_PATH } from '../lib/streamQuality'
import { identityOf, type IdentityKind } from '../lib/identity'
import { useRipple } from '../lib/ripple'
import { sentryCatName, useSentryCat } from '../lib/sentryCat'
import {
  ZOOM_IDENTITY,
  isZoomed,
  panUpdate,
  pinchUpdate,
  toTransform,
  type ZoomState,
} from '../lib/pinchZoom'
import { useToast } from '../lib/toast'
import { useConfirm } from '../lib/confirm'
import { useAuth } from '../lib/auth'
import { isOwner } from '../lib/roles'
import { useTicker } from '../lib/useTicker'
import {
  startListenSession,
  startTalkSession,
  type ListenSession,
  type TalkSession,
} from '../lib/twoWayAudio'
import type { DetectionEvent } from '../lib/types'
import { useStatus } from '../lib/useStatus'
import { powerDisplay } from '../lib/power'
import {
  WATCH_STATE_LABEL,
  watchStateDotClass,
  watchStateOf,
} from '../lib/watchState'

/**
 * Fuzz F4 (real device SM-S928U1, 2026-07-07): landscape fullscreen
 * left ~45% of the width as dead black bars because `object-contain`
 * letterboxes a 16:9 stream inside a landscape phone's much wider
 * (~19.5:9+) viewport. Portrait fullscreen deliberately keeps
 * `contain` (full-bleed mode note above) so the scene's edges are
 * never cropped — but on an already-wide landscape screen the crop a
 * `cover` fit introduces is minor (top/bottom sliver) and buys back
 * the wasted width, which reads far better for an immersive live
 * view. Tracks `matchMedia('(orientation: landscape)')` so the fit
 * mode follows physical rotation, not just the full/docked toggle.
 */
function useIsLandscape(): boolean {
  const [landscape, setLandscape] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(orientation: landscape)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(orientation: landscape)')
    const onChange = () => setLandscape(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return landscape
}

/**
 * Watch — the app's home screen ("Home" in the Playroom Modern
 * redesign, structural overhaul 2026-07-02, restyled 2026-07-07).
 *
 * Modeled on the two patterns the market converged on (user-approved
 * mockups):
 *   - Google Home / Nest camera detail: live video pinned in the top
 *     ~40% of the screen, TODAY'S STORY as a scrollable timeline
 *     below (events + quiet gaps), plain-language glance cards.
 *   - Ring Live View: tapping the video expands to a FULL-BLEED
 *     immersive mode — floating status, thumb-rail actions, an
 *     hour scrubber with event markers, swipe/back to close.
 *
 * The expand is a CSS state on the SAME container (docked ↔ fixed
 * inset-0) so the WebRTC <video> never remounts — no reconnect
 * hiccup when entering/leaving full screen. Task 5 (Playroom Modern)
 * restyled the chrome AROUND that container (rounded card treatment,
 * floating pill overlays) — the container identity and toggle logic
 * are untouched.
 *
 * The WatchRibbon is hidden on this route below lg (App.tsx): the
 * on-video scrim carries the armed state there, and a second status
 * bar would say the same thing twice. At lg and wider the shell may
 * render the ribbon even in a short landscape viewport.
 */

const _DEFAULT_CAMERA_LABEL = 'Front Door'

// Multicam contract (docs/multicam_contract.md, 2026-07-07): the
// selected camera id persists across reloads so the user's chosen
// view survives PWA tab re-mounts. Same localStorage idiom as
// homecam:streamQuality.
const _CAMERA_STORAGE_KEY = 'homecam:cameraId'

function readStoredCameraId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(_CAMERA_STORAGE_KEY)
  } catch {
    // localStorage can throw in private/lockdown modes.
    return null
  }
}

/**
 * Fetch the camera registry once on mount (inline fetch + cancelled
 * flag — the React 19 set-state-in-effect discipline). Returns the
 * list (null until it arrives / on failure — both render the
 * single-camera layout, which is also the graceful-degrade path when
 * the route is unreachable) plus the selection. Registry display
 * names are registered with eventLabel so event rows and the
 * ClipModal header say the camera's name — ONLY when more than one
 * camera exists (registerCameraNames self-gates).
 */
function useCameras() {
  const [cameras, setCameras] = useState<Camera[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readStoredCameraId(),
  )

  useEffect(() => {
    let cancelled = false
    getCameras()
      .then((r) => {
        if (cancelled) return
        registerCameraNames(r.cameras)
        setCameras(r.cameras)
      })
      .catch((e) => {
        // Single-camera fallback keeps the page fully functional
        // (default `cam` path + status-provided label) — log WHY so a
        // registry outage on a real multi-cam deploy is explainable.
        console.error('watch:cameras-load-failed', e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectCamera = useCallback((id: string) => {
    setSelectedId(id)
    try {
      window.localStorage.setItem(_CAMERA_STORAGE_KEY, id)
    } catch {
      // Best-effort — the choice just won't survive reload.
    }
  }, [])

  // A stored id that no longer exists in the registry (camera
  // removed / renamed) falls back to the first camera.
  const selectedCamera =
    cameras?.find((c) => c.id === selectedId) ?? cameras?.[0] ?? null

  return { cameras, selectedCamera, selectCamera }
}

function localMidnightTs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
}

/** Today's events, shared by the glance row (counts) and the story
 * list below it — lifted out of the timeline component so both can
 * read the same fetch. Visibility-aware refetch mirrors the Events
 * page pattern (CLAUDE.md load-bearing listener). */
function useTodayEvents() {
  const [events, setEvents] = useState<DetectionEvent[] | null>(null)
  const [quietSince, setQuietSince] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [refetchKey, setRefetchKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    searchEvents({ since_ts: localMidnightTs(), limit: 50 })
      .then((r) => {
        if (cancelled) return
        setEvents(r.items)
        // "Quiet since" is stamped at fetch time (not render time —
        // react-hooks/purity bans Date.now() in memos): if the latest
        // event is over an hour old, the timeline leads with a calm
        // dashed row instead of implying something just happened.
        const latest = r.items[0]?.ts
        setQuietSince(
          latest != null && Date.now() / 1000 - latest > 3600
            ? clockTime(latest)
            : null,
        )
        setError(false)
      })
      .catch((e) => {
        if (cancelled) return
        console.error(e)
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [refetchKey])

  const hasActiveVideo = events?.some(
    (event) => event.video_status === 'recording' || event.video_status === 'finalizing',
  ) === true
  useEffect(() => {
    if (!hasActiveVideo || document.visibilityState !== 'visible') return
    const id = window.setInterval(() => setRefetchKey((key) => key + 1), 2000)
    return () => window.clearInterval(id)
  }, [hasActiveVideo])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setRefetchKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Overhaul W1 item 7: stable identity (useCallback) so the memoized
  // TodayTimeline's props don't churn on every 5 s status-poll render.
  const refetch = useCallback(() => setRefetchKey((k) => k + 1), [])

  return { events, quietSince, error, refetch }
}

export function Watch() {
  const status = useStatus()
  const sentryCat = useSentryCat()
  const { showToast } = useToast()
  const { user } = useAuth()
  const canTalk = isOwner(user)
  const canManageDetection = user != null
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [actionParams, setActionParams] = useSearchParams()
  const ripple = useRipple()
  const isLandscape = useIsLandscape()
  const nowMs = useTicker(1000)
  const { events, quietSince, error, refetch: refetchTodayEvents } = useTodayEvents()
  const { cameras, selectedCamera, selectCamera } = useCameras()
  // Multicam contract: the switcher + per-event camera labels only
  // exist when a second camera is configured. With one camera this
  // page renders EXACTLY as before (the acceptance bar).
  const multiCam = (cameras?.length ?? 0) > 1
  const streamPath = selectedCamera?.path ?? DEFAULT_CAMERA_PATH

  const [full, setFull] = useState(false)
  const [dockedControlsTarget, setDockedControlsTarget] = useState<HTMLElement | null>(null)
  const [dockedChromeVisible, setDockedChromeVisible] = useState(true)
  const [detectionToggleBusy, setDetectionToggleBusy] = useState(false)
  // Fullscreen chrome auto-hide (fullscreen contract item 4): controls
  // fade out ~3.5 s after the last interaction so fullscreen is for
  // WATCHING; any tap brings them back. All state changes happen in
  // event handlers / the timer callback (never synchronously in an
  // effect — react-hooks/set-state-in-effect).
  const [chromeVisible, setChromeVisible] = useState(true)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pokeChrome = useCallback(() => {
    setChromeVisible(true)
    if (chromeTimerRef.current !== null) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => {
      chromeTimerRef.current = null
      setChromeVisible(false)
    }, 3500)
  }, [])
  const cancelChromeTimer = useCallback(() => {
    if (chromeTimerRef.current !== null) {
      clearTimeout(chromeTimerRef.current)
      chromeTimerRef.current = null
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [talkStarting, setTalkStarting] = useState(false)
  const [talkActive, setTalkActive] = useState(false)
  const talkSessionRef = useRef<TalkSession | null>(null)
  const [listenStarting, setListenStarting] = useState(false)
  const [listenActive, setListenActive] = useState(false)
  const listenSessionRef = useRef<ListenSession | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [openEvent, setOpenEvent] = useState<DetectionEvent | null>(null)
  // Status-truth fix (server-restart contradiction, 2026-07-07): a
  // user saw "camera is down" while the live WebRTC feed was visibly
  // streaming — /api/status was briefly unreachable during a server
  // restart, and this page treated status-null the same as
  // status-confirmed-dead. `videoPlaying` is a THIRD, independent
  // truth channel (MediaMTX/WebRTC is a separate process from the
  // status API) so we can tell "the API doesn't know" apart from "the
  // camera is actually down". Tri-state on purpose: `null` = the
  // video tile hasn't confirmed either way yet (still connecting) —
  // NOT treated as a negative, so cold mount doesn't flash danger
  // before the first WHEP handshake resolves.
  const [videoPlaying, setVideoPlaying] = useState<boolean | null>(null)
  // Overhaul W1 item 9 (frank I1, the Wife Test): a silently-revoked
  // notification permission was only discoverable inside Settings →
  // Alerts — a missed alert means a missed visitor. Surface a passive
  // chip on Home when the browser reports 'denied'. Read once at
  // mount (permission changes mid-session are rare and Settings
  // re-checks on its own); lazy initializer keeps this out of effects.
  const [alertsBlocked] = useState(
    () =>
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'denied',
  )

  const detectionActive = status?.detection_active ?? null
  const audioEnabled = status?.audio_enabled === true
  const talkIntent = actionParams.get('talk') === '1'
  const deterrenceRaw = actionParams.get('deterrence')
  const deterrenceAction =
    deterrenceRaw === 'light' || deterrenceRaw === 'warning' || deterrenceRaw === 'siren'
      ? deterrenceRaw
      : null
  const deterrenceDuration = Math.max(1, Math.min(60, Number(actionParams.get('duration')) || 15))
  const intentEventId = actionParams.get('event') ?? undefined
  const workerAlive = status?.worker_alive ?? null
  const streamStaleSeconds = status?.seconds_since_last_frame ?? null
  const lowMemory = status?.worker_metrics?.gear === 'low-memory'
  const thermal = status?.worker_metrics?.gear === 'thermal-throttled'
  // Multicam: the registry name for the SELECTED camera wins when
  // more than one camera exists; single-camera keeps the iter-313
  // status-inlined label byte-for-byte.
  const cameraLabel = multiCam
    ? selectedCamera?.name ?? _DEFAULT_CAMERA_LABEL
    : status?.camera_label ?? _DEFAULT_CAMERA_LABEL

  const toggleTalk = async () => {
    if (talkStarting) return
    if (talkSessionRef.current) {
      talkSessionRef.current.close()
      talkSessionRef.current = null
      setTalkActive(false)
      showToast('Talk ended', 'info')
      return
    }
    setTalkStarting(true)
    try {
      const session = await startTalkSession(undefined, () => {
        talkSessionRef.current = null
        setTalkActive(false)
        showToast('Talk connection ended', 'error')
      })
      talkSessionRef.current = session
      setTalkActive(true)
      showToast('Microphone is live at the camera', 'success')
    } catch {
      showToast('Could not start talk — check microphone and speaker setup', 'error')
    } finally {
      setTalkStarting(false)
    }
  }

  const toggleListen = async () => {
    if (listenStarting) return
    if (listenSessionRef.current) {
      listenSessionRef.current.close()
      listenSessionRef.current = null
      setListenActive(false)
      return
    }
    setListenStarting(true)
    try {
      listenSessionRef.current = await startListenSession(undefined, () => {
        listenSessionRef.current = null
        setListenActive(false)
        showToast('Listen connection ended', 'error')
      })
      setListenActive(true)
    } catch {
      showToast('Could not listen — check camera microphone setup', 'error')
    } finally {
      setListenStarting(false)
    }
  }

  const clearActionIntent = () => {
    const next = new URLSearchParams(actionParams)
    for (const key of ['talk', 'deterrence', 'duration', 'event']) next.delete(key)
    setActionParams(next, { replace: true })
  }

  const confirmDeterrence = async () => {
    if (!deterrenceAction) return
    const label = deterrenceAction === 'light' ? 'turn on the light' : deterrenceAction === 'warning' ? 'play the warning' : 'sound the siren'
    const ok = await confirm({
      title: `${label.charAt(0).toUpperCase()}${label.slice(1)}?`,
      body: `This will ${label} at the camera for ${deterrenceDuration} seconds.`,
      confirmLabel: deterrenceAction === 'siren' ? 'Sound siren' : 'Start action',
      destructive: deterrenceAction === 'siren',
    })
    if (!ok) return
    try {
      const result = await triggerDeterrence({
        action: deterrenceAction,
        duration_s: deterrenceDuration,
        confirm: true,
        ...(intentEventId ? { event_id: intentEventId } : {}),
      })
      if (!result.ok) {
        const detail =
          result.status === 'unavailable'
            ? result.capabilities.limitation || result.reason
            : result.reason
        showToast(
          `${result.status === 'unavailable' ? 'Action unavailable' : 'Action blocked'}: ${detail}`,
          'error',
        )
        return
      }
      showToast('Deterrence action started', 'success')
      clearActionIntent()
    } catch {
      showToast('Could not start deterrence action', 'error')
    }
  }

  useEffect(() => () => {
    talkSessionRef.current?.close()
    talkSessionRef.current = null
    listenSessionRef.current?.close()
    listenSessionRef.current = null
  }, [])

  useEffect(() => {
    if (audioEnabled) return
    talkSessionRef.current?.close()
    talkSessionRef.current = null
    listenSessionRef.current?.close()
    listenSessionRef.current = null
    Promise.resolve().then(() => {
      setTalkActive(false)
      setListenActive(false)
      setTalkStarting(false)
      setListenStarting(false)
    })
  }, [audioEnabled])

  // Overhaul W1 item 2 (one state vocabulary): the three-state truth
  // model (status-confirmed down / status unknown with video-truth
  // tiebreak / healthy) moved to lib/watchState.ts::watchStateOf so
  // this page, the WatchRibbon, and the glance card all say the SAME
  // word for the same state ("On watch" / "Off duty" / "Camera
  // offline"). VideoTile's own pill deliberately keeps its separate
  // stream-truth vocabulary ("Live"/"Connecting"/"Offline").
  const statusConfirmedDown = status != null && status.worker_alive === false
  const stateKind = watchStateOf({
    statusKnown: status != null,
    workerAlive,
    detectionActive,
    videoPlaying,
  })
  const dangerDown = stateKind === 'offline'
  const reconnecting = stateKind === 'reconnecting'
  const armed = stateKind === 'armed'
  const unhealthy = dangerDown || lowMemory || thermal
  const stateLabel = WATCH_STATE_LABEL[stateKind]
  const dotClass = watchStateDotClass(stateKind)
  // Fuzz F3/F13: the old `ageLabel` ("Live now" / "Ns ago") text chip
  // was dropped from the on-video chrome — it duplicated both this
  // tile's own connection-status pill and, in fullscreen, the
  // scrubber's LIVE pill.

  // Glance row copy — Step 3 of the Home redesign. The state card
  // swaps to the full-contrast danger treatment when the camera is
  // offline or the worker has degraded to a low-memory/thermal gear
  // (whimsy never masks danger — CLAUDE.md). Overhaul W1 item 2: the
  // headline is now the shared ribbon vocabulary (stateLabel above),
  // not a page-local synonym set ("Watching"/"Paused").
  const watching = armed
  const watchingDetail = dangerDown
    ? statusConfirmedDown
      ? 'Check its power, then see Settings.'
      : "Can't reach the camera. Check its connection."
    : reconnecting
      ? 'Status reconnecting'
      : lowMemory
        ? 'Paused: the system is low on memory.'
        : thermal
          ? 'Slowed down: the camera is running warm.'
          : watching
            ? `${sentryCatName(sentryCat)} is watching`
            : detectionActive === false
              ? 'Turn alerts on in Settings.'
              : 'Checking camera status'

  const toggleDetectionFromWatchPanel = async () => {
    if (!canManageDetection || detectionToggleBusy || detectionActive == null) return
    const enabled = !detectionActive
    if (!enabled) {
      const ok = await confirm({
        title: 'Pause detection and classification?',
        body: 'Live video and continuous recording will stay on. New detections, classifications, and alerts will stop until you resume them.',
        confirmLabel: 'Pause detection',
        destructive: true,
      })
      if (!ok) return
    }
    setDetectionToggleBusy(true)
    try {
      await setDetectionEnabled(enabled)
      showToast(
        enabled
          ? `${sentryCatName(sentryCat)} is back on watch`
          : 'Detection and classification paused',
        'success',
      )
    } catch {
      showToast('Could not change detection — try again', 'error')
    } finally {
      setDetectionToggleBusy(false)
    }
  }
  // Fullscreen contract (2026-07-07, user session): entering pushes a
  // history entry so the Android back gesture exits FULLSCREEN, not
  // the app — the number-one "acts like a real camera app"
  // expectation. All exits funnel through history.back() so the
  // pushed entry is always consumed exactly once:
  //   back gesture → popstate → setFull(false)
  //   chevron / Esc / swipe-down → history.back() → popstate → same
  // A reload while fullscreen loses React state but leaves the pushed
  // entry; the first back press then just consumes it (harmless
  // no-op) — the standard cost of the pattern, same as every SPA
  // modal that plays this trick.
  const viewportRef = useRef<HTMLDivElement | null>(null)
  // Pinch-zoom state (fullscreen contract item 7) — declared before
  // the fullscreen effects because the popstate exit path resets it.
  const zoomLayerRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef<ZoomState>(ZOOM_IDENTITY)
  const applyZoom = () => {
    const el = zoomLayerRef.current
    if (el) el.style.transform = toTransform(zoomRef.current)
  }
  const resetZoom = useCallback(() => {
    zoomRef.current = ZOOM_IDENTITY
    const el = zoomLayerRef.current
    if (el) el.style.transform = ''
  }, [])
  const enterFull = () => {
    window.history.pushState({ homecamFull: true }, '')
    setFull(true)
    pokeChrome()
    // TRUE fullscreen (2026-07-07 fullscreen contract, items 1+3):
    // hide the browser toolbar + system bars, then rotate to landscape
    // — the stream is 16:9, so fullscreen means landscape, matching
    // Ring/Nest muscle memory. Must be called HERE (inside the tap's
    // transient activation), not from an effect. Both calls are
    // best-effort: iOS Safari has neither Element.requestFullscreen
    // nor orientation.lock, and the CSS overlay stays the functional
    // fallback there.
    const el = viewportRef.current as
      | (HTMLDivElement & {
          requestFullscreen?: (o?: { navigationUI?: string }) => Promise<void>
        })
      | null
    el?.requestFullscreen?.({ navigationUI: 'hide' })
      .then(() => {
        const so = screen.orientation as
          | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
          | undefined
        so?.lock?.('landscape').catch(() => {
          // Expected on desktop and iOS; the video still renders in
          // whatever orientation the user holds.
        })
      })
      .catch(() => {
        // No Fullscreen API (iOS Safari) or the browser denied it —
        // the fixed-inset CSS overlay is already showing.
      })
  }
  const exitFull = useCallback(() => {
    // Guard: only walk history if OUR entry is on top, so a stray
    // double-call can't navigate the user away from the page.
    if (window.history.state?.homecamFull) window.history.back()
    else setFull(false)
  }, [])
  useEffect(() => {
    if (!full) return
    const onPop = () => {
      setFull(false)
      // Docked mode has no auto-hide — restore the chrome, and drop
      // any pinch-zoom so the docked tile renders untransformed.
      cancelChromeTimer()
      setChromeVisible(true)
      resetZoom()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [full, cancelChromeTimer, resetZoom])

  // Keep React state honest when the BROWSER ends real fullscreen on
  // its own (system back inside true fullscreen, the OS "exit
  // fullscreen" affordance, an app switch): fullscreenchange with no
  // fullscreenElement → funnel through exitFull so the history marker
  // is consumed too. Cleanup releases the orientation lock and real
  // fullscreen for the programmatic exits (popstate flipped `full`
  // first, so the element is still fullscreen here).
  useEffect(() => {
    if (!full) return
    const onFsChange = () => {
      if (!document.fullscreenElement) exitFull()
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      const so = screen.orientation as
        | (ScreenOrientation & { unlock?: () => void })
        | undefined
      so?.unlock?.()
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
          // Already out (e.g. the browser exited first) — nothing to do.
        })
      }
    }
  }, [full, exitFull])

  // Screen wake lock while fullscreen (fullscreen contract item 6): a
  // live view session must not dim/sleep mid-watch. Re-acquired on
  // visibility resume (the OS silently releases it when the tab
  // hides). Best-effort — browsers without navigator.wakeLock just
  // keep their normal screen timeout.
  useEffect(() => {
    if (!full) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = () => {
      navigator.wakeLock
        ?.request('screen')
        .then((l) => {
          if (cancelled) l.release().catch(() => {})
          else lock = l
        })
        .catch(() => {
          // Low battery / permissions / unsupported — fine, no lock.
        })
    }
    acquire()
    const onVis = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      lock?.release().catch(() => {})
      // Also stop any pending chrome-hide timer when leaving full.
      cancelChromeTimer()
    }
  }, [full, cancelChromeTimer])

  // ESC exits full screen; body scroll locks while full so the page
  // behind can't scroll on overscroll.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitFull()
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [full, exitFull])

  // Chrome auto-hide + swipe-down-dismiss input handling (fullscreen
  // contract items 4 + 9). Tap on the video toggles the chrome; a tap
  // that lands on a control just re-arms the hide timer. The swipe
  // tracker mutates the viewport's transform directly (no per-move
  // React render — the CatLayer rule) and only ever acts on a single
  // touch whose axis locked vertical-downward, so scrubber taps and
  // horizontal motion are untouched.
  const chromeHidden = full && !chromeVisible
  // Fade helper: visibility flips AFTER the opacity fade when hiding
  // (the 300 ms delay) so the fade-out is actually seen, and flips
  // back instantly when showing. `visibility: hidden` also defeats the
  // children's own `pointer-events-auto`, so hidden chrome can't eat
  // taps meant for the video.
  const chromeFade = (hidden: boolean): React.CSSProperties =>
    hidden
      ? {
          opacity: 0,
          visibility: 'hidden',
          transition: 'opacity 300ms ease, visibility 0ms linear 300ms',
        }
      : { opacity: 1, visibility: 'visible', transition: 'opacity 300ms ease' }
  // Mouse click toggles chrome (touch taps are handled in touchend so
  // pans/pinches never count as taps).
  const toggleChrome = useCallback(() => {
    if (chromeVisible) {
      cancelChromeTimer()
      setChromeVisible(false)
    } else {
      pokeChrome()
    }
  }, [chromeVisible, cancelChromeTimer, pokeChrome])
  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (!full || e.pointerType !== 'mouse') return
    const t = e.target as HTMLElement
    if (t.closest('button')) {
      pokeChrome()
      return
    }
    toggleChrome()
  }

  // Touch gesture arbiter (fullscreen only): 2 fingers = pinch zoom,
  // 1 finger while zoomed = pan, 1 finger at scale 1 = swipe-down to
  // dismiss, 1 finger that never moved = tap (chrome toggle). Zoom /
  // swipe write transforms straight to the DOM refs — no per-move
  // React render (CatLayer rule).
  const gestureRef = useRef<{
    mode: 'tap' | 'swipe' | 'pan' | 'pinch' | 'dead'
    x0: number
    y0: number
    lastX: number
    lastY: number
    dy: number
    pinchDist: number
    onButton: boolean
  } | null>(null)
  const clearSwipeTransform = () => {
    const el = viewportRef.current
    if (!el) return
    el.style.transform = ''
    el.style.transition = ''
  }
  const viewportSize = () => {
    const r = viewportRef.current?.getBoundingClientRect()
    return { vw: r?.width ?? window.innerWidth, vh: r?.height ?? window.innerHeight }
  }
  const pinchDistance = (e: React.TouchEvent) => {
    const a = e.touches[0]
    const b = e.touches[1]
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }
  const onViewportTouchStart = (e: React.TouchEvent) => {
    if (!full) {
      gestureRef.current = null
      return
    }
    if (e.touches.length >= 2) {
      gestureRef.current = {
        mode: 'pinch',
        x0: 0,
        y0: 0,
        lastX: 0,
        lastY: 0,
        dy: 0,
        pinchDist: pinchDistance(e),
        onButton: false,
      }
      clearSwipeTransform()
      return
    }
    const t = e.touches[0]
    gestureRef.current = {
      mode: 'tap',
      x0: t.clientX,
      y0: t.clientY,
      lastX: t.clientX,
      lastY: t.clientY,
      dy: 0,
      pinchDist: 0,
      onButton: Boolean((e.target as HTMLElement).closest('button')),
    }
  }
  const onViewportTouchMove = (e: React.TouchEvent) => {
    const g = gestureRef.current
    if (!g || !full) return
    if (e.touches.length >= 2) {
      // Upgrade any single-finger gesture to a pinch the moment the
      // second finger lands.
      if (g.mode !== 'pinch') {
        g.mode = 'pinch'
        g.pinchDist = pinchDistance(e)
        clearSwipeTransform()
        return
      }
      const d = pinchDistance(e)
      if (g.pinchDist > 0 && d > 0) {
        const rect = viewportRef.current?.getBoundingClientRect()
        const left = rect?.left ?? 0
        const top = rect?.top ?? 0
        const { vw, vh } = viewportSize()
        const fx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - left
        const fy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - top
        zoomRef.current = pinchUpdate(zoomRef.current, fx, fy, d / g.pinchDist, vw, vh)
        applyZoom()
      }
      g.pinchDist = d
      return
    }
    const t = e.touches[0]
    const dxTotal = t.clientX - g.x0
    const dyTotal = t.clientY - g.y0
    if (g.mode === 'tap' && (Math.abs(dxTotal) > 12 || Math.abs(dyTotal) > 12)) {
      if (isZoomed(zoomRef.current)) g.mode = 'pan'
      else if (Math.abs(dyTotal) > Math.abs(dxTotal) && dyTotal > 0) g.mode = 'swipe'
      else g.mode = 'dead'
    }
    if (g.mode === 'pan') {
      const { vw, vh } = viewportSize()
      zoomRef.current = panUpdate(
        zoomRef.current,
        t.clientX - g.lastX,
        t.clientY - g.lastY,
        vw,
        vh,
      )
      applyZoom()
    } else if (g.mode === 'swipe') {
      g.dy = Math.max(0, dyTotal)
      const el = viewportRef.current
      if (el) {
        el.style.transition = 'none'
        el.style.transform = `translateY(${g.dy}px)`
      }
    }
    g.lastX = t.clientX
    g.lastY = t.clientY
  }
  const onViewportTouchEnd = (e: React.TouchEvent) => {
    const g = gestureRef.current
    if (!g || !full) {
      gestureRef.current = null
      return
    }
    if (e.touches.length > 0) {
      // Fingers remain (e.g. pinch → one finger lifted): rebase as a
      // fresh single-finger gesture so panning continues smoothly.
      const t = e.touches[0]
      gestureRef.current = {
        mode: isZoomed(zoomRef.current) ? 'pan' : 'dead',
        x0: t.clientX,
        y0: t.clientY,
        lastX: t.clientX,
        lastY: t.clientY,
        dy: 0,
        pinchDist: 0,
        onButton: false,
      }
      return
    }
    gestureRef.current = null
    if (g.mode === 'swipe') {
      if (g.dy > 110) {
        clearSwipeTransform()
        exitFull()
      } else {
        // Sub-threshold: EASE back home (final polish gate: ClipModal's
        // swipe eases 160ms while this snapped instantly — one gesture
        // grammar). Reduced motion keeps the instant snap.
        const el = viewportRef.current
        const reduce = window.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        )?.matches
        if (el && !reduce) {
          el.style.transition = 'transform 160ms ease'
          el.style.transform = ''
        } else {
          clearSwipeTransform()
        }
      }
    } else if (g.mode === 'tap' && !g.onButton) {
      toggleChrome()
    } else if (g.mode === 'tap' && g.onButton) {
      pokeChrome()
    }
  }

  const onSnapshot = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await captureSnapshot()
      setPreviewUrl(r.url)
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) {
        showToast('No recent frame yet — try again in a moment.', 'error')
      } else if (e instanceof HttpError && e.status === 401) {
        showToast('Sign in expired — refresh the page to continue.', 'error')
      } else {
        showToast(
          "Couldn't take the snapshot — check the camera is on, then try again.",
          'error',
        )
      }
      console.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    // Landscape pass (Task 1): a phone rotated sideways is short-wide
    // — real-device screenshots showed this whole page still stacking
    // portrait-style (video on top, glance cards + timeline below),
    // which left the video letterboxed to a thin strip and pushed the
    // timeline mostly off-screen. `landscape-phone:` reflows into a
    // TWO-PANE layout: video docks in the left ~58% column at full
    // available height, the header/glance/timeline share a right
    // column that scrolls independently. The `full` (fullscreen)
    // branch below is untouched — it's already a `fixed inset-0`
    // overlay that ignores this grid entirely, and the docked-vs-full
    // CSS-only toggle on the SAME container (so VideoTile never
    // remounts) is preserved.
    // Overhaul W1 item 1 (landscape-desktop Top/A1): Watch was the
    // only route with zero `lg:` treatment — on a desktop it rendered
    // the phone stack full-bleed. The `lg:` grid mirrors the proven
    // landscape-phone two-pane pattern: video left, glance + timeline
    // in a width-capped right rail that scrolls independently. The
    // left column's video keeps a TRUE 16:9 box at lg (max-w cap
    // below) instead of landscape-phone's full-height cover fit, so
    // `cover` never canyon-crops on a wide monitor.
    <div className="flex h-[calc(100dvh-var(--ribbon-h,0px))] flex-col overflow-hidden landscape-phone:grid landscape-phone:grid-cols-[minmax(0,1fr)_clamp(22rem,32vw,29rem)] landscape-phone:grid-rows-[auto_1fr] landscape-phone:gap-x-4 tablet-landscape:grid tablet-landscape:grid-cols-[minmax(0,1fr)_clamp(24rem,38vw,32rem)] tablet-landscape:grid-rows-[auto_1fr] tablet-landscape:gap-x-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:grid-rows-[auto_1fr] lg:w-full lg:max-w-[100rem] lg:mx-auto">
      {/* Audit seam fix: `landscape-phone` is height-only, so a
          short-but-wide lg window can render App.tsx's WatchRibbon
          while this grid is active. Subtract the shell-provided
          `--ribbon-h` instead of claiming the full 100dvh. If a
          ConnectionBanner is showing, `<main>`'s own
          `overflow-y-auto` is the fallback scroll (this grid's
          internal right-pane scroll degrades to page-level scroll in
          that edge case, which is acceptable). */}
      {/* ============ PAGE HEADER ============ */}
      <header className="px-4 pt-4 pb-1 landscape-phone:col-span-2 landscape-phone:row-start-1 landscape-phone:p-0 tablet-landscape:col-span-2 tablet-landscape:row-start-1 tablet-landscape:px-4 tablet-landscape:pt-3 tablet-landscape:pb-1 lg:col-span-2 lg:row-start-1 lg:px-6">
        <div className="flex items-center justify-between gap-3 landscape-phone:sr-only">
          <h1 className="page-title text-2xl text-[var(--color-text-primary)] landscape-phone:text-base">
            Home
          </h1>
          <BrandMarkRow size={28} />
        </div>
        {/* Multicam contract (2026-07-07): camera switcher — renders
            ONLY when a second camera is configured. Same pill/
            radiogroup grammar + roving tabindex as the Events chip
            rows; selection drives the WHEP path and the camera-name
            pill and persists to localStorage. Single-camera deploys
            never see this row. */}
        {multiCam && cameras && (
          <CameraSwitcher
            cameras={cameras}
            selectedId={selectedCamera?.id ?? null}
            onSelect={selectCamera}
          />
        )}
      </header>

      {/* ============ LIVE VIEWPORT (docked ↔ full-bleed) ============ */}
      <div
        ref={viewportRef}
        data-testid="live-viewport"
        onPointerDown={onViewportPointerDown}
        onTouchStart={onViewportTouchStart}
        onTouchMove={onViewportTouchMove}
        onTouchEnd={onViewportTouchEnd}
        onTouchCancel={onViewportTouchEnd}
        className={
          full
            ? // overflow-hidden: the pinch-zoomed video layer must clip
              // at the screen edge instead of painting over nothing.
              'fixed inset-0 z-[45] bg-black flex flex-col overflow-hidden'
            : // Docked: a TRUE 16:9 box (the stream's aspect) so the
              // video fills it exactly — no letterbox band, no crop.
              // max-h guards short-viewport landscape. Playroom tile
              // grammar: rounded card + shadow, matching Task 3's
              // other card surfaces.
              // landscape-phone: the docked tile becomes the LEFT
              // PANE at full pane height instead of a capped 16:9
              // strip — `aspect-auto`/`max-h-none`/`h-full` win over
              // the base `aspect-video`/`max-h-[48dvh]` (same
              // technique as the `lg:` overrides elsewhere in this
              // codebase — later media-scoped rule wins at equal
              // specificity).
              // NO w-full here: width:100% + mx-4 made the box 2rem
              // WIDER than the viewport (left gap visible, right edge
              // clipped past the screen — user-caught on device, and
              // the same overflow that let Firefox pan the page
              // sideways). A block div with side margins fills the
              // remaining width by itself.
              // lg (overhaul W1 item 1): left grid pane, still a TRUE
              // 16:9 box — `max-w-[85.33dvh]` is 48dvh × 16/9, so the
              // box can never outgrow its own max-h into a wider-than-
              // 16:9 shape (which is what made `cover` canyon-crop).
              // flex flex-col (2026-07-07 fullscreen contract): the
              // inner pane is flex-1 and the pinch-zoom layer inside it
              // is absolute — without a flex parent the pane's height
              // collapses to 0 in docked mode (user-caught: black tile,
              // no controls, on the landscape two-pane layout).
              'relative flex flex-col mx-4 mt-3 rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] bg-black overflow-hidden landscape-phone:col-start-1 landscape-phone:row-start-2 landscape-phone:w-full landscape-phone:max-h-[calc(100dvh-var(--ribbon-h,0px)-1rem)] landscape-phone:self-start landscape-phone:m-0 landscape-phone:ml-2 landscape-phone:mt-12 landscape-phone:rounded-[var(--radius-xl)] tablet-landscape:col-start-1 tablet-landscape:row-start-2 tablet-landscape:w-full tablet-landscape:max-h-[calc(100dvh-var(--ribbon-h,0px)-1.5rem)] tablet-landscape:self-start tablet-landscape:m-0 tablet-landscape:ml-3 tablet-landscape:mt-12 tablet-landscape:rounded-[var(--radius-xl)] lg:col-start-1 lg:row-start-2 lg:self-start lg:mx-6 lg:mt-3 lg:mb-6 lg:max-w-[85.33dvh]'
        }
      >
        <div
          data-testid="live-scene"
          onPointerUp={(event) => {
            if (full || (event.target as HTMLElement).closest('button')) return
            setDockedChromeVisible((visible) => !visible)
          }}
          className={
            full
              ? 'relative flex-1 min-h-0 overflow-hidden'
              : 'relative aspect-video min-h-0 overflow-hidden'
          }
        >
          {/* Pinch-zoom layer (fullscreen contract item 7): only the
              video scales/pans; the pills, rail and scrubber are
              siblings and stay put. Transform written imperatively by
              the touch arbiter above — identity in docked mode. */}
          <div ref={zoomLayerRef} className="absolute inset-0 will-change-transform">
          <VideoTile
            // Multicam contract: the selected camera's MediaMTX base
            // path. Defaults to 'cam' (single-camera registry
            // default), so with one camera the composed WHEP URL is
            // byte-identical to before.
            streamPath={streamPath}
            detectionActive={detectionActive}
            workerAlive={workerAlive}
            lowMemory={lowMemory}
            thermal={thermal}
            streamStaleSeconds={streamStaleSeconds}
            // Fuzz F4: landscape fullscreen switches to `cover` so the
            // stream fills the wide viewport instead of leaving ~45%
            // dead black bars (see useIsLandscape comment above).
            // Portrait fullscreen and the docked tile are unaffected —
            // docked stays `cover` inside its true 16:9 box, and
            // portrait full-bleed keeps `contain` so the scene's
            // edges are never cropped (original full-bleed rationale).
            fit={full ? (isLandscape ? 'cover' : 'contain') : isLandscape ? 'contain' : 'cover'}
            // Fuzz F3/F7/F13: docked wants exactly ONE status pill —
            // this tile's own connection pill ("Live"/"Connecting"/
            // "Offline"). Fullscreen already has a combined armed +
            // camera cluster below plus the scrubber's LIVE pill, so
            // this tile's pill would be a third, redundant "Live"
            // label crowding the back chevron.
            showStatusPill={!full && dockedChromeVisible}
            // Status-truth fix: independent read on whether frames are
            // actually flowing, so the glance card can tell "the API
            // doesn't know" apart from "the camera is really down".
            onPlayingChange={setVideoPlaying}
            // Control-overlap fix (2026-07-07): Watch used to render its
            // own absolutely-positioned Snapshot + expand pair ON TOP of
            // VideoTile's own bbox-toggle + fullscreen buttons in the
            // same bottom-right corner — the two owners' circles/pills
            // half-buried each other. VideoTile is now the single owner
            // of that corner; Watch slots its docked-mode buttons in via
            // `actions` (only in docked mode — fullscreen mode has its
            // own separate thumb rail + scrubber chrome) and disables
            // VideoTile's own native-fullscreen button since Watch's
            // CSS docked↔full toggle is the one canonical "make it
            // bigger" affordance on this page (it preserves the WebRTC
            // element and carries the hour scrubber; the native
            // Fullscreen API button would be a second, competing one).
            showFullscreenButton={false}
            showQualityMenu
            showBoxToggle
            controlsTarget={full ? null : dockedControlsTarget}
            safeAreaBottom={full}
            // Fullscreen: the scrubber now OVERLAYS the bottom of the
            // full-bleed video, so the tile's own control row must sit
            // above it (scrubber ≈ 5.75rem + safe-area tall).
            controlsBottom={
              full ? 'calc(6.5rem + env(safe-area-inset-bottom))' : undefined
            }
            dimControls={chromeHidden}
            actions={
              full ? undefined : (
                <>
                  <button
                    type="button"
                    onClick={onSnapshot}
                    disabled={busy}
                    aria-label={busy ? 'Saving snapshot' : 'Snapshot'}
                    onPointerDown={busy ? undefined : ripple}
                    className="relative min-w-[6.5rem] overflow-hidden inline-flex items-center justify-center gap-2 h-11 rounded-xl bg-black/60 px-3 ring-1 ring-white/20 text-white disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
                  >
                    <SnapshotIcon />
                    <span className="text-sm font-semibold">Snapshot</span>
                  </button>
                </>
              )
            }
          />
          </div>

          {!full && dockedChromeVisible && (
            <button
              type="button"
              aria-label="Full screen live view"
              onClick={enterFull}
              onPointerDown={ripple}
              className="absolute bottom-3 right-3 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/20 backdrop-blur focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
            >
              <ExpandIcon />
            </button>
          )}

          {/* Floating pill overlays — the armed state lives ON the
              video here (the ribbon is hidden on this route on
              mobile). Safe-area padded for the notch.
              Fuzz F3/F9/F13 consolidation: docked shows ONLY the
              camera-name pill (the armed/offline state now belongs
              solely to the glance card below, and the connection
              state is VideoTile's own pill) — down from 4 chips
              stacked on one video. Fullscreen collapses the old
              3-piece cluster (state pill + camera pill + "Live now"
              age text) into ONE combined "{state} · {camera}" pill,
              since the scrubber's red LIVE pill already carries the
              live signal and a standalone "Live now" text was pure
              duplication (fuzz F3). */}
          <div
            className={`absolute top-0 left-0 right-0 flex items-center gap-2 px-4 pointer-events-none ${
              full ? '' : 'justify-end'
            }`}
            style={{
              paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
              ...chromeFade(chromeHidden),
            }}
          >
            {full && (
              <button
                type="button"
                aria-label="Exit full screen"
                onClick={exitFull}
                onPointerDown={ripple}
                // Overhaul W1 item 4 (frank#1, hari REACH-2): w-9 was
                // the one sub-44px target in the app, on the button
                // users need most in fullscreen. Also rounded-full so
                // the over-video chrome shares one radius language.
                className="pointer-events-auto relative overflow-hidden mr-1 flex items-center justify-center w-11 h-11 rounded-full bg-black/45 ring-1 ring-white/15 text-white text-lg focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
              >
                ‹
              </button>
            )}
            {full ? (
              <span
                role="status"
                aria-live="polite"
                className="pointer-events-auto inline-flex items-center gap-2 bg-[var(--color-surface-scrim)] backdrop-blur rounded-full px-3 py-1.5 ring-1 ring-[var(--color-border)]"
              >
                <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {stateLabel} · {cameraLabel}
                </span>
              </span>
            ) : multiCam ? (
              <span className="pointer-events-auto max-w-[45%] bg-black/70 text-white text-xs font-semibold rounded-full px-3 py-1 truncate">
                {cameraLabel}
              </span>
            ) : null}
          </div>

          {/* Full-mode thumb rail. Fuzz F11: the "Talk · soon"
              placeholder button was dropped — two-way audio is
              out-of-scope hardware work (see CLAUDE.md "Out of
              scope"); it occupied prime fullscreen real estate for a
              feature with no ETA. Re-add here once audio_enabled
              ships. Fuzz F5: safe-area padding so Snapshot's label
              never sits under the status-bar/camera-cutout area in
              landscape (real-device SM-S928U1 clipped it). */}
          {full && (
            <div
              className="absolute right-3 bottom-40 flex flex-col gap-3"
              style={{
                paddingTop: 'max(0.5rem, env(safe-area-inset-top))',
                paddingRight: 'max(0.5rem, env(safe-area-inset-right))',
                ...chromeFade(chromeHidden),
              }}
            >
              <RailButton
                label={busy ? 'Saving…' : 'Snapshot'}
                onClick={onSnapshot}
                disabled={busy}
              >
                <SnapshotIcon />
              </RailButton>
              {audioEnabled ? (
                <>
                  <RailButton
                    label={listenStarting ? 'Starting…' : listenActive ? 'Mute' : 'Listen'}
                    onClick={() => void toggleListen()}
                    disabled={listenStarting}
                  >
                    <span aria-hidden>{listenActive ? '◉' : '◌'}</span>
                  </RailButton>
                  {canTalk ? (
                    <RailButton
                      label={talkStarting ? 'Starting…' : talkActive ? 'End talk' : 'Talk'}
                      onClick={() => void toggleTalk()}
                      disabled={talkStarting}
                    >
                      <span aria-hidden>{talkActive ? '■' : '●'}</span>
                    </RailButton>
                  ) : null}
                </>
              ) : null}
            </div>
          )}

        </div>

        {!full && (
          <div
            ref={setDockedControlsTarget}
            aria-label="Camera controls"
            className="flex min-h-16 items-center bg-black px-4 py-2"
          />
        )}

        {!full && (
          <LiveGlanceStrip
            unhealthy={unhealthy}
            stateLabel={stateLabel}
            watchingDetail={watchingDetail}
            sentryName={sentryCatName(sentryCat)}
            detectionActive={detectionActive}
            canManageDetection={canManageDetection}
            detectionToggleBusy={detectionToggleBusy}
            onToggleDetection={toggleDetectionFromWatchPanel}
            power={powerDisplay(status)}
          />
        )}

        {/* Full-mode bottom: hour scrubber with event markers.
            OVERLAY, not a flex sibling (user report 2026-07-07: "black
            bar at the bottom") — as a flex row it reserved a black
            strip the video never filled, visible even after the chrome
            faded. It already paints its own gradient scrim, so it sits
            ON the (now full-bleed) video like every other piece of
            fullscreen chrome and vanishes with the fade. */}
        {full && (
          <div
            className="absolute inset-x-0 bottom-0"
            style={chromeFade(chromeHidden)}
          >
          <HourScrubber
            onJumpHistory={() => {
              // Replace the fullscreen history marker with the events
              // route so back-from-Events lands on the ORIGINAL Watch
              // entry, not a stale marker that eats one back press.
              const replacing = Boolean(window.history.state?.homecamFull)
              setFull(false)
              navigate('/events', { replace: replacing })
            }}
          />
          </div>
        )}
      </div>

      {/* Glance cards + Today's Story share the lower/right pane, but
          the pane itself is height-bounded instead of scrollable.
          The "Today at home" section below owns vertical scroll, so
          the live tile and glance context stay anchored while the
          activity area behaves like a native sheet. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden landscape-phone:col-start-2 landscape-phone:row-start-2 landscape-phone:gap-2 landscape-phone:pr-2 landscape-phone:pl-1 landscape-phone:pt-12 tablet-landscape:col-start-2 tablet-landscape:row-start-2 tablet-landscape:gap-2 tablet-landscape:pr-3 tablet-landscape:pt-12 lg:col-start-2 lg:row-start-2 lg:pt-0 lg:pr-6">
        {talkIntent || deterrenceAction ? (
          <section aria-label="Notification action confirmation" className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-xl)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3 md:mx-auto md:w-full md:max-w-[40rem] lg:mx-0">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--color-text-primary)]">
                {talkIntent ? (canTalk ? 'Ready to talk through the camera?' : 'Talk requires owner access') : `Ready to ${deterrenceAction === 'light' ? 'turn on the light' : deterrenceAction === 'warning' ? 'play a warning' : 'sound the siren'}?`}
              </p>
              <p className="text-xs text-[var(--color-text-secondary)]">
                {talkIntent ? (!canTalk ? 'Family and viewer accounts can listen, but only an owner can publish microphone audio.' : audioEnabled ? 'Your microphone starts only after you tap below.' : 'Configure and enable camera audio in Settings first.') : `Foreground confirmation is required for the ${deterrenceDuration}-second action.`}
              </p>
            </div>
            <div className="flex gap-1">
              <button type="button" onClick={clearActionIntent} className="min-h-11 rounded-full px-3 text-xs font-semibold text-[var(--color-text-secondary)]">Cancel</button>
              <button
                type="button"
                onClick={() => talkIntent ? (!canTalk ? clearActionIntent() : audioEnabled ? void toggleTalk().then(clearActionIntent) : navigate('/settings')) : void confirmDeterrence()}
                className="min-h-11 rounded-full bg-[var(--color-ink)] px-3 text-xs font-semibold text-[var(--color-on-ink)]"
              >
                {talkIntent ? (!canTalk ? 'Dismiss' : audioEnabled ? 'Start talk' : 'Open Settings') : 'Review action'}
              </button>
            </div>
          </section>
        ) : null}
        {/* Overhaul W1 item 9: passive "alerts are off" nudge. Links
            to Settings → Alerts by seeding the tab key Settings
            already reads from localStorage (it has no URL tab param).
            Warning treatment, not danger — the camera still watches;
            only the phone stays silent. */}
        {alertsBlocked && (
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.setItem('homecam:settingsTab', 'notifications')
              } catch {
                // localStorage can throw in private/lockdown modes —
                // the navigation below still lands on Settings.
              }
              navigate('/settings')
            }}
            className="mx-4 mt-3.5 flex items-center gap-2.5 rounded-[var(--radius-xl)] border-[1.5px] border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 landscape-phone:mx-3 landscape-phone:mt-0 md:w-full md:max-w-[40rem] md:mx-auto lg:mx-0"
          >
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-full flex-shrink-0 bg-[var(--color-warning)]"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-bold text-[var(--color-text-primary)]">
                Alerts are off
              </span>
              <span className="block text-xs font-medium text-[var(--color-text-secondary)]">
                Notifications are blocked for this app. Tap to fix in Settings.
              </span>
            </span>
            <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">
              ›
            </span>
          </button>
        )}

        <PackageStatusCard />

        {/* ============ TODAY'S STORY ============ */}
        <TodayTimeline
          events={events}
          quietSince={quietSince}
          error={error}
          onOpen={setOpenEvent}
          onRetry={refetchTodayEvents}
          detectionPaused={detectionActive === false && workerAlive !== false}
          workerOffline={workerAlive === false}
          nowMs={nowMs}
        />
      </div>

      {previewUrl && (
        <SnapshotPreview url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
      {openEvent && (
        <ClipModal
          event={openEvent}
          onClose={() => setOpenEvent(null)}
        />
      )}
    </div>
  )
}

/* ================= Today timeline ================= */

function LiveGlanceStrip({
  unhealthy,
  stateLabel,
  watchingDetail,
  sentryName,
  detectionActive,
  canManageDetection,
  detectionToggleBusy,
  onToggleDetection,
  power,
}: {
  unhealthy: boolean
  stateLabel: string
  watchingDetail: string
  sentryName: string
  detectionActive: boolean | null
  canManageDetection: boolean
  detectionToggleBusy: boolean
  onToggleDetection: () => void
  power: ReturnType<typeof powerDisplay>
}) {
  const watchState = (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-extrabold leading-tight landscape-phone:text-xs tablet-landscape:text-sm">
          {stateLabel.replace(/…/g, '')}
        </p>
        <p className="text-xs font-medium leading-tight text-white/78">
          {detectionToggleBusy ? 'Updating watch status' : watchingDetail}
        </p>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        <span
          aria-label={power.detail}
          title={power.detail}
          className={`whitespace-nowrap rounded-full border px-2 py-1 text-[10px] font-bold tabular-nums ${
            power.state === 'live'
              ? 'border-white/25 bg-white/8 text-white/85'
              : power.state === 'error' || power.state === 'stale'
                ? 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
                : 'border-white/18 bg-white/5 text-white/60'
          }`}
        >
          {power.compact}
        </span>
      {canManageDetection && detectionActive != null ? (
        <span
          aria-hidden="true"
          className="inline-flex flex-none items-center gap-1 rounded-full border border-white/35 bg-white/10 px-2 py-1 text-[11px] font-bold text-white shadow-sm transition-colors group-hover:bg-white/16 group-active:bg-white/22"
        >
          {detectionToggleBusy ? (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/35 border-t-white" />
          ) : detectionActive ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="3" width="3.5" height="10" rx="1" />
              <rect x="9.5" y="3" width="3.5" height="10" rx="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.8v10.4L13 8 4 2.8Z" />
            </svg>
          )}
          {detectionToggleBusy ? 'Saving' : detectionActive ? 'Pause' : 'Resume'}
        </span>
      ) : null}
      </div>
    </div>
  )
  return (
    <div
      data-testid="live-glance-strip"
      className="shrink-0 border-t border-white/10 bg-black/88 px-3 py-2 text-white backdrop-blur-md landscape-phone:px-2.5 landscape-phone:py-1.5 tablet-landscape:px-3 tablet-landscape:py-2 lg:px-4"
    >
      <div className="flex items-center">
        {canManageDetection && detectionActive != null ? (
          <button
            type="button"
            disabled={detectionToggleBusy}
            onClick={onToggleDetection}
            aria-label={
              detectionActive
                ? `Pause detection and classification — ${sentryName} is on watch`
                : `Resume detection and classification — bring ${sentryName} back on watch`
            }
            className={`group min-h-11 w-full min-w-0 cursor-pointer rounded-xl border px-3 py-2 text-left shadow-sm transition-colors hover:bg-white/8 active:bg-white/12 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-70 ${
              unhealthy
                ? 'border-[var(--color-danger)] bg-white/5 text-[var(--color-danger)]'
                : 'border-white/18 bg-white/5 text-white'
            }`}
          >
            {watchState}
          </button>
        ) : (
          <div
            className={`min-h-11 w-full min-w-0 rounded-xl border px-3 py-2 ${
            unhealthy
              ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
              : 'border-white/18 bg-white/5 text-white'
            }`}
          >
            {watchState}
          </div>
        )}
      </div>
    </div>
  )
}

function sightingBreakdown(events: DetectionEvent[]): string {
  const persons = events.filter((event) => event.label === 'person').length
  const cats = events.filter((event) => event.label === 'cat').length
  const others = events.length - persons - cats
  const parts: string[] = []
  if (persons > 0) {
    parts.push(`${persons} person ${persons === 1 ? 'sighting' : 'sightings'}`)
  }
  if (cats > 0) {
    parts.push(`${cats} cat ${cats === 1 ? 'sighting' : 'sightings'}`)
  }
  if (others > 0) {
    parts.push(`${others} other ${others === 1 ? 'sighting' : 'sightings'}`)
  }
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Fuzz F8: the row subline used to be the constant "Tap to review" —
 * a wasted line, since the row is already a button (the tap
 * affordance is implicit). `DetectionEvent` has no clip-duration
 * field on the wire (checked `lib/types.ts` — only
 * `clip_url`/`thumb_url`/box data), so this surfaces the next most
 * useful thing instead: recognition state for person events (the
 * title already names a KNOWN person, so the subline only needs to
 * flag the unrecognized case) plus relative time for everyone. If a
 * duration field ever lands on the wire, thread it in here ahead of
 * the relative-time fallback.
 */
function eventSubline(e: DetectionEvent, nowMs: number): string {
  const rel = relativeTime(e.ts, nowMs)
  if (e.label === 'person' && recognizedNames(e).length === 0) {
    return `Not recognized · ${rel}`
  }
  return rel
}

// Overhaul W1 item 7 (perf C2): memoized — the parent re-renders on
// every 5 s status poll, and without memo all ~50 EventRow children
// re-rendered each time even though this component's props only
// change on a real refetch (or the 30 s relative-time tick).
const TodayTimeline = memo(function TodayTimeline({
  events,
  quietSince,
  error,
  onOpen,
  onRetry,
  detectionPaused,
  workerOffline,
  nowMs,
}: {
  events: DetectionEvent[] | null
  quietSince: string | null
  error: boolean
  onOpen: (e: DetectionEvent) => void
  onRetry: () => void
  detectionPaused: boolean
  workerOffline: boolean
  nowMs: number
}) {
  const navigate = useNavigate()

  return (
    // Overhaul W1 item 1: content-width ceiling — on mid-size
    // viewports (portrait tablets / narrow desktop) the timeline used
    // to stretch the full window. Inside the lg grid the right rail's
    // own column cap wins (max-w-2xl is wider than the rail).
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))] w-full landscape-phone:order-2 landscape-phone:px-0 landscape-phone:pt-0 landscape-phone:pb-2 landscape-phone:scrollbar-hide tablet-landscape:order-2 tablet-landscape:px-0 tablet-landscape:pt-0 tablet-landscape:pb-0 tablet-landscape:scrollbar-hide md:max-w-[40rem] md:mx-auto md:px-0 lg:max-w-none lg:mx-0 lg:pb-0"
      aria-label="Today's activity"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold text-[var(--color-text-primary)] landscape-phone:text-base">
          Today at home
        </h2>
        {/* Overhaul W1 item 4: -m-2 p-2 grows the tap target without
            moving the visual text (was a bare text-xs link). */}
        <button
          type="button"
          onClick={() => navigate('/events')}
          className="-m-2 inline-flex min-h-11 items-center rounded p-2 text-xs font-semibold text-[var(--color-accent-deep)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Full history →
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 mb-4 landscape-phone:mb-2">
        {events == null
          ? 'Loading today'
          : events.length === 0
            ? 'No sightings yet today'
            : `${events.length} ${events.length === 1 ? 'sighting' : 'sightings'} today`}
      </p>
      {events != null && events.length > 0 ? (
        <p
          data-testid="today-sightings-summary"
          className="-mt-3 mb-4 text-xs font-medium text-[var(--color-text-tertiary)] landscape-phone:-mt-1 landscape-phone:mb-2"
        >
          {sightingBreakdown(events)}
        </p>
      ) : null}
      {/* Overhaul W1 item 3 (mira#4, hari GESTURE-4/STATE-1): the
          designed ErrorState with a real Retry button replaces the
          bare red <p> — whose copy told users to "pull to refresh",
          a gesture that does not exist anywhere in the app. */}
      {error && (
        <ErrorState
          title="Couldn't load today's events"
          message="Check your connection, then try again."
          retry={onRetry}
        />
      )}

      {events != null && events.length === 0 && !error && (
        <CatEmptyState
          heading="All quiet so far"
          body="Nothing has crossed the porch today. Events will appear here the moment something moves."
        />
      )}

      <ol className="space-y-2 pr-1">
        {quietSince && (
          <li className="rounded-[var(--radius-xl)] border border-dashed border-[var(--color-border)] px-3 py-2.5 text-xs text-[var(--color-text-secondary)]">
            Quiet since {quietSince}
          </li>
        )}
        {(events ?? []).map((e) => (
          <li key={e.id}>
            <EventRow
              event={e}
              subline={eventSubline(e, nowMs)}
              onOpen={() => onOpen(e)}
              leading="video-status"
              detectionPaused={detectionPaused}
              workerOffline={workerOffline}
              nowMs={nowMs}
            />
          </li>
        ))}
      </ol>
    </section>
  )
})

/* ================= Full-mode hour scrubber ================= */

/**
 * Fuzz F1: the fullscreen scrubber used a completely different color
 * language than Events' `HourBand` — activity cells were flat orange
 * ("accent-bright") regardless of who appeared, and the current-time
 * cell was filled solid `--color-success` green, which nowhere else
 * in the identity system means "now" (it's the alert-adjacent
 * "healthy" hue). Same underlying data (today's events bucketed by
 * time), two unrelated color stories.
 *
 * Fix: bucket ownership uses the SAME rank (`_KIND_RANK`, mirrored
 * from `HourBand.tsx` — a person always outranks a cat, ties go to
 * the earliest event in the bucket) and the SAME `identityOf()`
 * mapping, so a recognized person's personal hue, the shared person
 * cobalt, or the cat marmalade reads identically here and on Events.
 *
 * This scrubber sits on a permanently-black gradient (the fullscreen
 * scrim), not a themed surface, so — matching the precedent already
 * set by the LIVE pill and the danger-token comment below — it
 * resolves each identity token to its FIXED dark-range hex instead
 * of `var(--color-id-*)`. The light-theme tokens (e.g. cobalt
 * `#2f5fe0`) read fine on paper but under-contrast against always-
 * black; the dark-theme values were tuned for exactly this kind of
 * dark-glass chrome.
 */
const _HOUR_KIND_RANK: Record<IdentityKind, number> = {
  'named-person': 3,
  person: 3,
  cat: 2,
  other: 1,
}

/** `var(--color-id-<token>)` -> its fixed dark-theme hex (see block
 * comment above for why fixed, not `var()`, on this always-black
 * chrome). Falls back to the neutral panther hex for any token this
 * table doesn't know about yet (defensive — every current identity
 * token is covered). */
const _DARK_ID_HEX: Record<string, string> = {
  panther: '#8f8ba0',
  mushu: '#f08536',
  coco: '#e8859e',
  person: '#6c8ff0',
  'wheel-1': '#6c8ff0',
  'wheel-2': '#2dd4bf',
  'wheel-3': '#a78bfa',
  'wheel-4': '#f472b6',
  'wheel-5': '#4ade80',
  'wheel-6': '#eab308',
}

function _darkHexForColorVar(colorVar: string): string {
  const token = /--color-id-([a-z0-9-]+)\)/.exec(colorVar)?.[1]
  return (token && _DARK_ID_HEX[token]) || _DARK_ID_HEX.panther
}

type HourBucket = { count: number; rank: number; color: string | null; ts: number | null }

function _emptyBuckets(): HourBucket[] {
  return Array.from({ length: 16 }, () => ({ count: 0, rank: 0, color: null, ts: null }))
}

function HourScrubber({ onJumpHistory }: { onJumpHistory: () => void }) {
  const [buckets, setBuckets] = useState<HourBucket[] | null>(null)

  useEffect(() => {
    let cancelled = false
    searchEvents({ since_ts: localMidnightTs(), limit: 200 })
      .then((r) => {
        if (cancelled) return
        const bins = _emptyBuckets()
        const start = localMidnightTs()
        const span = 24 * 60 * 60
        for (const e of r.items) {
          const i = Math.min(15, Math.floor(((e.ts - start) / span) * 16))
          if (i < 0) continue
          const b = bins[i]
          b.count += 1
          const identity = identityOf(e)
          const rank = _HOUR_KIND_RANK[identity.kind]
          // Same tie-break as HourBand: a higher rank always wins;
          // on a rank tie, the EARLIEST event in the bucket wins
          // ("first event of the hour" reads more naturally than
          // whichever the newest-first API response happened to
          // list first).
          const isNewWinner =
            rank > b.rank || (rank === b.rank && b.rank > 0 && b.ts != null && e.ts < b.ts)
          if (isNewWinner) {
            b.rank = rank
            b.color = _darkHexForColorVar(identity.colorVar)
            b.ts = e.ts
          }
        }
        setBuckets(bins)
      })
      .catch(() => {
        if (!cancelled) setBuckets(_emptyBuckets())
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    // Overhaul W1 item 4: lateral safe-area padding so the LIVE pill
    // and the strip's right edge never sit under a landscape notch /
    // home-indicator inset.
    <div
      className="flex-none pt-3 bg-gradient-to-t from-black/80 to-transparent"
      style={{
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <div className="flex items-start gap-2.5">
        {/* Overhaul W1 item 5 (hari GESTURE-2): this strip used to be
            DRESSED as a seek scrubber (12AM/6AM/12PM/NOW axis labels
            + a ringed NOW cell) while the whole thing was one nav
            button to /events — every visual cue promised "drag/tap to
            seek" and delivered a page change. Events has no per-hour
            deep link on its URL, so the honest fix is to stop the
            dress-up: the identity-colored cells stay as a glanceable
            activity summary (fuzz F1 coloring untouched), and a
            visible label now says exactly what a tap does. */}
        <button
          type="button"
          onClick={onJumpHistory}
          className="flex-1 flex flex-col focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 rounded"
        >
          <span className="w-full flex items-end gap-[3px] h-8" aria-hidden="true">
            {(buckets ?? _emptyBuckets()).map((b, i) => (
              <span
                key={i}
                data-testid={`hour-cell-${i}`}
                className={`flex-1 rounded-sm ${b.color ? '' : 'bg-white/15'}`}
                style={{
                  background: b.color ?? undefined,
                  height: b.color ? 16 : 5,
                }}
              />
            ))}
          </span>
          {/* Overhaul W1 item 4: label bumped from 9px to the
              --text-xs token (11px). */}
          <span className="w-full flex items-baseline justify-between mt-1.5 text-xs">
            <span className="font-semibold text-white/70">Today&apos;s activity</span>
            <span className="text-white/50">Open history ›</span>
          </span>
        </button>
        {/* Final whole-branch review fix batch #3: fixed over-video
            colors — the fullscreen scrim is black in both themes;
            theme danger tokens are tuned for paper (same exception as
            text-white on video). The tokenized danger colors measured
            ~4.1:1 against this always-black overlay in light theme. */}
        <span className="flex-none text-xs font-extrabold tracking-wider text-[#f87171] bg-[rgba(248,113,113,0.16)] ring-1 ring-[rgba(248,113,113,0.45)] px-2.5 py-1 rounded-full">
          ● LIVE
        </span>
      </div>
    </div>
  )
}

/* ================= Camera switcher (multicam) ================= */

/**
 * Multicam contract (docs/multicam_contract.md, 2026-07-07): pill
 * radiogroup for picking which camera the live viewport shows. Only
 * rendered when cameras.length > 1. Same accessible grammar as the
 * Events filter chips: role="radiogroup" + roving tabindex (only the
 * selected pill is in the Tab order; arrow keys move within), 44px
 * touch targets, ink-fill selected state (Playroom pill grammar).
 */
function CameraSwitcher({
  cameras,
  selectedId,
  onSelect,
}: {
  cameras: Camera[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const idx = cameras.findIndex((c) => c.id === selectedId)
  return (
    <div
      role="radiogroup"
      aria-label="Switch camera"
      tabIndex={-1}
      className="mt-2 flex gap-2 -mx-1 px-1 min-h-[44px] items-center overflow-x-auto overscroll-x-contain scrollbar-hide"
      onKeyDown={(e) => {
        if (idx === -1) return
        const next = nextRovingIndex(e.key, idx, cameras.length)
        if (next === null) return
        e.preventDefault()
        onSelect(cameras[next].id)
        // Focus after the tabIndex flip lands (same rAF pattern as
        // the Events ChipRadiogroup / iter-335 ClipModal).
        requestAnimationFrame(() => {
          refs.current[next]?.focus()
        })
      }}
    >
      {cameras.map((c, i) => {
        const active = c.id === selectedId
        return (
          <button
            key={c.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(c.id)}
            className={`inline-flex items-center gap-1.5 min-h-[44px] px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 flex-shrink-0 ${
              active
                ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)] border-[var(--color-ink)]'
                : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
            }`}
          >
            {c.name}
          </button>
        )
      })}
    </div>
  )
}

/* ================= Small pieces ================= */

function RailButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const ripple = useRipple()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onPointerDown={disabled ? undefined : ripple}
      aria-label={label}
      className="relative overflow-hidden w-[54px] h-[54px] rounded-[19px] bg-black/55 backdrop-blur ring-1 ring-white/15 text-white flex flex-col items-center justify-center gap-0.5 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2"
    >
      {children}
      {/* Overhaul W1 item 4: 8.5px was below any legible floor — use
          the --text-xs token (11px). */}
      <span className="text-xs text-white/65 leading-none">{label}</span>
    </button>
  )
}

function ExpandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function SnapshotIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  )
}

// MicIcon (Talk button glyph) removed with the "Talk · soon"
// placeholder — fuzz F11, two-way audio returns post-hardware.
