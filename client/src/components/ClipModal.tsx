import { useEffect, useRef, useState } from 'react'
import { nextRovingIndex } from '../lib/a11y'
import { exportEvents, fetchEventTracks } from '../lib/api'
import { drawBoxes } from '../lib/drawBoxes'
import {
  absoluteTime,
  clockTime,
  eventTitle,
  humanCameraName,
} from '../lib/eventLabel'
import { useToast } from '../lib/toast'
import type { DetectionBox, DetectionEvent, EventTracks } from '../lib/types'
import { Button } from './primitives/Button'

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
  event,
  onClose,
}: {
  event: DetectionEvent
  onClose: () => void
}) {
  const clipUrl = `/api/events/${event.id}/clip`
  // Track which clip URL has errored. If the prop event changes
  // (parent passed a new event), `clipErrored` naturally becomes
  // false because `erroredClipUrl !== clipUrl`.
  const [erroredClipUrl, setErroredClipUrl] = useState<string | null>(null)
  const [erroredImgUrl, setErroredImgUrl] = useState<string | null>(null)
  const clipErrored = erroredClipUrl === clipUrl
  const imgErrored = !!event.thumb_url && erroredImgUrl === event.thumb_url

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
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  const [loop, setLoop] = useState<boolean>(false)
  // iter-335 (a11y blocker #1): roving-tabindex refs for the speed
  // radiogroup. Each pill registers itself into this array via the
  // `ref={el => speedPillRefs.current[idx] = el}` callback so the
  // keydown handler can call `.focus()` on the next/prev pill after
  // arrow-key navigation.
  const speedPillRefs = useRef<Array<HTMLButtonElement | null>>([])
  // iter-336 (a11y blocker #2): focus-trap host. Tab cycles within
  // focusable descendants of this div instead of escaping to the
  // browser chrome / page behind the modal.
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Apply playbackRate to the live <video> element whenever it
  // changes. Using a ref + effect (instead of a `playbackRate` prop
  // which React doesn't have) is the canonical pattern.
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate
    }
    // iter-342 (perf B1 from iter-333 broad audit): drop `clipUrl`
    // from deps. The `<video key={clipUrl}>` remount already resets
    // playbackRate to 1 (default), so re-applying the rate on
    // clipUrl change was redundant. Effect now fires only on actual
    // playbackRate change.
  }, [playbackRate])
  // iter-356.56 (mobile audit C2): best-effort autoplay.
  // Replaces the `autoPlay` attribute that iOS Safari silently ignored
  // for unmuted video re-mounted via React `key=`. Calling .play()
  // imperatively from this effect runs in the same tick as the modal
  // mount and inherits the user-gesture activation token from the
  // tap that opened the modal. iOS Safari still rejects unmuted
  // .play() in many cases — that's expected; the native controls
  // surface the play button. The promise reject is swallowed so
  // it doesn't show up in dev console as an unhandled rejection.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const p = v.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        /* iOS unmuted autoplay rejected — user taps native play. */
      })
    }
  }, [clipUrl])
  const { showToast } = useToast()
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
      showToast(
        e instanceof Error
          ? `Download failed: ${e.message}`
          : 'Download failed',
        'error',
      )
    } finally {
      setDownloading(false)
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
      .catch(() => {
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
    const visibleName = boxesVisible ? event.person_name ?? null : null
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
      drawBoxes(ctx, canvas, video, pickBoxesAt(t), visibleName)
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
  }, [event.boxes, event.person_name, clipUrl, boxesVisible, clipErrored, tracks])

  // Tri-state body content: video (default), snapshot fallback
  // (clip errored), empty state (both errored / no thumb).
  let body: React.ReactNode
  if (!clipErrored) {
    // jsx-a11y/media-has-caption requires a `<track>` child. Detection
    // clips have no captions (single-camera home-security context, no
    // dialogue or narration to caption); the empty `<track>` element
    // here satisfies the lint rule without adding fake captions.
    // Disable would also work but explicit is clearer.
    body = (
      <div className="relative max-w-full max-h-full">
        {/* iter-356.56 (mobile audit C2): dropped `autoPlay`. iOS
            Safari 16.x silently refuses autoplay on unmuted video
            unless the play() call lands synchronously inside a user
            gesture. The tap that opened this modal IS a user gesture
            but the async `key={clipUrl}` remount + load fires AFTER
            the gesture context closes. Result on iOS: frozen first
            frame, native play button, no audio prompt visible at
            first glance. The ref-driven .play() in the effect below
            is best-effort — succeeds on Chrome/Firefox/desktop, falls
            back to the native play button on iOS where it correctly
            requires a tap. */}
        <video
          ref={videoRef}
          key={clipUrl}
          src={clipUrl}
          controls
          playsInline
          loop={loop}
          onError={() => setErroredClipUrl(clipUrl)}
          aria-label={`Clip of ${event.person_name ?? event.label} event from ${humanCameraName(event.camera_id)}`}
          className="max-w-full max-h-full rounded-xl shadow-2xl border border-[var(--color-border)] bg-black"
        >
          <track kind="captions" />
        </video>
        {/* iter-356.44: bbox overlay. pointer-events-none so the
            native <video> controls (play/pause/scrub/fullscreen) stay
            clickable through the canvas. data-testid for unit tests. */}
        <canvas
          ref={overlayCanvasRef}
          data-testid="clip-bbox-canvas"
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none rounded-xl"
        />
        {/* iter-356.44: bbox visibility toggle, mirror of the
            VideoTile button. Same localStorage key + same
            aria-pressed semantics so a screen-reader user gets a
            consistent affordance across live + recorded surfaces. */}
        {event.boxes.length > 0 && (
          <button
            type="button"
            onClick={() => setBoxesVisible((v) => !v)}
            aria-label={boxesVisible ? 'Hide detection boxes' : 'Show detection boxes'}
            aria-pressed={boxesVisible}
            className={`absolute bottom-3 right-3 flex items-center justify-center w-11 h-11 backdrop-blur rounded-full text-white hover:bg-black/75 active:bg-black/85 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
              boxesVisible ? 'bg-[var(--color-accent-default)]/70' : 'bg-black/60'
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
      </div>
    )
  } else if (event.thumb_url && !imgErrored) {
    body = (
      <div className="text-center space-y-3 max-w-md">
        {/* iter-347 (Frank B1): bumped to text-sm + clearer copy.
            Pre-iter-347 the amber-on-black 12px text was barely
            readable AND ambiguous about user action ("loading?
            broken? wait?"). */}
        <p className="text-sm text-amber-300">
          Video not ready yet — here&apos;s a still photo from the event.
          Check back in a few seconds.
        </p>
        <img
          src={event.thumb_url}
          alt={`Snapshot of ${event.person_name ?? event.label} event`}
          onError={() => setErroredImgUrl(event.thumb_url ?? null)}
          className="max-w-full max-h-[60vh] mx-auto rounded-xl shadow-2xl border border-[var(--color-border)]"
        />
      </div>
    )
  } else {
    body = (
      <div
        role="status"
        aria-live="polite"
        className="text-center space-y-3 max-w-sm"
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] flex items-center justify-center text-[var(--color-text-tertiary)] text-xl">
          ?
        </div>
        <p className="text-[var(--color-text-primary)]">Clip unavailable</p>
        {/* iter-356.16 (Frank Round-5 D1): "worker" + "pruned" jargon
            stripped. Frank: "My wife asked me what a worker was and
            she thought I was asking about her shift schedule." */}
        <p className="text-sm text-[var(--color-text-secondary)] max-w-xs mx-auto">
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
  const personLabel = event.person_name ? event.person_name : null
  const matchConfidence =
    typeof event.score === 'number' && event.score > 0 ? Math.round(event.score * 100) : null

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
      className="fixed inset-0 z-40 flex flex-col lg:flex-row bg-black/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
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
      <div className="relative flex-1 flex flex-col min-h-0 min-w-0">
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
      <div className="relative flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b border-white/10 bg-black/30">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] truncate">
            {title}
          </h2>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <span title={absoluteTime(event.ts)}>{timeLabel}</span>
            {personLabel && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--color-success-bg)] text-[var(--color-success)] font-medium">
                <span aria-hidden>●</span>
                <span>
                  Recognized: {personLabel}
                  {matchConfidence != null ? ` · ${matchConfidence}%` : ''}
                </span>
              </span>
            )}
            {!personLabel && event.label && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-white/10 text-[var(--color-text-secondary)] font-medium uppercase tracking-wide">
                {event.label}
              </span>
            )}
          </div>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close clip viewer"
          className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-white/10 active:bg-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
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
          off-screen on a 667pt iPhone SE3 in landscape. min-h-0
          + flex-1 chain is what makes max-h-full inside <video>
          resolve correctly. */}
      <div className="relative flex-1 flex items-center justify-center p-4 min-h-0 overflow-hidden">
        {body}
      </div>
      {/* iter-331: playback speed + loop. Only render when the clip
          is actually playing (not the snapshot fallback or empty
          state — those don't have a playbackRate to set). The
          speed pills are role="radiogroup" so a screen reader
          announces "1 of 3 selected" on focus.
          iter-335 (a11y blocker #1): roving-tabindex pattern so
          ArrowLeft/Right + Home/End move BOTH selection and focus
          per the WAI-ARIA Authoring Practices radiogroup spec.
          Pre-iter-335 NVDA users heard "tab list" but arrows did
          nothing; only Tab worked, eating 3 stops. Post-iter-335
          only the selected pill is in the Tab order; arrow keys
          cycle within the group and Tab moves to the next widget. */}
      {!clipErrored && (
        <div className="relative px-4 pb-2 flex items-center justify-center gap-2 flex-wrap">
          <div
            role="radiogroup"
            aria-label="Playback speed"
            // tabIndex={-1} satisfies jsx-a11y/interactive-supports-focus
            // for the container (which has onKeyDown). The container is
            // NOT in the Tab order; the roving-tabindex on the inner
            // radios IS — arrow keys move within, Tab moves out, per
            // the WAI-ARIA radiogroup pattern.
            tabIndex={-1}
            className="flex gap-1 bg-white/10 rounded-full p-1 border border-white/15"
            onKeyDown={(e) => {
              const idx = SPEED_RATES.indexOf(playbackRate)
              if (idx === -1) return
              const next = nextRovingIndex(e.key, idx, SPEED_RATES.length)
              if (next === null) return
              e.preventDefault()
              setPlaybackRate(SPEED_RATES[next])
              // requestAnimationFrame: tabIndex flips in next paint
              // before .focus() so the browser doesn't refuse to
              // focus a tabIndex=-1 element.
              requestAnimationFrame(() => {
                speedPillRefs.current[next]?.focus()
              })
            }}
          >
            {SPEED_RATES.map((rate, idx) => (
              <button
                key={rate}
                ref={(el) => {
                  speedPillRefs.current[idx] = el
                }}
                type="button"
                role="radio"
                aria-checked={playbackRate === rate}
                tabIndex={playbackRate === rate ? 0 : -1}
                onClick={() => setPlaybackRate(rate)}
                className={`min-w-[44px] min-h-[44px] px-3 py-1.5 rounded-full text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
                  playbackRate === rate
                    ? 'bg-white text-black'
                    : 'text-[var(--color-text-primary)]/80 hover:text-[var(--color-text-primary)] active:text-[var(--color-text-primary)]'
                }`}
              >
                {/* iter-347 (Frank D1): "Slow"/"Normal"/"Fast"
                    visible labels — Frank reads "0.5×" as "zero
                    point five ex". The numeric is preserved for
                    SR users via the radiogroup aria-label and the
                    iter-? aria-checked semantics. */}
                {rate === 0.5 ? 'Slow' : rate === 1 ? 'Normal' : 'Fast'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLoop((v) => !v)}
            aria-pressed={loop}
            // iter-347 (Frank D2): "Repeat" reads as standard
            // media-player vocabulary; "Loop" was sewing-term ambiguous.
            aria-label="Repeat clip"
            className={`min-h-[44px] px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 ${
              loop
                ? 'bg-white text-black border-white'
                : 'bg-white/10 text-[var(--color-text-primary)]/80 hover:text-[var(--color-text-primary)] active:text-[var(--color-text-primary)] border-white/15'
            }`}
          >
            Repeat
          </button>
        </div>
      )}
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
      <div className="relative px-4 pb-4 flex items-center justify-end gap-3">
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
      </div>
      </div>
      {/* iter-356.58 (LAYOUT REBUILD) — EVIDENCE PANE.
          Right column on lg+, full-width section below the video on
          mobile. Structured WHO / WHEN / WHERE / HOW SURE so an
          incident review reads as actual evidence, not just a video
          with a close button. */}
      <aside
        aria-label="Incident details"
        className="relative shrink-0 w-full lg:w-80 lg:border-l border-t lg:border-t-0 border-white/10 bg-black/40 lg:bg-[var(--color-surface)] lg:text-[var(--color-text-primary)] text-white overflow-y-auto"
      >
        <div className="px-5 py-4 border-b border-white/10 lg:border-[var(--color-border-subtle)] flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 lg:text-[var(--color-brass-default)] font-semibold">
              Who
            </div>
            <div className="font-display text-xl font-bold mt-0.5">
              {personLabel ?? 'Unknown person'}
            </div>
          </div>
          {/* iter-356.63 (Slice D a11y): dropped the desktop-only X
              that lived in the evidence pane. The header X is the
              single close surface; multiple "Close clip viewer"
              labels confused VoiceOver swipe order. */}
        </div>
        <div className="px-5 py-4 border-b border-white/10 lg:border-[var(--color-border-subtle)] space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 lg:text-[var(--color-brass-default)] font-semibold">
              When
            </div>
            <div className="text-sm font-semibold mt-0.5">{timeLabel}</div>
            <div className="text-xs text-white/60 lg:text-[var(--color-text-tertiary)] tabular-nums">
              {absoluteTime(event.ts)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 lg:text-[var(--color-brass-default)] font-semibold">
              Where
            </div>
            <div className="text-sm font-semibold mt-0.5">
              {humanCameraName(event.camera_id)}
            </div>
          </div>
          {!personLabel && event.label && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 lg:text-[var(--color-brass-default)] font-semibold">
                What
              </div>
              <div className="text-sm font-semibold mt-0.5 capitalize">
                {event.label}
              </div>
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-b border-white/10 lg:border-[var(--color-border-subtle)]">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/55 lg:text-[var(--color-brass-default)] font-semibold">
            How sure
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-3xl font-bold tabular-nums">
              {Math.round(event.score * 100)}%
            </span>
            <span className="text-sm text-white/70 lg:text-[var(--color-text-secondary)]">
              {event.score < 0.5
                ? 'Low'
                : event.score < 0.75
                  ? 'Medium'
                  : 'High'}
            </span>
          </div>
          {matchConfidence != null && (
            <div className="text-xs text-white/55 lg:text-[var(--color-text-tertiary)] mt-1">
              Face match: {matchConfidence}%
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}

// iter-335 (a11y blocker #1): WAI-ARIA Authoring Practices radiogroup
// pattern. ArrowLeft/Up = previous, ArrowRight/Down = next, Home =
// first, End = last. Wraps at boundaries. Selection moves WITH focus
// per the "automatic" radiogroup variant (pressing arrow both updates
// the selected value AND focuses the new pill).
const SPEED_RATES: ReadonlyArray<number> = [0.5, 1, 2]

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
