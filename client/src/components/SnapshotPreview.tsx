import { useEffect, useState } from 'react'

/**
 * Full-screen preview shown after the user takes a snapshot. Dismisses
 * on backdrop click, ESC, or the explicit Close button.
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Snapshot preview"
      className="fixed inset-0 z-40 flex flex-col bg-black/95 backdrop-blur-sm pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss snapshot"
        tabIndex={-1}
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
          className="flex-1 py-3 text-center bg-white/10 active:bg-white/15 rounded-2xl text-sm font-medium border border-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Save
        </a>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 py-3 bg-white/15 active:bg-white/20 rounded-2xl text-sm font-medium border border-white/15 focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        >
          Close
        </button>
      </div>
    </div>
  )
}
