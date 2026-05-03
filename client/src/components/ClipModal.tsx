import { useEffect, useRef, useState } from 'react'
import { nextRovingIndex } from '../lib/a11y'
import { exportEvents } from '../lib/api'
import {
  absoluteTime,
  clockTime,
  eventTitle,
  humanCameraName,
} from '../lib/eventLabel'
import { useToast } from '../lib/toast'
import type { DetectionEvent } from '../lib/types'
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
      <video
        ref={videoRef}
        key={clipUrl}
        src={clipUrl}
        controls
        autoPlay
        playsInline
        loop={loop}
        onError={() => setErroredClipUrl(clipUrl)}
        aria-label={`Clip of ${event.person_name ?? event.label} event`}
        className="max-w-full max-h-full rounded-xl shadow-2xl border border-[var(--color-border)] bg-black"
      >
        <track kind="captions" />
      </video>
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
      className="fixed inset-0 z-40 flex flex-col bg-black/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
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
      {/* iter-356.17 (Maya 11th CRITICAL #1): event-header bar.
          Title + camera + face-match badge + close-X. Lives ABOVE the
          video region so the user has context before the player even
          renders. Translucent so it doesn't fight the black-backdrop
          aesthetic of the modal. */}
      <header className="relative flex items-start justify-between gap-3 px-4 pt-3 pb-2 border-b border-white/10 bg-black/30">
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
      </header>
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
          inversion fix. Pre-iter-356.3b Close was filled brand-blue =
          "panic button" UX (Maya: "Close is dismissal, never primary
          action. A primary blue screams 'do this thing.'"). On a
          non-destructive viewer, no button should be primary — both
          Close and Save clip are secondary now. closeRef stays so
          modal-open focus lands on Close (iter-336 a11y). Save clip
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
        <Button
          ref={closeRef}
          variant="secondary"
          size="md"
          onClick={onClose}
          className="flex-1 max-w-xs"
        >
          Close
        </Button>
      </div>
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
