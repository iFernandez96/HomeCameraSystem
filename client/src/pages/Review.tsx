import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../components/primitives/Button'
import { CatEmptyState } from '../components/CatEmptyState'
import {
  deleteFaceCapture,
  getReviewQueue,
  moveFaceCapture,
  type ReviewQueueItem,
} from '../lib/api'
import { useConfirm } from '../lib/confirm'
import { useToast } from '../lib/toast'

/**
 * iter-356.12 — face-capture review queue (Sam Critical from
 * iter-356.8). The iter-355c1 server route surfaces face captures
 * the classifier was UNCERTAIN about (confidence in [0.3, 0.75]).
 *
 * iter-356.13 — added inline approve/reject/delete actions per card.
 * Pre-iter-356.13 the operator had to deep-link into the per-name
 * gallery to act; now the active-learning loop is one tap per crop.
 *   - "Approve as <predicted_name>" → POST move to predicted_name dir
 *   - "Wrong — unknown" → POST move to __unknown__
 *   - "Delete" → DELETE (with confirm; destructive)
 *
 * Optimistic remove on success: the acted-on card disappears from the
 * grid + the total count decrements. On failure: toast + restore the
 * card.
 */

const UNKNOWN_BUCKET = '__unknown__'

// iter-356.14 (Frank Round-3 D3): never expose `__unknown__` as a
// directory name in copy. Translate the bucket-id to a human label.
function displayDir(dir: string): string {
  if (dir === UNKNOWN_BUCKET) return 'Unknown'
  return dir
}

