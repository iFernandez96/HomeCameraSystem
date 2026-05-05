import { useEffect, useRef, useState } from 'react'

/**
 * Full-screen preview shown after the user takes a snapshot. Dismisses
 * on backdrop click, ESC, or the explicit Close button.
 *
 * iter-356.63 (Slice D a11y): mirrors the ClipModal a11y pattern.
 *   - backdrop is a <div aria-hidden="true">, NOT a <button> — VO
 *     swipe order pre-fix landed on "Dismiss snapshot" before
 *     reaching the image, mouse/touch users still get
 *     backdrop-click-to-close via onClick
 *   - focus is captured on open (Close button) and restored on
 *     close to whatever opened the preview (Capture button on Live)
 *   - Tab cycles inside the dialog instead of escaping to the
 *     muted page behind the backdrop
 *   - Save / Close buttons bumped to min-h-[44px] for touch targets
 */
export function SnapshotPreview({
  url,
  onClose,
}: {
  url: string
  onClose: () => void
}) {
  // Track image-load failure so a 404 (e.g. snapshot was pruned by
  // the iter-1 thumb-rotation cap) doesn't leave the user staring
  // at a broken-image icon. The Save link stays — it just lets them
  // download the (likely also missing) URL if they want to retry.
  //
  // We store the *URL that errored* rather than a bool so that when
  // the parent passes a new URL the fallback automatically clears —
  // no useEffect-with-setState dance (which trips the
  // `react-hooks/set-state-in-effect` lint rule documented in
  // CLAUDE.md). The naturally-derived `errored` is `true` only while
  // the prop URL matches the URL that previously failed.
  const [erroredUrl, setErroredUrl] = useState<string | null>(null)
  const errored = erroredUrl === url

  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    // Focus restore: capture whatever the user had focused (likely
    // the Capture button on Live) and restore it on unmount so the
    // user lands back at their starting point — same pattern as
    // ClipModal::iter-336.
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
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus()
      }
    }
  }, [onClose])

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Snapshot preview"
      // iter-356.63: focus-trap. Tab from the last focusable child
      // wraps to the first; Shift-Tab from the first wraps to the
      // last. Same pattern as ClipModal::iter-336.
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return
        const focusables = _focusablesIn(dialogRef.current)
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
      className="fixed inset-0 z-40 flex flex-col bg-black/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      {/* iter-356.63: backdrop is a div+onClick (aria-hidden so SR
          and keyboard skip it). Pre-iter-356.63 was a <button> —
          VoiceOver swipe-gesture landed on "Dismiss snapshot"
          BEFORE the image, even though the button was tabIndex=-1.
          Mouse + touch users still get backdrop-click-to-close. */}
      <div
        onClick={onClose}
        aria-hidden="true"
        data-testid="snapshot-backdrop"
        className="absolute inset-0 w-full h-full cursor-default"
      />
      <div className="relative flex-1 flex items-center justify-center p-4 min-h-0">
        {errored ? (
          <div
            role="status"
            aria-live="polite"
            className="text-center space-y-3 max-w-sm"
          >
            <div className="mx-auto w-12 h-12 rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] flex items-center justify-center text-[var(--color-text-tertiary)] text-xl">
              ?
            </div>
            <p className="text-[var(--color-text-secondary)]">Snapshot unavailable</p>
            <p className="text-xs text-[var(--color-text-tertiary)] break-all">
              The image at <code>{url}</code> couldn&apos;t be loaded.
              It may have been pruned from the server.
            </p>
          </div>
        ) : (
          <img
            src={url}
            alt="Snapshot of the camera at the moment of capture"
            onError={() => setErroredUrl(url)}
            className="max-w-full max-h-full rounded-xl shadow-2xl border border-[var(--color-border)]"
          />
        )}
      </div>
      <div className="relative px-4 pb-4 flex items-center justify-between gap-3">
        <a
          href={url}
          download
          className="flex-1 min-h-[44px] py-3 text-center bg-white/10 active:bg-white/15 rounded-2xl text-sm font-medium border border-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Save
        </a>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="flex-1 min-h-[44px] py-3 bg-white/15 active:bg-white/20 rounded-2xl text-sm font-medium border border-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Close
        </button>
      </div>
    </div>
  )
}

/** iter-356.63 (Slice D a11y): list focusable descendants in DOM
 *  order so the Tab focus trap can cycle through them. Mirrors the
 *  ClipModal::_focusablesIn helper — keep them aligned if either
 *  changes. */
function _focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.getAttribute('tabindex') !== '-1',
  )
}
