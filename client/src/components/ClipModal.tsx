import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ZOOM_IDENTITY,
  isZoomed,
  panUpdate,
  pinchUpdate,
  toTransform,
  type ZoomState,
} from '../lib/pinchZoom'
import { deleteEvent, exportEvents, fetchEventTracks, searchEvents } from '../lib/api'
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
import { useConfirm } from '../lib/confirm'
import { useReportError, useToast } from '../lib/toast'
import type { DetectionBox, DetectionEvent, EventTracks } from '../lib/types'
import { EventRow } from './EventRow'
import { VideoPlayer } from './VideoPlayer'
import { Button } from './primitives/Button'

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
  onDeleted,
}: {
  event: DetectionEvent
  onClose: () => void
  // Final whole-branch review fix batch #1: ClipModal's own Delete
  // flow (below) removes the row from the SERVER, but had no way to
  // tell the parent list (Events.tsx / Watch.tsx's today-events feed)
  // to prune it — the parent kept rendering the just-deleted event
  // until its next unrelated refetch. Optional so pages that don't
  // hold their own list (none today, but keeps the prop non-breaking)
  // can omit it.
  onDeleted?: (id: string) => void
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
  if (eventProp.id !== syncedEventId) {
    setSyncedEventId(eventProp.id)
    setEvent(eventProp)
  }
  const navigate = useNavigate()
  const confirm = useConfirm()
  // Fix round (review finding): the Delete pill must not render for
  // non-owners — mirrors Events.tsx's isOwner gating (admin is a
  // transitional owner-equivalent, same carve-out as Settings.tsx's
  // isOwner). Derived here via useAuth() rather than threaded as a
  // prop: AuthProvider wraps the whole app (see App.tsx), so both of
  // ClipModal's call sites (Events.tsx, Watch.tsx) always have it in
  // context, and reading it locally avoids plumbing a prop through
  // both.
  const { user } = useAuth()
  const isOwner = user?.role === 'owner' || user?.role === 'admin'
  const clipUrl = `/api/events/${event.id}/clip`
  // Track which clip URL has errored. If the prop event changes
  // (parent passed a new event), `clipErrored` naturally becomes
  // false because `erroredClipUrl !== clipUrl`.
  const [erroredClipUrl, setErroredClipUrl] = useState<string | null>(null)
  const [erroredImgUrl, setErroredImgUrl] = useState<string | null>(null)
  const clipErrored = erroredClipUrl === clipUrl
  const imgErrored = !!event.thumb_url && erroredImgUrl === event.thumb_url

  // Bug fix (real-device Firefox Android, phone-verified): the clip
  // pane went completely blank on both fresh AND minutes-old events —
  // no player, no error, no thumb, no action row. Root cause was two
  // layered issues:
  //   1. An unstarted <video> has zero intrinsic size. With mobile
  //      autoplay blocked, the media pane collapsed toward nothing
  //      before metadata loaded, and `onError` never fires for a
  //      merely-slow/pending clip so neither fallback branch below
  //      ever kicked in.
  //   2. The video-pane flex column used `min-h-0` unconditionally,
  //      so once (1) shrank its content, the WHOLE column (header +
  //      video + action row) could be squeezed toward zero height by
  //      its sibling (the evidence <aside>, which has no cap on its
  //      own natural height once "More from tonight" grew it).
  // `videoReady` (wired up below, once `videoRef` exists) tracks
  // whether THIS clip's element has actually produced a frame
  // (loadeddata/canplay), independent of error state, so the render
  // below can show an explicit pending/loading affordance instead of
  // an empty pane while playback catches up.
  const [readyClipUrl, setReadyClipUrl] = useState<string | null>(null)
  const videoReady = readyClipUrl === clipUrl

  // Ticks every 5s so both the "is this clip still being written"
  // pending-state gate below AND the WHEN/"More from tonight" relative
  // timestamps stay fresh for as long as the modal stays open.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  // Post-roll recording typically finishes within ~90s of the
  // detection firing (docs/logging_plan.md recorder notes) — under
  // that, an unplayable clip almost certainly just isn't written yet
  // rather than actually broken.
  const clipLikelyWriting = nowMs / 1000 - event.ts < 100

  // iter-270 (accessibility-auditor A): stash the element that had
  // focus when the modal opened so we can restore it on close.
  // Without this, ESC / Close / backdrop click leaves focus on
  // <body>, and the screen-reader rotor reads from the top of the
  // page on the next interaction. Mirror of the iter-? confirm-
  // dialog focus-restore (also added this iter).
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // iter-331 (missing-feature #1, ClipModal speed + loop): user
  // wants 0.5x for "is that really a person?" review. Native browser
  // controls expose speed on desktop Chrome but NOT on mobile Chrome
  // / Safari — the speed strip below covers the mobile gap. Loop
  // toggle for "watch the dog walk past again" without re-tapping.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // VideoPlayer hands us its <video> element here; store it in our own ref so
  // the bbox-overlay effect can bind to it. Memoized so VideoPlayer's
  // forwarding effect doesn't re-fire every render.
  const handleVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el
  }, [])
  // Wires up `videoReady` (declared above) now that `videoRef` exists.
  // Runs after VideoPlayer's own `onVideoEl` effect populates the ref —
  // React commits child effects before parent effects, the same
  // ordering the bbox-overlay effect below already relies on.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const markReady = () => setReadyClipUrl(clipUrl)
    video.addEventListener('loadeddata', markReady)
    video.addEventListener('canplay', markReady)
    return () => {
      video.removeEventListener('loadeddata', markReady)
      video.removeEventListener('canplay', markReady)
    }
  }, [clipUrl])
  // iter-336 (a11y blocker #2): focus-trap host. Tab cycles within
  // focusable descendants of this div instead of escaping to the
  // browser chrome / page behind the modal.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // iter (user "same as youtube"): playback speed, loop, best-effort
  // autoplay, scrub/play and fullscreen are now owned by the <VideoPlayer>
  // control bar. ClipModal keeps `videoRef` ONLY so its bbox-overlay effect
  // can attach to the <video> element (VideoPlayer forwards it).
  const { showToast } = useToast()
  // docs/logging_plan.md §1.3: pair error-toasts with a structured
  // log.error so the user message + device log can't drift.
  const reportError = useReportError()
  // iter-330 (missing-feature #3, Event Export ZIP): per-event
  // download button. Posts the single event id to /api/events/export
  // and triggers the browser's download flow via createObjectURL.
  // Multi-select export is a follow-up (iter-331+) once the EventList
  // has a selection mechanism; the per-event path is the foundation.
  const [downloading, setDownloading] = useState(false)
  const onDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const blob = await exportEvents([event.id])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // Use the event id + timestamp so multiple downloads don't clobber.
      a.download = `homecam_${event.id}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Defer revoke so Safari has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('Download started', 'success')
    } catch (e) {
      // docs/logging_plan.md §2 (ClipModal): export fail ERROR — the
      // HTTP status was discarded today (toast-only). reportError pairs
      // the user toast with a structured log.error carrying the status
      // (413 over-cap / 503 semaphore / 401) so the operator sees WHY.
      reportError(
        'clipModal:export-failed',
        e instanceof Error ? `Download failed: ${e.message}` : 'Download failed',
        { eventId: event.id, ...errFields(e) },
      )
    } finally {
      setDownloading(false)
    }
  }
  // iter-356.x (feature audit P1-5): copy a deep-link to this event for
  // sharing. The clip URL itself is auth-gated so a raw link won't work
  // for un-authed recipients, but copying /events?event=<id> lets a
  // household member paste it into the same authed PWA on the other
  // person's phone — which is the common case (e.g., "look at this
  // delivery"). navigator.share is preferred where available (Android
  // Chrome, iOS Safari 16.4+ standalone) so the OS share sheet handles
  // routing; falls back to clipboard.
  const onShare = async () => {
    const path = `/events?event=${encodeURIComponent(event.id)}`
    const url = `${window.location.origin}${path}`
    const title = personLabel ?? event.label
    const text = `HomeCam event: ${title}`
    try {
      const nav = navigator as Navigator & {
        share?: (data: ShareData) => Promise<void>
      }
      if (typeof nav.share === 'function') {
        await nav.share({ title, text, url })
        return
      }
      await navigator.clipboard.writeText(url)
      showToast('Link copied — paste it into a chat to share', 'success')
    } catch (e) {
      // AbortError is the user dismissing the share sheet — silent.
      const name = (e as Error)?.name
      if (name === 'AbortError') return
      // docs/logging_plan.md §2 (ClipModal): share/clipboard fail WARN.
      // Distinguishes a clipboard-permission denial / share-sheet
      // failure from the benign user-dismiss above.
      log.warn('clipModal:share-failed', { eventId: event.id, ...errFields(e) })
      showToast('Could not share link — try copy/paste', 'error')
    }
  }

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
        setMoreTonight(r.items.filter((e) => e.id !== event.id).slice(0, 5))
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
  // Pinch-to-zoom (user request 2026-07-07, mirrors Watch's fullscreen
  // zoom): two fingers scale the INNER zoom layer (video + overlays),
  // one finger pans while zoomed, and the clip-swipe gesture is
  // suppressed until the zoom glides back to 1x — otherwise a pan
  // would also flip clips. The zoom layer is separate from the pane so
  // the swipe's translateX and the zoom's transform never fight over
  // one style property. All math in lib/pinchZoom (unit-tested pure).
  const zoomLayerRef = useRef<HTMLDivElement | null>(null)
  const zoomRef = useRef<ZoomState>(ZOOM_IDENTITY)
  const pinchDist = useRef(0)
  const panLast = useRef<{ x: number; y: number } | null>(null)
  const applyClipZoom = () => {
    const el = zoomLayerRef.current
    if (el) el.style.transform = toTransform(zoomRef.current)
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
    const el = zoomLayerRef.current
    if (el) el.style.transform = ''
    const pane = videoPaneRef.current
    if (pane) pane.style.touchAction = ''
  }, [])
  // A different clip is a fresh viewing context — zoom starts at 1x.
  useEffect(() => {
    resetClipZoom()
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
  const pinchDistanceOf = (ev: React.TouchEvent) => {
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
  const onPaneTouchStart = (ev: React.TouchEvent) => {
    // Second finger down: the gesture becomes a pinch regardless of
    // what the first finger was doing; any in-flight swipe feedback is
    // abandoned.
    if (ev.touches.length >= 2) {
      pinchDist.current = pinchDistanceOf(ev)
      panLast.current = null
      resetSwipeRefs()
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
    const target = ev.target as HTMLElement | null
    if (target && target.closest('button, select, input, a, label')) return
    const t = ev.touches[0]
    // Zoomed in: one finger pans the picture; clip-swipe stays off
    // until the pinch glides back home to 1x.
    if (isZoomed(zoomRef.current)) {
      panLast.current = { x: t.clientX, y: t.clientY }
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
  const onPaneTouchMove = (ev: React.TouchEvent) => {
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
  const onPaneTouchEnd = (ev: React.TouchEvent) => {
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
      setEvent(neighbor)
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

  // Playroom Modern (Task 7): "Name them" — persons only, and only when
  // unrecognized (a named person already has a name; nothing to do).
  // Reuses the EXISTING uncertain-face review flow rather than inventing
  // a new naming affordance — `/training/review` (Review.tsx) is where an
  // operator confirms/corrects a predicted name from a face capture.
  // Content pain-fix batch: append the event id as a query param so a
  // future queue implementation CAN pre-filter to this event's face
  // capture. Deep queue integration is out of scope here — the review
  // flow itself doesn't consume the param yet.
  const onNameThem = () => {
    navigate(`/training/review?event=${encodeURIComponent(event.id)}`)
  }

  const [deleting, setDeleting] = useState(false)
  const onDelete = async () => {
    if (!isOwner || deleting) return
    const ok = await confirm({
      title: 'Delete this event?',
      body: `Delete the ${clockTime(event.ts)} ${personLabel ?? event.label} event? The clip will be removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      await deleteEvent(event.id)
      showToast('Event deleted', 'success')
      onDeleted?.(event.id)
      onClose()
    } catch (e) {
      reportError(
        'clipModal:delete-failed',
        e instanceof Error ? `Could not delete event: ${e.message}` : 'Could not delete event',
        { eventId: event.id, ...errFields(e) },
      )
    } finally {
      setDeleting(false)
    }
  }

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
  // never pixel burn-in so the worker keeps `-c copy`). Shares the
  // `homecam:boxesVisible` localStorage key with VideoTile.
  //
  // iter-356.53 — bbox FOLLOWS the object: fetch the per-event
  // bbox-track sidecar (`/api/events/{id}/tracks`), bind the canvas
  // to `<video>.timeupdate`, and on each tick draw the closest-in-
  // time sample's boxes. Legacy clips have no sidecar (404) → fall
  // back to today's static `event.boxes` overlay.
  const [boxesVisible, setBoxesVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const stored = window.localStorage.getItem('homecam:boxesVisible')
    return stored === null ? true : stored === '1'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('homecam:boxesVisible', boxesVisible ? '1' : '0')
  }, [boxesVisible])
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // Track sidecar — null when not yet fetched OR 404 (legacy clip).
  // The per-clipUrl fetch fires once on mount + clipUrl change.
  const [tracks, setTracks] = useState<EventTracks | null>(null)
  useEffect(() => {
    if (clipErrored) return
    let cancelled = false
    fetchEventTracks(event.id)
      .then((t) => {
        if (!cancelled) setTracks(t)
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
        if (!cancelled) setTracks(null)
      })
    return () => {
      cancelled = true
    }
  }, [event.id, clipErrored])
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
  if (!clipErrored) {
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
    const showPendingMessage = !videoReady && clipLikelyWriting
    const showLoadingAffordance = !videoReady && !clipLikelyWriting
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
        onError={() => setErroredClipUrl(clipUrl)}
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
            {/* Bbox visibility toggle — TOP-right so it clears the bottom
                control bar (was bottom-right under native controls). */}
            {event.boxes.length > 0 && (
              <button
                type="button"
                onClick={() => setBoxesVisible((v) => !v)}
                aria-label={boxesVisible ? 'Hide detection boxes' : 'Show detection boxes'}
                aria-pressed={boxesVisible}
                className={`pointer-events-auto absolute top-3 right-3 z-10 flex items-center justify-center w-11 h-11 backdrop-blur rounded-full text-white hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                  boxesVisible ? 'bg-[var(--color-accent-deep)]' : 'bg-black/60'
                }`}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  {boxesVisible ? null : <path d="M4 4l16 16" />}
                </svg>
              </button>
            )}
            {/* Bug fix: explicit pending/loading state so the frame
                never reads as broken while a fresh clip's post-roll is
                still being written (~90s typical) or a slow network is
                still fetching metadata. Mutually exclusive with the
                error branches below (those replace `body` entirely). */}
            {showPendingMessage && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 px-6 text-center"
              >
                <p className="text-sm text-white/90 max-w-xs">
                  Video not ready yet: it&apos;s still being saved.
                  This usually takes under two minutes.
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
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-4 text-center">
        {/* iter-347 (Frank B1): bumped to text-sm + clearer copy.
            Pre-iter-347 the amber-on-black 12px text was barely
            readable AND ambiguous about user action ("loading?
            broken? wait?"). */}
        {/* redesign/warm-boutique: raw `text-amber-200` dropped — this
            note sits on the dark video pane, so plain soft white reads
            better than an off-palette amber. */}
        <p className="text-sm text-white/85 max-w-xs">
          Video not ready yet: here&apos;s a still photo from the event.
          Check back in a few seconds.
        </p>
        <img
          src={event.thumb_url}
          alt={`Snapshot of ${event.person_name ?? event.label} event`}
          onError={() => setErroredImgUrl(event.thumb_url ?? null)}
          className="max-w-full max-h-[70%] rounded-[var(--radius-2xl)] shadow-[var(--shadow-overlay)] border border-[var(--color-border)]"
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
        {/* iter-356.16 (Frank Round-5 D1): "worker" + "pruned" jargon
            stripped. Frank: "My wife asked me what a worker was and
            she thought I was asking about her shift schedule." */}
        <p className="text-sm text-white/70 max-w-xs mx-auto">
          This video isn&apos;t available yet — it may still be saving,
          or it&apos;s been removed automatically to save space. Try
          again in a moment.
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
      // to get the PORTRAIT stack: header → aspect-video strip → actions
      // → evidence aside all scrolled vertically in a <400px-tall
      // viewport, squeezing the video to a narrow width-driven band.
      // Now landscape-phone reuses the lg shape: video pane docks left
      // at full pane height, evidence aside becomes the independently
      // scrolling right column. The mobile-collapse fixes (shrink-0
      // column + aspect-video frame, see comments below) stay intact
      // for portrait.
      className="fixed inset-0 z-40 flex flex-col lg:flex-row landscape-phone:flex-row overflow-y-auto lg:overflow-hidden landscape-phone:overflow-hidden bg-black/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] animate-modal-in"
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
          WHOLE column (header + video + action row) shrink to zero
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
      <div className="relative flex flex-col shrink-0 lg:flex-1 lg:min-h-0 landscape-phone:flex-1 landscape-phone:min-h-0 min-w-0">
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
      <div className="relative flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b border-white/10 bg-black/30">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-white truncate">
            {title}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-white/70">
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
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close clip viewer"
          className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
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
        onTouchStart={onPaneTouchStart}
        onTouchMove={onPaneTouchMove}
        onTouchEnd={onPaneTouchEnd}
        onTouchCancel={onPaneTouchCancel}
        className="relative w-full aspect-video lg:flex-1 lg:aspect-auto lg:min-h-0 landscape-phone:flex-1 landscape-phone:aspect-auto landscape-phone:min-h-0 flex items-center justify-center overflow-hidden touch-pan-y bg-black rounded-[var(--radius-2xl)] mx-4 mt-4 mb-2 lg:m-4 landscape-phone:mx-3 landscape-phone:mt-2 landscape-phone:mb-1"
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
      </div>
      {/* Playback speed, repeat, scrub/play and fullscreen now live IN the
          VideoPlayer control bar (the user's "same as youtube"), so the old
          pill strip below the video is gone. */}
      {/* iter-356.3b (Maya iter-356.2 Critical 3 deferred): action-bar
          inversion fix.
          iter-356.63 (Slice D a11y): the duplicate "Close" button at
          the bottom (and the desktop-only X in the evidence pane)
          were both dropped. The header X (top-right) is now the
          single dismiss surface and receives focus on open via
          closeRef. AT users no longer encounter "Close clip viewer,
          Close clip viewer, Close" three times in a row. Save clip
          uses Button primitive's loading state (Maya iter-356.2
          Major: "this is exactly what the primitive was built for"). */}
      {/* Fix wave F3 (accepted audit finding): the 4-pill row (Share +
          Save clip + Name them + Delete) overflows a 360px viewport —
          measured ~379px of pills vs ~328px of available width, no
          wrap, and Share got pushed fully off-screen with no scroll
          affordance. `flex-wrap` lets the row break to a second line
          instead of overflowing; `justify-end` is kept so a wrapped
          row still hugs the right edge like the single-row layout
          did. gap-y bumped slightly above gap-x so two wrapped rows
          don't feel cramped against each other. */}
      <div className="relative px-4 pb-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {/* redesign/warm-boutique: this row sits on the modal's dark
            pane — the ghost variant's umber text fails contrast on
            black, so Share is an explicit over-video dark-glass
            control (same treatment as the VideoPlayer buttons).
            Save clip stays on the Button primitive for its loading
            state; its paper secondary fill reads clearly on black. */}
        <button
          type="button"
          onClick={onShare}
          aria-label="Share or copy link to this event"
          className="inline-flex items-center justify-center h-10 min-w-[44px] px-4 rounded-full text-sm font-medium text-white/90 hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-[var(--color-accent-bright)] focus-visible:outline-offset-2 transition-colors"
        >
          Share
        </button>
        <Button
          variant="secondary"
          size="md"
          onClick={onDownload}
          loading={downloading}
          loadingText="Preparing…"
          aria-label={
            downloading
              ? 'Preparing download…'
              : 'Save clip as ZIP (clip + thumbnail + metadata)'
          }
        >
          Save clip
        </Button>
        {/* Playroom Modern (Task 7): "Name them" — persons only, and only
            when the camera couldn't put a name to the face (a named person
            has nothing left to name). Reuses the existing uncertain-face
            review flow instead of inventing a new one. */}
        {identity.kind === 'person' && (
          <Button variant="secondary" size="md" onClick={onNameThem}>
            Name them
          </Button>
        )}
        {/* Fix round (review finding): parity with Events.tsx, which hides
            delete affordances entirely for non-owners (isOwner gating
            around lines 704/1384) rather than just disabling the handler.
            Delete must not render for non-owner sessions. */}
        {isOwner && (
          <Button
            variant="destructive"
            size="md"
            loading={deleting}
            loadingText="Deleting…"
            onClick={onDelete}
            aria-label={`Delete this ${personLabel ?? event.label} event`}
          >
            Delete
          </Button>
        )}
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
        // landscape-phone the aside becomes the right column —
        // proportional 42% (mirroring Watch.tsx's 58%/1fr landscape
        // split; lg keeps its fixed w-80) with its own scroll, side
        // border instead of top border.
        className="relative shrink-0 w-full lg:w-80 landscape-phone:w-[42%] lg:border-l landscape-phone:border-l border-t lg:border-t-0 landscape-phone:border-t-0 border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] overflow-y-auto overscroll-contain"
      >
        {personLabel && (
          <div className="px-5 py-4 border-b border-[var(--color-border-subtle)] flex items-start justify-between gap-3">
            <div>
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
              <div className="font-display text-xl font-bold mt-0.5 capitalize">
                {personLabel}
              </div>
              {matchedNames.length > 1 ? (
                <div className="mt-1 text-sm text-[var(--color-text-secondary)] capitalize">
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
          <div className="px-5 py-4 space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--color-brass-default)] font-semibold">
              More from tonight
            </div>
            <ul className="space-y-1.5 list-none">
              {moreTonight.map((e) => (
                <li key={e.id}>
                  <EventRow
                    event={e}
                    subline={moreTonightSubline(e, event.camera_id, nowMs)}
                    onOpen={() => setEvent(e)}
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