export function Review() {
  const [items, setItems] = useState<ReviewQueueItem[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const confirm = useConfirm()
  const { showToast } = useToast()

  useEffect(() => {
    let cancelled = false
    getReviewQueue(50)
      .then((r) => {
        if (cancelled) return
        setItems(r.items)
        setTotal(r.total_uncertain)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not load review queue.')
        setItems([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  function keyOf(item: ReviewQueueItem): string {
    return `${item.current_dir}:${item.filename}`
  }

  function removeFromList(item: ReviewQueueItem) {
    setItems((prev) =>
      prev ? prev.filter((p) => keyOf(p) !== keyOf(item)) : prev,
    )
    setTotal((t) => Math.max(0, t - 1))
  }

  async function handleApprove(item: ReviewQueueItem) {
    if (!item.predicted_name) {
      showToast(
        'No predicted name — open the gallery to choose a destination.',
        'error',
      )
      return
    }
    if (item.predicted_name === item.current_dir) {
      // Already in the correct bucket — no-op move would still work
      // server-side, but skip to keep the UX honest.
      removeFromList(item)
      showToast(`Already filed under ${item.predicted_name}.`, 'success')
      return
    }
    const k = keyOf(item)
    setBusyKey(k)
    try {
      await moveFaceCapture(item.current_dir, item.filename, item.predicted_name)
      removeFromList(item)
      showToast(`Approved as ${item.predicted_name}.`, 'success')
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : 'Move failed — try again.',

        'error',
      )
    } finally {
      setBusyKey(null)
    }
  }

  async function handleReject(item: ReviewQueueItem) {
    if (item.current_dir === UNKNOWN_BUCKET) {
      // Already in unknown — same fast-path as approve-when-already-there.
      removeFromList(item)
      showToast('Already filed as unknown.', 'success')
      return
    }
    const k = keyOf(item)
    setBusyKey(k)
    try {
      await moveFaceCapture(item.current_dir, item.filename, UNKNOWN_BUCKET)
      removeFromList(item)
      showToast('Marked as unknown.', 'success')
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : 'Move failed — try again.',

        'error',
      )
    } finally {
      setBusyKey(null)
    }
  }

  async function handleDelete(item: ReviewQueueItem) {
    const ok = await confirm({
      title: 'Delete this photo?',
      body: 'It won’t be used for training and can’t be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const k = keyOf(item)
    setBusyKey(k)
    try {
      await deleteFaceCapture(item.current_dir, item.filename)
      removeFromList(item)
      showToast('Photo deleted.', 'success')
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : 'Delete failed — try again.',
        'error',
      )
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="px-4 lg:px-6 py-4 max-w-5xl mx-auto">
      <header className="flex items-baseline justify-between gap-3 mb-4">
        <div>
          {/* iter-356.58: dropped paw-mark H1 in favor of the
              shell-level WatchRibbon identity. */}
          <p className="font-display text-2xl font-bold text-[var(--color-text-primary)] tracking-tight">
            Review queue
          </p>
          {/* iter-356.14 (Frank Round-3 D2): copy rewritten human-
              side. "Face crops the classifier wasn't sure about"
              became "Photos of people the camera wasn't sure it
              recognized. Tell it if it got them right." */}
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {items === null
              ? 'Loading…'
              : total === 0
                ? 'Your camera is confident about everyone it has seen lately.'
                : `${total} photo${total === 1 ? '' : 's'} the camera wasn’t sure about — tell it if it got them right.`}
          </p>
        </div>
        <Link
          to="/training"
          className="text-sm text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded"
        >
          ← All training photos
        </Link>
      </header>

      {error && (
        <div
          role="alert"
          className="bg-[var(--color-danger-bg)] border border-[var(--color-danger-border)] rounded-lg px-3 py-3 text-sm text-[var(--color-danger)] mb-4"
        >
          {error}
        </div>
      )}

      {items !== null && items.length === 0 && !error ? (
        // iter-356.24 (Maya iter-356.23 Major #1 carryover): migrated
        // from one-line plain-text shrug to <CatEmptyState> so this
        // surface matches Events / People / Timelapses / Training.
        // Sleeping cat default is on-mood for Review (the queue is at
        // rest; nothing needs human judgment right now).
        <CatEmptyState
          heading="Nothing to review"
          body="When the camera spots a face it&rsquo;s not quite sure about, you&rsquo;ll see it here so you can confirm or correct the guess."
          hint="The camera will keep watching while you&rsquo;re away."
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 list-none">
          {(items ?? []).map((item) => {
            const k = keyOf(item)
            const busy = busyKey === k
            const conf = Math.round(item.confidence * 100)
            return (
              <li
                key={k}
                className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden flex flex-col"
              >
                <img
                  src={item.url}
                  alt=""
                  loading="lazy"
                  className="w-full aspect-square object-cover bg-[var(--color-surface-raised)]"
                />
                <div className="px-3 py-2.5 flex-1 flex flex-col gap-2">
                  <div>
                    <div className="text-sm text-[var(--color-text-primary)] truncate">
                      {item.predicted_name ?? 'No prediction'}
                    </div>
                    {/* iter-356.14 (Frank Round-3 B3 + D3): bumped
                        text-[11px] → text-xs (12px), tertiary →
                        secondary, and __unknown__ is humanized. */}
                    <div className="text-xs text-[var(--color-text-secondary)] tabular-nums">
                      {conf}% confident · filed as {displayDir(item.current_dir)}
                    </div>
                  </div>
                  {/* iter-356.14 (Frank Round-3 H2): two-row layout
                      separates Delete (destructive) from the safe
                      approve/reject pair. Pre-iter-356.14 a single
                      flex-wrap row put Delete next to "Yes, Israel"
                      with 6px gap — Frank's arthritic finger could
                      land on Delete instead. Confirm dialog still
                      catches it; this layout makes it less needed. */}
                  <div className="grid grid-cols-2 gap-1.5 mt-auto">
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy}
                      onClick={() => handleApprove(item)}
                      disabled={!item.predicted_name}
                    >
                      {item.predicted_name
                        ? `Yes, ${item.predicted_name}`
                        : 'No prediction'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy}
                      onClick={() => handleReject(item)}
                    >
                      Not sure
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={busy}
                    onClick={() => handleDelete(item)}
                    aria-label={`Delete this photo (currently filed as ${displayDir(item.current_dir)})`}
                    className="!text-[var(--color-danger)] hover:!bg-[var(--color-danger-bg)]"
                  >
                    Delete
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
