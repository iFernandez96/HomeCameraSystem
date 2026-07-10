import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ZOOM_IDENTITY,
  isZoomed,
  panUpdate,
  pinchUpdate,
  toTransform,
  type ZoomState,
} from '../lib/pinchZoom'
import {
  fetchEventClipStatus,
  fetchEventTracks,
  probeEventClip,
  searchEvents,
  type EventClipStatus,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { drawBoxes, resolveIdColor } from '../lib/drawBoxes'
import {
  absoluteTime,
  clockTime,
  eventTitle,
  humanCameraName,
  recognizedNames,
  relativeTime,
} from '../lib/eventLabel'
import { identityOf } from '../lib/identity'
import { log, errFields } from '../lib/log'
import { useEventViewTelemetry } from '../lib/telemetry'
import type { DetectionBox, DetectionEvent, EventTracks } from '../lib/types'
import { VideoPlayer } from './VideoPlayer'
import { ClipStateBadge, getClipStatePresentation } from './ClipStateBadge'

// Playroom Modern (Task 7): ±2h window either side of the active event for
// the "More from tonight" rail. Wide enough to surface a household's usual
// evening traffic without pulling in yesterday/tomorrow noise.
const MORE_TONIGHT_WINDOW_S = 2 * 60 * 60

// UI/UX overhaul 2026-07-07 (hari GESTURE-5): swipe-between-clips
// gesture constants. A horizontal drag on the video pane flips to the
// prev/next event from the already-fetched "More from tonight" window.
// Threshold/feedback numbers mirror EventList's swipe-to-delete scale
// so the two gestures feel like one system.
/** Raw finger travel (px) at/past which release advances to the neighbor. */
const SWIPE_ADVANCE_PX = 70
/** Visual drag feedback cap (px) when a neighbor exists in that direction. */
const SWIPE_FEEDBACK_MAX_PX = 48
/** Rubber-band cap (px) at either end of the window (no neighbor). */
const SWIPE_RUBBER_MAX_PX = 20
/** Bottom strip of the video pane reserved for the NATIVE <video controls>
 *  scrubber — a horizontal drag there is a seek, never a clip swipe. The
 *  guard is skipped when the pane has no layout box (jsdom). */
const SWIPE_CONTROLS_GUARD_PX = 64

/** How long a missing clip stays in the recheck window. A 404 from the
 *  clip route means only "not available right now"; it does not identify why.
 *  During this window the modal keeps probing and
 *  swaps the player in if the MP4 appears. Past it, the UI stops implying
 *  that waiting is likely to help. */
const CLIP_RECHECK_WINDOW_S = 10 * 60
/** Re-probe cadence while a fresh event's clip is not available yet. */
const CLIP_PROBE_INTERVAL_MS = 8000

/** Content dedupe pass (Frank phone-round finding): the "More from
 * tonight" rows used to show the current camera's location on EVERY
 * row — useless repetition since every event in this rail is already
 * from a single household's cameras and the active event's own
 * location is stated right above in the header. Mirrors Watch.tsx's
 * `eventSubline` (recognition state + relative time); location is
 * appended ONLY when a sibling event came from a different camera
 * than the one currently open, since that's the one case the location
 * is actually new information. Computed at the ClipModal call site
 * rather than inside EventRow so the shared row component stays a
 * dumb renderer. */
function moreTonightSubline(e: DetectionEvent, currentCameraId: string, nowMs: number): string {
  const rel = relativeTime(e.ts, nowMs)
  const base =
    e.label === 'person' && recognizedNames(e).length === 0 ? `Not recognized · ${rel}` : rel
  return e.camera_id !== currentCameraId ? `${base} · ${humanCameraName(e.camera_id)}` : base
}

/**
 * Per-event clip modal (iter-203, Feature #1 slice 3).
 *
 * Renders `<video>` pulling from `/api/events/{id}/clip` (the
 * iter-201 route). On video-load error — most common today since
 * slice 2's recorder isn't deployed yet, but also possible after a
 * retention sweep deletes the file — falls back to the static
 * snapshot at `event.thumb_url`. If THAT also errors / is absent,
 * shows a "Clip unavailable" empty state.
 *
 * Same dismiss surface as `SnapshotPreview`: ESC, backdrop click,
 * Close button. Same pattern of comparing the URL-that-errored
 * against the current prop URL so a fresh selection clears the
 * fallback automatically (avoids the
 * `react-hooks/set-state-in-effect` lint trap CLAUDE.md documents).
 */
export function ClipModal({
  event: eventProp,
  onClose,
}: {
  event: DetectionEvent
  onClose: () => void
}) {
  // Playroom Modern (Task 7, "More from tonight"): the modal can browse
  // sideways into a neighboring event from the SAME open dialog (tap a
  // "more from tonight" row) without the parent (Watch/Events) needing to
  // know or re-render — `event` is local state seeded from the prop, and
  // resets back to the prop whenever the PARENT swaps which event is
  // selected (a genuinely new `event.id` from outside). This is the React-
  // docs "adjusting state when a prop changes" pattern (compare during
  // render, not inside a useEffect) — CLAUDE.md's `set-state-in-effect`
  // trap only applies to effect bodies, and this deliberately isn't one.
  const [event, setEvent] = useState(eventProp)
  const [syncedEventId, setSyncedEventId] = useState(eventProp.id)
  const { user } = useAuth()
  useEventViewTelemetry(user?.username, event.id)
  const clipUrl = `/api/events/${event.id}/clip`
  // Event-view jank fix round 2 (2026-07-08): the worker marks
  // coalesced events — emitted while another visit's clip was already
  // recording — with clip_url=null (8 of 145 events in a production
  // day). Their footage lives in the COVERING visit's clip; a clip
  // for their own id will never exist. Pre-fix the modal ignored the
  // field, built its own URL, 404'd, and promised a video forever.
  // `undefined` (field absent, e.g. a live WS payload) stays
  // optimistic — only an explicit null is the worker saying "no clip
  // of its own, by design".
  const hasOwnClip = event.clip_url !== null
  // Track which clip URL has errored. If the prop event changes
  // (parent passed a new event), `clipErrored` naturally becomes
  // false because `erroredClipUrl !== clipUrl`.
  const [erroredClipUrl, setErroredClipUrl] = useState<string | null>(null)
  const [erroredImgUrl, setErroredImgUrl] = useState<string | null>(null)
  const clipErrored = erroredClipUrl === clipUrl
  const imgErrored = !!event.thumb_url && erroredImgUrl === event.thumb_url

  // Event-view jank fix (2026-07-08): probe the clip route directly
  // instead of waiting for <video> to error on a 404. Same URL-keyed
  // shape as erroredClipUrl so switching events auto-clears it. A 404
  // means only that the MP4 is not available right now; the age window
  // below decides whether to keep rechecking.
  const [missingClipUrl, setMissingClipUrl] = useState<string | null>(null)
  const clipMissing = !hasOwnClip || missingClipUrl === clipUrl
  const [clipStatus, setClipStatus] = useState<EventClipStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    // clip_url=null events never get a standalone clip — nothing to
    // probe, and probing would just 404-spam the server log.
    if (!hasOwnClip) return undefined
    probeEventClip(event.id)
      .then((exists) => {
        if (cancelled || exists) return
        setMissingClipUrl(`/api/events/${event.id}/clip`)
      })
      .catch((e) => {
        // Network/auth blip: keep the optimistic player mounted — the
        // <video> element's own error path still covers a real failure.
        log.warn('clipModal:clip-probe-failed', {
          eventId: event.id,
          ...errFields(e),
        })
      })
    return () => {
      cancelled = true
    }
  }, [event.id, hasOwnClip])

  // While a fresh event's clip is missing, keep probing so the player swaps in
  // by itself the moment the file lands. This is a recheck policy, not a claim
  // that the recorder is still running.
  const clipGone = clipMissing || clipErrored
  const [clipFullscreen, setClipFullscreen] = useState(false)
  if (clipGone && clipFullscreen) setClipFullscreen(false)
  const activeClipStatus = clipStatus?.event_id === event.id ? clipStatus : null
  useEffect(() => {
    let cancelled = false
    if (!hasOwnClip) return undefined
    fetchEventClipStatus(event.id)
      .then((status) => {
        if (cancelled) return
        setClipStatus(status)
        if (status.state === 'available') {
          setMissingClipUrl(null)
          setErroredClipUrl(null)
        }
      })
      .catch((e) => {
        log.warn('clipModal:clip-status-fetch-failed', {
          eventId: event.id,
          ...errFields(e),
        })
        if (!cancelled) setClipStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [event.id, hasOwnClip])
  useEffect(() => {
    if (!clipGone) return
    // No standalone clip will ever exist for a clip_url=null event —
    // polling would spin for the whole still-writing window for nothing.
    if (!hasOwnClip) return
    if (Date.now() / 1000 - event.ts >= CLIP_RECHECK_WINDOW_S) return
    let cancelled = false
    const id = setInterval(() => {
      if (Date.now() / 1000 - event.ts >= CLIP_RECHECK_WINDOW_S) {
        clearInterval(id)
        return
      }
      probeEventClip(event.id)
        .then((exists) => {
          if (cancelled || !exists) return
          setMissingClipUrl(null)
          setErroredClipUrl(null)
        })
        .catch(() => {
          // Probe is best-effort while polling; next tick retries.
        })
    }, CLIP_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [clipGone, hasOwnClip, event.id, event.ts])

  useEffect(() => {
    if (!hasOwnClip) return
    if (
      !clipGone &&
      activeClipStatus?.state !== 'recording' &&
      activeClipStatus?.state !== 'finalizing'
    ) return
    let cancelled = false
    const id = setInterval(() => {
      fetchEventClipStatus(event.id)
        .then((status) => {
          if (cancelled) return
          setClipStatus(status)
          if (status.state === 'available') {
            setMissingClipUrl(null)
            setErroredClipUrl(null)
            clearInterval(id)
          }
        })
        .catch((e) => {
          log.warn('clipModal:clip-status-poll-failed', {
            eventId: event.id,
            ...errFields(e),
          })
        })
    }, CLIP_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [clipGone, activeClipStatus?.state, event.id, hasOwnClip])

  // Bug fix (real-device Firefox Android, phone-verified): the clip
  // pane went completely blank on both fresh AND minutes-old events —
  // no player, no error, no thumb. Root cause was two
  // layered issues:
  //   1. An unstarted <video> has zero intrinsic size. With mobile
  //      autoplay blocked, the media pane collapsed toward nothing
  //      before metadata loaded, and `onError` never fires for a
  //      merely-slow/pending clip so neither fallback branch below
  //      ever kicked in.
  //   2. The video-pane flex column used `min-h-0` unconditionally,
  //      so once (1) shrank its content, the WHOLE column (header +
  //      video) could be squeezed toward zero height by
  //      its sibling (the evidence <aside>, which has no cap on its
  //      own natural height once "More from tonight" grew it).
  // `videoReady` (wired up below, once `videoRef` exists) tracks
  // whether THIS clip's element has actually produced a frame
  // (loadeddata/canplay), independent of error state, so the render
  // below can show an explicit pending/loading affordance instead of
  // an empty pane while playback catches up.
  const [readyClipUrl, setReadyClipUrl] = useState<string | null>(null)
  const videoReady = readyClipUrl === clipUrl

  // Ticks every 5s so both the fresh-clip loading/recheck gates below AND the WHEN/"More from tonight" relative
  // timestamps stay fresh for as long as the modal stays open.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  // Brief loading affordance for a clip route that exists but has not
  // produced a frame yet. This is a UI loading state, not proof that the
  // recorder is still running.
  const clipRecentlyCreated = nowMs / 1000 - event.ts < 100
  // Wider window for a clip route that is still returning 404. A 404 is
  // evidence only that the MP4 is not available right now; the modal keeps
  // checking for fresh events, but the copy must not claim a cause.
  const clipInRecheckWindow = nowMs / 1000 - event.ts < CLIP_RECHECK_WINDOW_S
  const clipState = getClipStatePresentation({
    hasOwnClip,
    clipStatus: activeClipStatus,
    clipGone,
    clipInRecheckWindow,
  })
  // iter-270 (accessibility-auditor A): stash the element that had
  // focus when the modal opened so we can restore it on close.
  // Without this, ESC / Close / backdrop click leaves focus on
  // <body>, and the screen-reader rotor reads from the top of the
  // page on the next interaction. Mirror of the iter-? confirm-
  // dialog focus-restore (also added this iter).
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // VideoPlayer hands us its <video> element here; store it in our own ref so
  // the bbox-overlay effect can bind to it. Memoized so VideoPlayer's
  // forwarding effect doesn't re-fire every render.
  const handleVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
  }, [])
  // Wires up `videoReady` (declared above) now that `videoRef` exists.
  // Mobile Chrome can start painting/playing a cached clip before this
  // effect observes loadeddata, so readiness must also be derived from the
  // element's current state and playback events. Otherwise the loading
  // overlay can remain visible behind a playing video.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const markReady = () => setReadyClipUrl(clipUrl)
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || !video.paused) {
      markReady()
    }
    video.addEventListener('loadeddata', markReady)
    video.addEventListener('canplay', markReady)
    video.addEventListener('playing', markReady)
    video.addEventListener('play', markReady)
    return () => {
      video.removeEventListener('loadeddata', markReady)
      video.removeEventListener('canplay', markReady)
      video.removeEventListener('playing', markReady)
      video.removeEventListener('play', markReady)
    }
  }, [clipUrl])
  // iter-336 (a11y blocker #2): focus-trap host. Tab cycles within
  // focusable descendants of this div instead of escaping to the
  // browser chrome / page behind the modal.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Playroom Modern (identity-colored boxes + evidence-pane grammar):
  // moved up from the bottom of the component (was computed only for the
  // WHO/aside JSX) — the bbox-overlay effect below now needs the same
  // identity + display-name to color and label the canvas overlay, so
  // there's a single source of truth instead of two derivations drifting.
  const matchedNames = recognizedNames(event)
  const personLabel = matchedNames.length > 0 ? matchedNames[0] : null
  const identity = useMemo(() => identityOf(event), [event])
  // resolveIdColor reads getComputedStyle once per identity change (NOT
  // per animation frame) — the resolved rgb/hex string is what the canvas
  // overlay effect hands to drawBoxes's opts.color.
  const resolvedIdColor = useMemo(() => resolveIdColor(identity), [identity])
  // "Someone · 92%" for a detected-but-unrecognized person: reuses
  // drawBoxes's existing personName-labeling path (matched box gets
  // `${personName} score%`) by handing it a display name even though no
  // real name was recognized, rather than adding a second labeling mode.
  const boxLabelName = personLabel ?? (identity.kind === 'person' ? 'Someone' : null)

  // Playroom Modern (Task 7, "More from tonight"): sibling events within
  // ±2h of the active event, so a household member reviewing one clip can
  // browse the rest of the evening without leaving the modal.
  // No synchronous reset-to-null at the top of the effect (mirrors the
  // `tracks` fetch above, same react-hooks/set-state-in-effect
  // constraint from CLAUDE.md) — the rail keeps showing the PREVIOUS
  // event's siblings for one frame while the new window fetches, rather
  // than flashing empty on every "More from tonight" tap.
  const [moreTonight, setMoreTonight] = useState<DetectionEvent[] | null>(null)
  useEffect(() => {
    let cancelled = false
    searchEvents({
      since_ts: event.ts - MORE_TONIGHT_WINDOW_S,
      until_ts: event.ts + MORE_TONIGHT_WINDOW_S,
      limit: 20,
    })
      .then((r) => {
        if (cancelled) return
        setMoreTonight(r.items.filter((e) => e.id !== event.id))
      })
      .catch((e) => {
        // Non-fatal — the rail just stays empty. WARN (not ERROR): the
        // clip itself still plays fine, this is a nice-to-have sidebar.
        log.warn('clipModal:more-tonight-fetch-failed', {
          eventId: event.id,
          ...errFields(e),
        })
        if (!cancelled) setMoreTonight([])
      })
    return () => {
      cancelled = true
    }
  }, [event.id, event.ts])

  // UI/UX overhaul 2026-07-07 (hari GESTURE-5): swipe-between-clips.
  // A horizontal swipe on the VIDEO PANE flips to the neighboring event
  // from the same sibling window the "More from tonight" rail shows —
  // no new fetching, and the advance goes through the SAME `setEvent`
  // mechanism a rail-row tap uses, so focus, pending/loading states and
  // the bbox-overlay wiring all behave identically.
  //
  // DIRECTION: the rail lists siblings newest-first (the /api/events/
  // search order), so the timeline below sorts descending by ts to
  // match it. Swipe LEFT advances DOWN the list (the next, OLDER
  // event); swipe RIGHT goes back UP it (NEWER). i.e. the content
  // follows the finger toward the row you'd tap next.
  const swipeTimeline = useMemo(() => {
    const all = [...(moreTonight ?? []), event]
    all.sort((a, b) => b.ts - a.ts)
    return all
  }, [moreTonight, event])
  const videoPaneRef = useRef<HTMLDivElement | null>(null)
  // Same touchAxis discipline as EventList's swipe-to-delete: axis is
  // decided ONCE per gesture at the first >6px move, and a vertical
  // start (scrolling the stacked mobile modal) can never become a
  // swipe mid-gesture. All gesture state lives in refs and the drag
  // feedback is an imperative style write — zero per-move renders.
  const swipeStartX = useRef<number | null>(null)
  const swipeStartY = useRef<number | null>(null)
  const swipeAxis = useRef<'h' | 'v' | null>(null)
  const swipeDx = useRef(0)
  // Pinch-to-zoom: two fingers scale the INNER zoom layer (video/snapshot +
  // overlays), one finger pans while zoomed, and clip-swipe is suppressed
  // until the zoom glides back to 1x. The zoom layer is separate from the
  // pane so swipe translateX and zoom transform never fight over one style.
  const zoomLayerRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef<ZoomState>(ZOOM_IDENTITY)
  const [clipZoomed, setClipZoomed] = useState(false)
  const pinchDist = useRef(0)
  const panLast = useRef<{ x: number; y: number } | null>(null)
  const applyClipZoom = () => {
    const el = zoomLayerRef.current
    if (el) el.style.transform = toTransform(zoomRef.current)
    setClipZoomed(isZoomed(zoomRef.current))
    // While zoomed the pane owns EVERY touch (panning must not scroll
    // the modal's single-column layout underneath); back at 1x the
    // class's touch-pan-y resumes letting vertical scrolls through.
    const pane = videoPaneRef.current
    if (pane) pane.style.touchAction = isZoomed(zoomRef.current) ? 'none' : ''
  }
  const resetClipZoom = useCallback(() => {
    zoomRef.current = ZOOM_IDENTITY
    pinchDist.current = 0
    panLast.current = null
    setClipZoomed(false)
    const el = zoomLayerRef.current
    if (el) el.style.transform = ''
    const pane = videoPaneRef.current
    if (pane) pane.style.touchAction = ''
  }, [])
  const selectEvent = useCallback(
    (nextEvent: DetectionEvent) => {
      resetClipZoom()
      setEvent(nextEvent)
    },
    [resetClipZoom],
  )
  const toggleClipFullscreen = useCallback(
    (active: boolean) => {
      if (!active) resetClipZoom()
      setClipFullscreen(active)
    },
    [resetClipZoom],
  )
  // A parent-selected clip is a fresh viewing context. Adjusting local state
  // during render follows React's prop/state synchronization pattern and avoids
  // an extra stale render from synchronizing in an effect.
  if (eventProp.id !== syncedEventId) {
    setSyncedEventId(eventProp.id)
    setEvent(eventProp)
  }
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) resetClipZoom()
    })
    return () => {
      cancelled = true
    }
  }, [event.id, resetClipZoom])
  const paneSize = () => {
    const r = videoPaneRef.current?.getBoundingClientRect()
    return {
      vw: r?.width ?? 0,
      vh: r?.height ?? 0,
      left: r?.left ?? 0,
      top: r?.top ?? 0,
    }
  }
  const pinchDistanceOf = (ev: TouchEvent) => {
    const a = ev.touches[0]
    const b = ev.touches[1]
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }
  const swipeNeighbor = useCallback(
    (dx: number): DetectionEvent | null => {
      const idx = swipeTimeline.findIndex((e) => e.id === event.id)
      if (idx === -1) return null
      // dx<0 = finger moved left = next (older); dx>0 = prev (newer).
      return swipeTimeline[dx < 0 ? idx + 1 : idx - 1] ?? null
    },
    [swipeTimeline, event.id],
  )
  const onPaneTouchStart = (ev: TouchEvent) => {
    // Second finger down: the gesture becomes a pinch regardless of
    // what the first finger was doing; any in-flight swipe feedback is
    // abandoned.
    if (ev.touches.length >= 2) {
      pinchDist.current = pinchDistanceOf(ev)
      panLast.current = null
      resetSwipeRefs()
      ev.preventDefault()
      const pane = videoPaneRef.current
      if (pane) {
        pane.style.transition = ''
        pane.style.transform = ''
      }
      return
    }
    // Controls stay controls: a touch that begins on any interactive
    // element (bbox toggle, speed select, Repeat, a focused overlay
    // button) is never a swipe.
    const target = ev.target instanceof Element ? ev.target : null
    if (target && target.closest('button, select, input, a, label')) return
    const t = ev.touches[0]
    // Zoomed in: one finger pans the picture; clip-swipe stays off
    // until the pinch glides back home to 1x.
    if (isZoomed(zoomRef.current)) {
      panLast.current = { x: t.clientX, y: t.clientY }
      ev.preventDefault()
      return
    }
    const pane = videoPaneRef.current
    if (pane) {
      const rect = pane.getBoundingClientRect()
      // Native <video controls> scrubber lives along the pane's bottom
      // edge — horizontal drags there must keep seeking. (rect is all
      // zeros in jsdom / pre-layout; skip the guard then.)
      if (rect.height > 0 && t.clientY > rect.bottom - SWIPE_CONTROLS_GUARD_PX) {
        return
      }
      pane.style.transition = ''
    }
    swipeStartX.current = t.clientX
    swipeStartY.current = t.clientY
    swipeAxis.current = null
    swipeDx.current = 0
  }
  const onPaneTouchMove = (ev: TouchEvent) => {
    if (ev.touches.length >= 2) {
      // Pinch step: scale around the finger midpoint, clamped by the
      // pane box so panning never reveals off-content gaps.
      const d = pinchDistanceOf(ev)
      if (pinchDist.current > 0 && d > 0) {
        const { vw, vh, left, top } = paneSize()
        const fx = (ev.touches[0].clientX + ev.touches[1].clientX) / 2 - left
        const fy = (ev.touches[0].clientY + ev.touches[1].clientY) / 2 - top
        zoomRef.current = pinchUpdate(
          zoomRef.current,
          fx,
          fy,
          d / pinchDist.current,
          vw,
          vh,
        )
        applyClipZoom()
      }
      pinchDist.current = d
      ev.preventDefault()
      return
    }
    if (panLast.current !== null && isZoomed(zoomRef.current)) {
      const t0 = ev.touches[0]
      const { vw, vh } = paneSize()
      zoomRef.current = panUpdate(
        zoomRef.current,
        t0.clientX - panLast.current.x,
        t0.clientY - panLast.current.y,
        vw,
        vh,
      )
      panLast.current = { x: t0.clientX, y: t0.clientY }
      applyClipZoom()
      ev.preventDefault()
      return
    }
    if (swipeStartX.current === null) return
    const t = ev.touches[0]
    const dx = t.clientX - swipeStartX.current
    const dy = t.clientY - (swipeStartY.current ?? t.clientY)
    if (swipeAxis.current === null) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        swipeAxis.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v'
      }
    }
    if (swipeAxis.current !== 'h') return
    swipeDx.current = dx
    const pane = videoPaneRef.current
    if (!pane) return
    // 30-60px of drag feedback; at either end of the window there is
    // no neighbor, so the pane rubber-bands (1/3 resistance, smaller
    // cap) and will snap back on release — no wrap-around.
    const hasNeighbor = swipeNeighbor(dx) !== null
    const cap = hasNeighbor ? SWIPE_FEEDBACK_MAX_PX : SWIPE_RUBBER_MAX_PX
    const eased = hasNeighbor ? dx : dx / 3
    const shown = Math.max(-cap, Math.min(cap, eased))
    pane.style.transform = `translateX(${shown}px)`
  }
  const resetSwipeRefs = () => {
    swipeStartX.current = null
    swipeStartY.current = null
    swipeAxis.current = null
    swipeDx.current = 0
  }
  const snapPaneBack = () => {
    const pane = videoPaneRef.current
    if (!pane) return
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Reduced motion: jump straight back, no snap animation.
    pane.style.transition = reduceMotion ? '' : 'transform 160ms ease-out'
    pane.style.transform = ''
  }
  const onPaneTouchEnd = (ev: TouchEvent) => {
    // jsdom fireEvent.touchEnd with no init has no touches list.
    if ((ev.touches?.length ?? 0) > 0) {
      // Pinch losing a finger: rebase so the remaining finger pans
      // (zoomed) instead of registering as a fresh swipe.
      pinchDist.current = 0
      const t0 = ev.touches[0]
      panLast.current = isZoomed(zoomRef.current)
        ? { x: t0.clientX, y: t0.clientY }
        : null
      resetSwipeRefs()
      return
    }
    if (panLast.current !== null || pinchDist.current > 0) {
      // Zoom/pan gesture finished — keep the zoom where it is.
      pinchDist.current = 0
      panLast.current = null
      return
    }
    const started = swipeStartX.current !== null
    const axis = swipeAxis.current
    const dx = swipeDx.current
    resetSwipeRefs()
    if (!started || axis !== 'h') return
    const neighbor = Math.abs(dx) >= SWIPE_ADVANCE_PX ? swipeNeighbor(dx) : null
    if (neighbor) {
      const pane = videoPaneRef.current
      if (pane) {
        pane.style.transition = ''
        pane.style.transform = ''
      }
      // The EXACT mechanism a "More from tonight" row tap uses.
      selectEvent(neighbor)
      return
    }
    snapPaneBack()
  }
  const onPaneTouchCancel = () => {
    // Gesture aborted by the browser (e.g. an incoming system gesture):
    // never advance, just settle back. Zoom LEVEL survives — only the
    // in-flight pinch/pan tracking resets.
    pinchDist.current = 0
    panLast.current = null
    const axis = swipeAxis.current
    resetSwipeRefs()
    if (axis === 'h') snapPaneBack()
  }

  useEffect(() => {
    const pane = videoPaneRef.current
    if (!pane) return
    const opts = { capture: true, passive: false } as const
    pane.addEventListener('touchstart', onPaneTouchStart, opts)
    pane.addEventListener('touchmove', onPaneTouchMove, opts)
    pane.addEventListener('touchend', onPaneTouchEnd, opts)
    pane.addEventListener('touchcancel', onPaneTouchCancel, opts)
    return () => {
      pane.removeEventListener('touchstart', onPaneTouchStart, opts)
      pane.removeEventListener('touchmove', onPaneTouchMove, opts)
      pane.removeEventListener('touchend', onPaneTouchEnd, opts)
      pane.removeEventListener('touchcancel', onPaneTouchCancel, opts)
    }
  })

  useEffect(() => {
    const previouslyFocused =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null
    closeRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      // Restore focus to the EventCard (or whatever opened us). Guard
      // because the previously-focused node could have been removed
      // from the DOM by a re-render while the modal was open.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onClose])

  // iter-356.44 — bbox overlay during clip playback (canvas-on-video,
  // never pixel burn-in so the worker keeps `-c copy`). Events keep their
  // own per-modal toggle, but it is intentionally neutral so it does not read
  // like a recording/stop control over saved playback.
  //
  // iter-356.53 — bbox FOLLOWS the object: fetch the per-event
  // bbox-track sidecar (`/api/events/{id}/tracks`), bind the canvas
  // to `<video>.timeupdate`, and on each tick draw the closest-in-
  // time sample's boxes. Legacy clips have no sidecar (404) → fall
  // back to today's static `event.boxes` overlay.
  const [boxesVisible, setBoxesVisible] = useState(true)
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Track sidecar — null when not yet fetched OR 404 (legacy clip).
  // The per-clipUrl fetch fires once on mount + clipUrl change.
  const [trackFetch, setTrackFetch] = useState<{
    eventId: string | null
    tracks: EventTracks | null
    done: boolean
  }>({ eventId: null, tracks: null, done: false })
  useEffect(() => {
    if (clipErrored) return
    let cancelled = false
    fetchEventTracks(event.id)
      .then((t) => {
        if (!cancelled) {
          setTrackFetch({ eventId: event.id, tracks: t, done: true })
        }
      })
      .catch((e) => {
        // docs/logging_plan.md §2 (ClipModal): non-404 tracks fetch
        // fail WARN. fetchEventTracks returns null (not throws) on 404
        // — the expected legacy-clip path that lands in `.then`. So a
        // reject here is a genuine non-404 failure (5xx / network /
        // auth): the bbox overlay silently degrades to the static
        // event.boxes fallback, which looks like "no tracking" to the
        // user. Logged BEFORE the cancelled guard (§1.3).
        log.warn('clipModal:tracks-fetch-failed', {
          eventId: event.id,
          ...errFields(e),
        })
        if (!cancelled) {
          setTrackFetch({ eventId: event.id, tracks: null, done: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [event.id, clipErrored])
  const tracks = trackFetch.eventId === event.id ? trackFetch.tracks : null
  const tracksFetchDone = trackFetch.eventId === event.id && trackFetch.done
  const hasTimedTracks = tracks !== null && tracks.samples.length > 1
  const overlayKindLabel = tracksFetchDone ? (hasTimedTracks ? 'Tracked' : 'Static') : 'Checking'
  useEffect(() => {
    const canvas = overlayCanvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')
    const fallbackBoxes: DetectionBox[] = boxesVisible ? event.boxes : []
    // Playroom Modern (identity-colored boxes): `boxLabelName` generalizes
    // the old `event.person_name` fallback to also cover multi-person
    // events (first recognized name) and the "Someone" placeholder for a
    // detected-but-unrecognized person.
    const visibleName = boxesVisible ? boxLabelName : null
    // iter-356.59 — staleness window. If the latest sample is more
    // than this many seconds older than `currentTime`, treat it as
    // "no current detection" and clear the box. Without this, the
    // last pre-roll/event box would freeze on screen indefinitely
    // when the user scrubs into post-roll regions where no
    // detections occurred (the binary search clamps to the last
    // sample even when the gap is huge — looked like the bbox was
    // following the user's mouse instead of the object).
    //
    // 0.5s is roughly 2× the worker's active-gear inference period
    // (5 fps → 0.2s). At 0.5s a real detection would have produced
    // a follow-up sample; absence of one means the object left the
    // frame or the worker is in idle gear with nothing to track.
    const SAMPLE_STALENESS_S = 0.5
    // Pick the closest-in-time sample by binary search over
    // `samples` (server emits ascending by ts_offset_s).
    const pickBoxesAt = (currentTime: number): DetectionBox[] => {
      if (!boxesVisible) return []
      if (!tracks || tracks.samples.length === 0) return fallbackBoxes
      const samples = tracks.samples
      // Before the first sample's offset → no detection yet at this
      // time. (Avoids painting the first detection's box throughout
      // the entire pre-roll lead-in.)
      if (currentTime + SAMPLE_STALENESS_S < samples[0].ts_offset_s) {
        return []
      }
      let lo = 0
      let hi = samples.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (samples[mid].ts_offset_s <= currentTime) lo = mid
        else hi = mid - 1
      }
      const picked = samples[lo]
      // After the last sample → if the gap exceeds staleness, the
      // detection ended; clear the overlay rather than freezing.
      if (currentTime - picked.ts_offset_s > SAMPLE_STALENESS_S) {
        return []
      }
      return picked.boxes
    }
    const draw = () => {
      if (!ctx) return
      const t = video.currentTime || 0
      drawBoxes(ctx, canvas, video, pickBoxesAt(t), visibleName, { color: resolvedIdColor })
    }
    draw()

    // iter-356.59 (bbox per-frame + scrubber wiring fix):
    // ──────────────────────────────────────────────────────────────
    // PRE-FIX: the overlay redrew only on `timeupdate` events. The
    // browser fires that at ~4-5 Hz on most engines (Chrome 4 Hz,
    // Firefox 4 Hz, Safari 1 Hz on iOS Low Power Mode). At 30 fps
    // playback that means the box jumps in 6-7-frame chunks — what
    // the user reported as "not updating per frame." On scrub
    // (drag the seek bar), the box also lagged or froze because
    // `seeking`/`seeked` events were NOT handled — only `timeupdate`,
    // and the browser doesn't always fire timeupdate during a scrub
    // gesture (it fires after the seek completes).
    //
    // FIX A — `requestVideoFrameCallback`: Chromium/Safari/Edge ≥
    // M83/Sa15.4 expose a per-rendered-frame callback API. We re-
    // schedule the callback after every paint so the overlay redraws
    // exactly once per displayed video frame. Firefox doesn't have
    // it; we fall through to the timeupdate listener (still fires)
    // PLUS a `requestAnimationFrame` polling loop while playing.
    //
    // FIX B — `seeking` + `seeked` event listeners: when the user
    // grabs the native scrubber on the <video controls>, the seeking
    // event fires immediately and continues firing as they drag.
    // Listening here means the overlay tracks the scrubber in real
    // time across BOTH pre-roll AND post-roll regions, which is
    // what was broken.
    //
    // FIX C — also redraw on `play`/`pause` so the first paint after
    // a state change is always correct (rVFC stops firing on pause).
    // ──────────────────────────────────────────────────────────────
    type VideoWithRVFC = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    const v = video as VideoWithRVFC
    const hasRVFC = typeof v.requestVideoFrameCallback === 'function'
    let rvfcHandle: number | null = null
    let rafHandle: number | null = null

    const drawAndReschedule = () => {
      draw()
      if (hasRVFC && v.requestVideoFrameCallback) {
        rvfcHandle = v.requestVideoFrameCallback(drawAndReschedule)
      }
    }
    // Firefox fallback: rAF poll while playing.
    const rafTick = () => {
      if (video.paused || video.ended) {
        rafHandle = null
        return
      }
      draw()
      rafHandle = requestAnimationFrame(rafTick)
    }
    const onPlay = () => {
      if (hasRVFC && v.requestVideoFrameCallback) {
        if (rvfcHandle == null) {
          rvfcHandle = v.requestVideoFrameCallback(drawAndReschedule)
        }
      } else {
        if (rafHandle == null) rafHandle = requestAnimationFrame(rafTick)
      }
    }

    // iter-356.63 (mobile redesign Slice F): do NOT kick rVFC eagerly
    // on effect-mount. iOS Safari rejects unmuted autoplay; the loop
    // would draw onto a video with no first frame yet, sometimes
    // pinning a stale snapshot frame in the canvas. Defer the rVFC
    // start to the `play` event listener (`onPlay` above) so the
    // overlay only kicks off after the first decoded frame.

    // Even with rVFC, keep timeupdate as a defensive net for the
    // seek-without-play case (browser may not fire rVFC if no new
    // frame is being rendered).
    video.addEventListener('timeupdate', draw)
    video.addEventListener('loadedmetadata', draw)
    video.addEventListener('seeking', draw)
    video.addEventListener('seeked', draw)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', draw)
    video.addEventListener('ended', draw)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(draw)
      observer.observe(video)
    }
    return () => {
      video.removeEventListener('timeupdate', draw)
      video.removeEventListener('loadedmetadata', draw)
      video.removeEventListener('seeking', draw)
      video.removeEventListener('seeked', draw)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', draw)
      video.removeEventListener('ended', draw)
      if (rvfcHandle != null && v.cancelVideoFrameCallback) {
        v.cancelVideoFrameCallback(rvfcHandle)
      }
      if (rafHandle != null) cancelAnimationFrame(rafHandle)
      if (observer) observer.disconnect()
    }
  }, [event.boxes, boxLabelName, resolvedIdColor, clipUrl, boxesVisible, clipErrored, tracks])

  // Tri-state body content: video (default), snapshot fallback
  // (clip errored), empty state (both errored / no thumb).
  //
  // Bug fix (real-device Firefox Android): body is now ALWAYS rendered
  // inside a fixed aspect-video frame (see the wrapper below) instead
  // of sizing itself via max-w/max-h on the video's own intrinsic
  // dimensions — an unstarted <video> has no intrinsic size, so the
  // old approach let the whole pane collapse to nothing before
  // metadata loaded. `poster` gives the frame a real image the instant
  // it mounts; `fillHeight` makes VideoPlayer stretch into the frame
  // instead of sizing to content.
  let body: React.ReactNode
  if (!clipErrored && !clipMissing) {
    // jsx-a11y/media-has-caption requires a `<track>` child. Detection
    // clips have no captions (single-camera home-security context, no
    // dialogue or narration to caption); the empty `<track>` element
    // here satisfies the lint rule without adding fake captions.
    // Disable would also work but explicit is clearer.
    // iter (user "same as youtube"): the clip viewer now uses the custom
    // <VideoPlayer> (play/scrub/time + in-player speed menu + repeat +
    // fullscreen). VideoPlayer forwards its <video> element to `videoRef`, so
    // the bbox-overlay effect (which binds to the element's timeupdate/seek/
    // rVFC events) keeps working unchanged.
    const showPendingMessage = !videoReady && clipRecentlyCreated
    const showLoadingAffordance = !videoReady && !clipRecentlyCreated
    body = (
      <VideoPlayer
        key={clipUrl}
        src={clipUrl}
        poster={event.thumb_url ?? undefined}
        fillHeight
        ariaLabel={`Clip of ${event.person_name ?? event.label} event from ${humanCameraName(event.camera_id)}`}
        onVideoEl={handleVideoEl}
        preload="metadata"
        autoPlay
        nativeControls={!clipZoomed}
        controlsList="nofullscreen"
        onError={() => setErroredClipUrl(clipUrl)}
        showPlaybackSettings
        showFullscreenButton
        fullscreenActive={clipFullscreen}
        onFullscreenToggle={toggleClipFullscreen}
        containerClassName="w-full h-full rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] border border-[var(--color-border)]"
        videoClassName="w-full h-full object-contain"
        overlay={
          <>
            {/* iter-356.44: bbox overlay. pointer-events-none so the control
                bar stays clickable through the canvas. */}
            <canvas
              ref={overlayCanvasRef}
              data-testid="clip-bbox-canvas"
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none"
            />
            {event.boxes.length > 0 && (
              <button
                type="button"
                onClick={() => setBoxesVisible((v) => !v)}
                aria-label={`${boxesVisible ? 'Hide' : 'Show'} detection overlay (${overlayKindLabel.toLowerCase()})`}
                aria-pressed={boxesVisible}
                className={`pointer-events-auto absolute right-3 top-3 z-10 inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2 text-[11px] font-semibold text-white shadow-[var(--shadow-overlay)] backdrop-blur transition-colors hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 landscape-phone:right-2 landscape-phone:top-2 landscape-phone:h-8 landscape-phone:min-w-8 ${
                  boxesVisible
                    ? 'bg-black/65 ring-1 ring-white/30'
                    : 'bg-black/45 text-white/65 ring-1 ring-white/15'
                }`}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  {boxesVisible ? null : <path d="M5 5l14 14" />}
                </svg>
                <span className="hidden sm:inline">{overlayKindLabel}</span>
              </button>
            )}
            {/* Explicit pending/loading state so the frame never reads as
                broken while the browser is waiting for a fresh clip frame or
                a slow network is still fetching metadata. Mutually exclusive
                with the error branches below (those replace `body` entirely). */}
            {showPendingMessage && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 px-6 text-center"
              >
                <p className="text-sm text-white/90 max-w-xs">
                  Video is loading. It may take a moment after the clip becomes available.
                </p>
              </div>
            )}
            {showLoadingAffordance && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15"
              >
                <span
                  aria-hidden="true"
                  className="w-7 h-7 rounded-full border-2 border-white/25 border-t-white/85 animate-spin"
                />
                <span className="sr-only">Loading video…</span>
              </div>
            )}
          </>
        }
      />
    )
  } else if (event.thumb_url && !imgErrored) {
    body = (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-4 text-center landscape-phone:gap-0 landscape-phone:p-0">
        {/* Event-view jank fix (2026-07-08), tightened after live phone
            verification (2026-07-09): a 404 from the clip route is not proof
            that the recorder is still running. Keep polling fresh events, but
            phrase the UI around the evidence we actually have. */}
        <p role="status" className="text-sm text-white/85 max-w-xs landscape-phone:sr-only">
          {activeClipStatus?.state === 'recording' ||
          activeClipStatus?.state === 'finalizing' ||
          activeClipStatus?.state === 'failed'
            ? clipState.detail
            : !hasOwnClip
              ? 'No separate video was saved for this event. Check nearby events under "More from tonight" for overlapping footage.'
              : clipInRecheckWindow
                ? 'Video is not available yet. This app will keep checking for a short time and switch to playback if the clip appears.'
                : 'No video is available for this event. The snapshot below is the captured evidence.'}
        </p>
        <img
          src={event.thumb_url}
          alt={`Snapshot of ${event.person_name ?? event.label} event`}
          onError={() => setErroredImgUrl(event.thumb_url ?? null)}
          className="max-w-full max-h-[70%] rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] border border-[var(--color-border)] landscape-phone:h-full landscape-phone:max-h-full landscape-phone:w-full landscape-phone:object-contain landscape-phone:rounded-xl"
        />
      </div>
    )
  } else {
    body = (
      <div
        role="status"
        aria-live="polite"
        className="w-full h-full flex flex-col items-center justify-center text-center space-y-3 max-w-sm mx-auto px-4"
      >
        {/* redesign/warm-boutique: this state renders on the dark video
            pane — after the Sunroom token flip, text-primary/secondary
            are ink-on-black (invisible). Explicit dark-glass whites. */}
        <div className="mx-auto w-12 h-12 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-white/70 text-xl">
          ?
        </div>
        <p className="text-white">Clip unavailable</p>
        {/* Keep this cause-neutral: at this point neither the clip nor
            thumbnail is available, but the client cannot prove why. */}
        <p className="text-sm text-white/70 max-w-xs mx-auto">
          {activeClipStatus?.state === 'recording' ||
          activeClipStatus?.state === 'finalizing' ||
          activeClipStatus?.state === 'failed'
            ? clipState.detail
            : 'No video or snapshot is available for this event. It may appear after a refresh if the server has not finished publishing it yet.'}
        </p>
      </div>
    )
  }

  // iter-356.17 (Maya 11th CRITICAL #1): pre-iter-356.17 the modal
  // opened to a black void with zero context — no name, no time, no
  // camera, no face match. Now: a header bar shows what's playing
  // before the user even sees the video frame. aria-label promoted
  // to dynamic so SR users get parity with sighted users.
  const title = eventTitle(event)
  const timeLabel = `${clockTime(event.ts)} · ${humanCameraName(event.camera_id)}`
  const dialogLabel = `${title}, ${absoluteTime(event.ts)}`
  // `matchedNames` + `personLabel` now computed once, near the top of the
  // component (Playroom Modern identity plumbing) — the bbox-overlay
  // effect needs them too, so they moved up rather than being derived
  // twice from `event`.
  const matchConfidence =
    typeof event.score === 'number' && event.score > 0 ? Math.round(event.score * 100) : null
  // Content dedupe pass (Frank phone-round finding): the evidence pane
  // used to spell out this exact tier a second time inside a giant
  // "How sure" panel. Now it's a small chip near the title (below) and
  // the tier text lives in one place.
  const confidenceTier =
    event.score < 0.5
      ? 'Low confidence'
      : event.score < 0.75
        ? 'Medium confidence'
        : 'High confidence'

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      // iter-336 (a11y blocker #2): Tab focus trap. Pre-iter-336
      // Tab from the Close button left the modal entirely and
      // landed on whatever sat behind the backdrop (which was
      // aria-hidden but NOT inert). Now Tab/Shift-Tab cycles
      // within the focusable children of this dialog div.
      // (eslint-disable above: this is the WAI-ARIA standard
      // modal focus-trap pattern. role="dialog" containers
      // legitimately host onKeyDown for keyboard management;
      // the jsx-a11y rule is too strict for this specific case.)
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return
        const focusables = _focusablesIn(dialogRef.current)
        if (focusables.length === 0) return
        const active = document.activeElement as HTMLElement | null
        const idx = active ? focusables.indexOf(active) : -1
        if (e.shiftKey) {
          // Shift-Tab from the first → wrap to the last.
          if (idx <= 0) {
            e.preventDefault()
            focusables[focusables.length - 1].focus()
          }
        } else {
          // Tab from the last → wrap to the first.
          if (idx === focusables.length - 1) {
            e.preventDefault()
            focusables[0].focus()
          }
        }
      }}
      // Premium-launch slice (Maya Major): 160 ms scale 0.96 → 1 +
      // opacity 0 → 1 entrance. Pre-fix the heaviest modal in the
      // app popped onto the screen on a single render frame —
      // toasts slide, modals shouldn't. prefers-reduced-motion
      // global at index.css clamps to 0.01 ms × 1 iteration so
      // vestibular-sensitive users see the final state instantly.
      // Bug fix: stacked mobile layout can scroll instead of clipping.
      // Pre-fix this container had NO overflow rule, so once the
      // evidence <aside> below grew tall (e.g. "More from tonight"
      // rows), flexbox squeezed the sibling video-pane column — which
      // had `min-h-0` — all the way toward zero height, hiding the
      // header/video/action-row entirely. Scrolling the whole dialog
      // on mobile means excess content pushes into a scroll instead of
      // being crushed to nothing. lg+ keeps the fixed split-pane
      // layout (both columns are height-capped to the viewport there).
      // UI/UX overhaul 2026-07-07 (coherence MOBILE #1): landscape-phone
      // two-pane reflow, mirroring Watch.tsx's landscape-phone grid and
      // this modal's own lg: split. A rotated phone (landscape, height
      // <520px — the `landscape-phone` custom variant in index.css) used
      // to get the PORTRAIT stack: header → aspect-video strip
      // → evidence aside all scrolled vertically in a <400px-tall
      // viewport, squeezing the video to a narrow width-driven band.
      // Now landscape-phone reuses the lg shape: video pane docks left
      // at full pane height, evidence aside becomes the independently
      // scrolling right column. The mobile-collapse fixes (shrink-0
      // column + aspect-video frame, see comments below) stay intact
      // for portrait.
      className="fixed inset-0 z-40 flex flex-col lg:flex-row landscape-phone:flex-row tablet-landscape:flex-row overflow-y-auto lg:overflow-hidden landscape-phone:overflow-hidden tablet-landscape:overflow-hidden bg-black/95 backdrop-blur-sm pt-[max(2.25rem,env(safe-area-inset-top))] pb-[env(safe-area-inset-bottom)] animate-modal-in"
    >
      {/* iter-270 (accessibility-auditor A top-3): backdrop is a
          DIV with onClick + aria-hidden, NOT a button. Pre-iter-270
          the backdrop was a transparent <button> that VoiceOver
          landed on first and that intercepted swipes BEFORE the
          user could reach the video / Close button. The button was
          tabIndex={-1} but VO's swipe gesture still found it. div
          + aria-hidden + tabIndex omitted = invisible to AT and
          keyboard alike; the visible Close button is the only
          dismiss surface for SR users. Mouse + touch users still
          get backdrop-click-to-close via onClick. */}
      <div
        onClick={onClose}
        aria-hidden="true"
        data-testid="clip-backdrop"
        className="absolute inset-0 w-full h-full cursor-default"
      />
      {/* iter-356.58 (LAYOUT REBUILD): VIDEO PANE wrapper. On lg+
          this becomes the left flex-1 column; the evidence pane is
          its sibling on the right. On mobile both stack vertically. */}
      {/* Bug fix: was unconditionally `flex-1 min-h-0`, which let this
          WHOLE column (header + video) shrink to zero
          height whenever the evidence pane below grew past the
          available space. On mobile it's now `shrink-0` — sized to
          its own content, never crushed — and the dialog scrolls if
          the total is taller than the viewport. lg+ keeps `flex-1
          min-h-0` since the split-pane layout there needs this column
          to fill the remaining WIDTH within a height-capped row. */}
      {/* landscape-phone mirrors the lg treatment: this column fills
          the remaining width beside the evidence aside instead of
          sizing to content (the 58%-ish left pane of Watch.tsx's
          landscape grid, expressed here as flex-1 vs the aside's
          fixed 42%). */}
      <div className="relative flex flex-col shrink-0 lg:flex-1 lg:min-h-0 landscape-phone:flex-1 landscape-phone:min-h-0 tablet-landscape:flex-1 tablet-landscape:min-h-0 min-w-0">
      {/* iter-356.17 (Maya 11th CRITICAL #1): event-header bar.
          Title + camera + face-match badge + close-X. Lives ABOVE the
          video region so the user has context before the player even
          renders. Translucent so it doesn't fight the black-backdrop
          aesthetic of the modal. */}
      {/* iter-356.63 (Slice D a11y): was a <header> landmark, but
          this dialog is itself a landmark — nesting <header> inside
          role="dialog" makes the dismiss-X read as a "header banner"
          to AT users. Plain <div> + the visible <h2> below carry the
          same heading semantics without the bonus landmark. */}
      {/* redesign/warm-boutique: this header sits on the dark video
          pane — after the Sunroom token flip text-primary became ink
          (#292013) which vanished on black. Explicit dark-glass whites;
          per shared rule 2, over-video chrome keeps its dark glass. */}
      <div className="relative flex items-start justify-between gap-3 border-b border-white/10 bg-black/30 px-4 py-3 landscape-phone:px-3 landscape-phone:py-2 tablet-landscape:px-3 tablet-landscape:py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-white truncate landscape-phone:text-sm">
            {title}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-white/70 landscape-phone:gap-1.5">
            <span title={absoluteTime(event.ts)} className="tabular-nums">{timeLabel}</span>
            {personLabel && (
              // Solid success fill — the light-theme 12% tint
              // (success-bg) is unreadable over the dark pane. Label is
              // on-accent (white in light, ink on the dark theme's
              // glow-green — white on #5ec27f is ~1.9:1).
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--color-success)] text-[var(--color-on-accent)] font-medium">
                <span aria-hidden>●</span>
                <span>Recognized: {personLabel}</span>
              </span>
            )}
            {!personLabel && event.label && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-white/10 text-white/70 font-medium uppercase tracking-wide">
                {event.label}
              </span>
            )}
            {/* Content dedupe pass: this replaces the old giant "How
                sure" panel further down the evidence pane, which
                re-stated the exact same percentage + tier a second
                (sometimes third) time. One small pill, one place. */}
            {matchConfidence != null && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/10 text-white/70 font-medium">
                <span>{matchConfidence}%</span>
                <span aria-hidden>·</span>
                <span>{confidenceTier}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close clip viewer"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      {/* iter-342 (mobile G1 from iter-333 broad audit):
          overflow-hidden hard-caps the video region in landscape
          iOS Safari so the iter-331 control row is never pushed
          off-screen on a 667pt iPhone SE3 in landscape.
          Bug fix: `aspect-video` gives this frame a REAL height as
          soon as it mounts, driven by its own width — independent of
          whether the <video> inside has loaded metadata yet. Pre-fix
          this div was `flex-1 min-h-0` with no ratio, so an unstarted
          (zero-intrinsic-size) video left it with nothing to size
          against, and it collapsed toward zero along with everything
          else in this column. lg+ drops the ratio in favor of filling
          the height-capped row (`lg:flex-1 lg:aspect-auto
          lg:min-h-0`), matching the split-pane desktop layout. */}
      {/* UI/UX overhaul 2026-07-07 (hari GESTURE-5): the video pane is
          the swipe surface for flipping between "More from tonight"
          neighbors. touch-pan-y keeps native vertical scrolling alive
          while horizontal drags belong to the gesture; the axis lock in
          the handlers means a vertical scroll that starts here never
          becomes a swipe. */}
      <div
        ref={videoPaneRef}
        data-testid="clip-swipe-pane"
        // Event-view jank fix (2026-07-08): NO w-full here. w-full +
        // mx-4 is width:100% PLUS margins — the pane ran 16px past the
        // right screen edge on phones, clipping the video, the bbox
        // overlay and the boxes-toggle button, and giving the whole
        // modal a horizontal scrollbar. The flex-column parent's
        // default stretch already sizes the pane to full width MINUS
        // the margins.
          className={
            clipFullscreen
              ? 'fixed inset-0 z-[1100] m-0 flex h-[100dvh] w-screen touch-none items-center justify-center overflow-hidden rounded-none bg-black'
              : 'relative aspect-video lg:flex-1 lg:aspect-auto lg:min-h-0 landscape-phone:flex-1 landscape-phone:aspect-auto landscape-phone:self-stretch landscape-phone:h-auto landscape-phone:max-w-none landscape-phone:w-auto tablet-landscape:flex-1 tablet-landscape:aspect-auto tablet-landscape:self-stretch tablet-landscape:h-auto tablet-landscape:max-w-none tablet-landscape:w-auto flex items-center justify-center overflow-hidden touch-pan-y bg-black rounded-[var(--radius-2xl)] mx-4 mt-4 mb-2 lg:m-4 landscape-phone:m-2 landscape-phone:rounded-xl tablet-landscape:m-3 tablet-landscape:rounded-xl'
          }
      >
        {/* Zoom layer: pinch scales/pans THIS wrapper (video + its
            overlays together) while the pane above keeps translateX
            for the clip swipe — two transforms, two owners. */}
        <div
          ref={zoomLayerRef}
          data-testid="clip-zoom-layer"
          className="w-full h-full flex items-center justify-center will-change-transform"
        >
          {body}
        </div>
        <ClipStateBadge
          hasOwnClip={hasOwnClip}
          clipStatus={activeClipStatus}
          clipGone={clipGone}
          clipInRecheckWindow={clipInRecheckWindow}
        />
      </div>
      </div>
      {/* iter-356.58 (LAYOUT REBUILD) — EVIDENCE PANE.
          Right column on lg+, full-width section below the video on
          mobile. Structured WHO / WHEN / WHERE / HOW SURE so an
          incident review reads as actual evidence, not just a video
          with a close button. */}
      <aside
        aria-label="Incident details"
        // iter-356.67 (iPhone "horrible space at the bottom"):
        // measured via browser-harness on a 393×852 viewport — the
        // visible empty band below the last evidence section was
        // ~430 px aside vs ~250 px of content. Root cause: both
        // <aside> and the video column carried `flex-1`, so the
        // modal's flex-col container split 50/50 regardless of
        // content. The aside grew past its content and exposed the
        // gap. Fix: aside stays `shrink-0` (content-sized) so the
        // video column's `flex-1` consumes the remainder, leaving
        // the aside flush against the modal's pb-safe-area with no
        // internal dead space. Mobile bg dropped (was `bg-black/40`)
        // so the modal backdrop reads as one continuous surface.
        // redesign/warm-boutique: evidence pane is PAPER on every
        // viewport (was paper on lg only, white-on-black on mobile).
        // The video area above keeps its dark glass; the metadata
        // reads as a cream evidence card in both layouts.
        // UI/UX overhaul 2026-07-07 (coherence MOBILE #1): on
        // landscape-phone the aside becomes the right column. Keep it
        // narrower than the Watch page rail so the event video and
        // controls have enough short-viewport breathing room; lg keeps
        // its fixed w-80. It has its own scroll, side
        // border instead of top border.
        // Scroll fix (2026-07-09): in the two-pane layouts the aside
        // must be explicitly height-bounded, but the ASIDE is not the
        // scroller. Only the "More from tonight" clip list below
        // scrolls, so the WHEN/WHO context stays anchored.
        className="relative shrink-0 w-full min-w-0 lg:w-96 landscape-phone:w-[38%] tablet-landscape:w-[36%] lg:h-full landscape-phone:h-full tablet-landscape:h-full lg:min-h-0 landscape-phone:min-h-0 tablet-landscape:min-h-0 lg:flex landscape-phone:flex tablet-landscape:flex lg:flex-col landscape-phone:flex-col tablet-landscape:flex-col lg:overflow-hidden landscape-phone:overflow-hidden tablet-landscape:overflow-hidden lg:border-l landscape-phone:border-l tablet-landscape:border-l border-t lg:border-t-0 landscape-phone:border-t-0 tablet-landscape:border-t-0 border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)]"
      >
        {personLabel && (
          <div className="px-5 py-4 border-b border-[var(--color-border-subtle)] flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold">
                Who
              </div>
              {/* iter-357 (multi-person face-recog): when the event
                  matched several known faces, render every name
                  on its own line under the WHO eyebrow. The first
                  name keeps the iter-356 prominent display
                  treatment (font-display 3xl) so a single-person
                  event reads identically to pre-iter-357; extra
                  names render as a comma-separated subline so a
                  3-person event reads "Israel / & Sheenal & Coco"
                  (display weight + secondary line) without
                  overflowing the 320 px aside on desktop. */}
              <div className="font-display text-xl font-bold mt-0.5 capitalize break-words">
                {personLabel}
              </div>
              {matchedNames.length > 1 ? (
                <div className="mt-1 text-sm text-[var(--color-text-secondary)] capitalize break-words">
                  with {matchedNames.slice(1).join(' & ')}
                </div>
              ) : null}
            </div>
          </div>
        )}
        {/* Content dedupe pass (Frank phone-round finding): the header
            already states WHO/WHERE (title + timeLabel) and WHAT (label
            badge), and confidence now lives in the header chip above —
            this used to repeat all three facts a SECOND time via
            separate When/Where/What blocks, then repeat the confidence
            number a THIRD (sometimes fourth, via "Face match") time in
            a giant "How sure" panel. One compact line covers the one
            fact the header doesn't already spell out in full: the
            absolute date-time plus how long ago that was. */}
        <div className="px-5 py-4 border-b border-[var(--color-border-subtle)]">
          <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold">
            When
          </div>
          <div className="text-sm font-semibold mt-0.5 tabular-nums">
            {absoluteTime(event.ts)}
          </div>
          <div className="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            {relativeTime(event.ts, nowMs)}
          </div>
        </div>
        {/* Playroom Modern (Task 7): "More from tonight" — siblings within
            ±2h of the active event. Tapping a row swaps the WHOLE modal
            (video, evidence pane, and this rail itself) to that event
            via local `setEvent` — no parent involvement needed. */}
        {moreTonight && moreTonight.length > 0 && (
          <div className="px-5 py-4 space-y-2 lg:min-h-0 landscape-phone:min-h-0 lg:flex-1 landscape-phone:flex-1 lg:flex landscape-phone:flex lg:flex-col landscape-phone:flex-col">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold">
              More from tonight
            </div>
            <ul className="max-h-[min(45vh,28rem)] lg:max-h-none landscape-phone:max-h-none lg:flex-1 landscape-phone:flex-1 min-h-0 overflow-y-auto overscroll-contain touch-pan-y pr-1 space-y-1.5 list-none">
              {moreTonight.map((e) => (
                <li key={e.id}>
                  <MoreTonightRow
                    event={e}
                    subline={moreTonightSubline(e, event.camera_id, nowMs)}
                    onOpen={() => selectEvent(e)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  )
}

function MoreTonightRow({
  event,
  subline,
  onOpen,
}: {
  event: DetectionEvent
  subline: string
  onOpen: () => void
}) {
  const identity = identityOf(event)
  const color = resolveIdColor(identity)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-[var(--color-text-primary)] landscape-phone:text-xs">
          {eventTitle(event)}
        </span>
        <span className="block truncate text-xs text-[var(--color-text-secondary)] landscape-phone:text-[11px]">
          {subline}
        </span>
      </span>
      <span className="text-xs tabular-nums text-[var(--color-text-tertiary)] landscape-phone:text-[11px]">
        {clockTime(event.ts)}
      </span>
    </button>
  )
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

/** iter-336 (a11y blocker #2): list focusable descendants in DOM
 *  order so the Tab focus trap can cycle through them. Excludes
 *  disabled and tabIndex=-1 elements (the iter-335 roving-tabindex
 *  pattern hides un-selected radios from the Tab order via
 *  tabIndex=-1 — exclude those here so Tab skips them). */
function _focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  // <video controls> is intentionally NOT in this list. Real browsers
  // don't include it in the document Tab order without an explicit
  // `tabindex` — the native controls handle their own keyboard
  // navigation internally (Space = play/pause, arrow keys = seek).
  // Including it would put a non-focusable-via-Tab element in the
  // trap's cycle and break the wrap logic.
  const sel = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const all = Array.from(
    root.querySelectorAll<HTMLElement>(sel),
  )
  // Drop tabIndex=-1 (the iter-335 unselected radios). Don't filter
  // by offsetParent — jsdom always returns null and that would
  // exclude every element in tests.
  return all.filter((el) => el.getAttribute('tabindex') !== '-1')
}

// iter-345: _nextRadioIndex hoisted to `client/src/lib/a11y.ts` as
// `nextRovingIndex`. Same shape as iter-339's _nextChipIndex; both
// consumers now import from the shared module.
