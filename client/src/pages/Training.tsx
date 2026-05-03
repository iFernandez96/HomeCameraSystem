import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CatEmptyState } from '../components/CatEmptyState'
import { PawMark } from '../components/CatIcons'
import {
  deleteFaceCapture,
  listFaceCaptureDirs,
  listFaceCapturesInDir,
  moveFaceCapture,
  type FaceCaptureDir,
  type FaceCaptureFile,
} from '../lib/api'
import { Button } from '../components/primitives/Button'
import { useConfirm } from '../lib/confirm'
import { formatError } from '../lib/format'
import { useToast } from '../lib/toast'

// iter-352/353 (face-capture-for-retraining, Phases 2-3): browse +
// move + delete the face crops the worker saved per the iter-351
// recognizer change.
//
// Two views, one page (URL state via ?name=...):
//   - Index: per-name folder grid with count + most-recent.
//   - Drill-in (?name=alice): thumbnail grid + per-thumb action
//     panel (move-to-existing chip / move-to-new-name / delete).
//
// iter-353a applied audits:
//   - a11y: focus restore to Actions trigger after Cancel/Confirm.
//   - a11y: alt text uses ordinal position, not raw event UUID.
//   - a11y: 44 px hit targets on Back / Actions / Move input.
//   - Frank: copy rewrites to drop "face crop", "directory",
//     "classifier", "worker" jargon.
//   - Frank: name-picker chips of existing folders + "new person"
//     option; raw text input was a wife-test failure.

export function Training() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const activeName = params.get('name')

  return (
    <div className="p-4 space-y-4 max-w-3xl lg:max-w-4xl mx-auto">
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold inline-flex items-center gap-2">
            <PawMark className="text-[var(--color-accent-default)]" />
            Training
          </h1>
          <p className="text-base text-[var(--color-text-primary)] mt-1">
            {activeName
              ? `Photos the camera saved as "${_displayName(activeName)}". Move any that are wrong, then come back later to re-train.`
              : 'Photos the camera took of visitors, sorted by who it thinks they are. Tap a name to check its work.'}
          </p>
        </div>
        {/* iter-356.12: deep-link to the iter-355c1 review queue.
            Surfaces only crops the classifier was uncertain about
            (confidence in [0.3, 0.75]) — most-bang-for-buck triage. */}
        {!activeName && (
          <a
            href="/training/review"
            onClick={(e) => {
              e.preventDefault()
              navigate('/training/review')
            }}
            className="text-sm text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded whitespace-nowrap"
          >
            Review queue →
          </a>
        )}
      </header>

      {activeName ? (
        <GalleryView
          name={activeName}
          onBack={() => {
            setParams({})
          }}
        />
      ) : (
        <IndexView
          onPick={(name) => {
            navigate(`/training?name=${encodeURIComponent(name)}`)
          }}
        />
      )}
    </div>
  )
}

function IndexView({ onPick }: { onPick: (name: string) => void }) {
  const [dirs, setDirs] = useState<FaceCaptureDir[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    listFaceCaptureDirs()
      .then((r) => {
        if (cancelled) return
        setDirs(r.dirs)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [retryNonce])

  if (error) {
    return (
      <div
        className="text-center py-12 px-6 space-y-3"
        role="status"
        aria-live="polite"
      >
        <p className="text-[var(--color-text-primary)] text-base">Could not load training photos.</p>
        <p className="text-sm text-[var(--color-text-secondary)]">
          You need to be signed in as the main account holder. Sign out and try
          signing in as the owner if a different person set up your camera.
        </p>
        <Button
          variant="primary"
          size="md"
          className="mt-2"
          onClick={() => {
            setError(null)
            setDirs(null)
            setRetryNonce((n) => n + 1)
          }}
        >
          Retry
        </Button>
        {/* iter-356.3c (Maya Minor): wrap raw exception dump in
            <details> so friendly copy stays clean above. */}
        <details className="mt-2 text-sm text-[var(--color-text-tertiary)]">
          <summary className="cursor-pointer hover:text-[var(--color-text-secondary)]">
            Technical details
          </summary>
          <p className="mt-1 break-all">{formatError(error)}</p>
        </details>
      </div>
    )
  }
  if (dirs === null) {
    return (
      <div
        role="status"
        className="flex items-center justify-center py-12 gap-3 text-sm text-[var(--color-text-primary)]"
      >
        <span
          aria-hidden="true"
          className="w-5 h-5 rounded-full border-2 border-[var(--color-border-strong)] border-t-neutral-300 animate-spin"
        />
        Loading photos…
      </div>
    )
  }
  if (dirs.length === 0) {
    // iter-356.24 (Maya iter-356.23 Major #1 carryover): migrated
    // from plain-text shrug to <CatEmptyState> primitive so this
    // surface matches Events / People / Timelapses / Review.
    return (
      <CatEmptyState
        heading="No visitor photos yet"
        body="When the camera sees a face it doesn&rsquo;t recognize, it&rsquo;ll save a snapshot here so you can teach it who they are."
        hint="Check that face recognition is turned on in Settings."
      />
    )
  }
  return (
    <ul className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3 list-none">
      {dirs.map((d) => (
        <li key={d.name}>
          <button
            type="button"
            onClick={() => onPick(d.name)}
            className="w-full text-left flex items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-3 min-h-[48px] [@media(hover:hover)]:hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
            aria-label={`${_displayName(d.name)}: ${d.count} ${d.count === 1 ? 'photo' : 'photos'}, most recent ${_formatRelative(d.latest_ts)}`}
          >
            {/* iter-355aa (Maya: Iconography Major): emerald is the
                positive-recognition semantic color (used for confidence
                badge ≥75 %, recognized pill). Using it on the
                fallback avatar dilutes the signal. Demoted to neutral
                so emerald means "the camera is sure about this person"
                everywhere it appears. */}
            <div className="w-16 h-16 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border-strong)] flex items-center justify-center flex-shrink-0">
              <span aria-hidden="true" className="text-2xl font-semibold text-[var(--color-text-primary)]">
                {_displayName(d.name).charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-base font-semibold text-[var(--color-text-primary)] truncate">
                {_displayName(d.name)}
              </div>
              <div className="text-sm text-[var(--color-text-primary)]">
                {d.count} {d.count === 1 ? 'photo' : 'photos'}
              </div>
              <div className="text-sm text-[var(--color-text-secondary)] mt-0.5">
                Most recent {_formatRelative(d.latest_ts)}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function GalleryView({
  name,
  onBack,
}: {
  name: string
  onBack: () => void
}) {
  const navigate = useNavigate()
  const [files, setFiles] = useState<FaceCaptureFile[] | null>(null)
  const [allDirs, setAllDirs] = useState<FaceCaptureDir[]>([])
  const [error, setError] = useState<unknown>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [moveTarget, setMoveTarget] = useState<string>('')
  const [showNewPersonInput, setShowNewPersonInput] = useState<boolean>(false)
  const [actionInflight, setActionInflight] = useState<boolean>(false)
  // iter-353a (a11y #1, #2): ref to the Actions trigger button of the
  // currently-open menu. Restored on close so focus returns to the
  // exact button that opened the panel — NVDA + VoiceOver do not lose
  // their place after Cancel/Confirm/Move/Delete.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const confirm = useConfirm()
  const toast = useToast()

  useEffect(() => {
    let cancelled = false
    Promise.all([listFaceCapturesInDir(name), listFaceCaptureDirs()])
      .then(([filesRes, dirsRes]) => {
        if (cancelled) return
        setFiles(filesRes.files)
        setAllDirs(dirsRes.dirs)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e)
      })
    return () => {
      cancelled = true
    }
  }, [name, retryNonce])

  const closeMenu = () => {
    setOpenMenu(null)
    setMoveTarget('')
    setShowNewPersonInput(false)
    // a11y #1, #2: restore focus to the trigger that opened the panel.
    // Run after the state flush so the trigger is back in the DOM.
    setTimeout(() => triggerRef.current?.focus(), 0)
  }

  const removeFromList = (filename: string) => {
    setFiles((cur) => (cur ? cur.filter((f) => f.filename !== filename) : cur))
    closeMenu()
  }

  const moveTo = async (filename: string, target: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(target)) {
      toast.showToast(
        'Name can only contain letters, numbers, _ and -.',
        'error',
      )
      return
    }
    setActionInflight(true)
    try {
      await moveFaceCapture(name, filename, target)
      toast.showToast(`Moved to ${_displayName(target)}`, 'success')
      removeFromList(filename)
    } catch (e) {
      toast.showToast(`Move failed: ${formatError(e)}`, 'error')
    } finally {
      setActionInflight(false)
    }
  }

  const onMoveTyped = (filename: string) => {
    const target = moveTarget.trim()
    if (!target) return
    moveTo(filename, target)
  }

  const onDelete = async (filename: string) => {
    const ok = await confirm({
      title: 'Delete this photo?',
      body: 'It will be removed from your camera. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) {
      // a11y #1: confirm cancelled — restore focus to Actions trigger.
      triggerRef.current?.focus()
      return
    }
    setActionInflight(true)
    try {
      await deleteFaceCapture(name, filename)
      toast.showToast('Photo deleted', 'success')
      removeFromList(filename)
    } catch (e) {
      toast.showToast(`Delete failed: ${formatError(e)}`, 'error')
    } finally {
      setActionInflight(false)
    }
  }

  // Existing dir names except the current one (can't move to self) and
  // not the empty-state placeholder. Used to render the chip picker.
  const otherDirs = allDirs.filter((d) => d.name !== name)

  return (
    <div className="space-y-4">
      {/* iter-355aa (Maya Minor): chevron-pill instead of floating
          text-as-button. Copy "Back to all names" → "All people"
          (Maya Nit: "names" leaks the data model). */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-text-primary)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] rounded-lg px-3 py-2 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
        aria-label="Back to all people"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        All people
      </button>

      {error ? (
        <div
          className="text-center py-12 px-6 space-y-3"
          role="status"
          aria-live="polite"
        >
          <p className="text-[var(--color-text-primary)] text-base">Could not load these photos.</p>
          <Button
            variant="primary"
            size="md"
            className="mt-2"
            onClick={() => {
              setError(null)
              setFiles(null)
              setRetryNonce((n) => n + 1)
            }}
          >
            Retry
          </Button>
          <details className="mt-2 text-sm text-[var(--color-text-tertiary)]">
            <summary className="cursor-pointer hover:text-[var(--color-text-secondary)]">
              Technical details
            </summary>
            <p className="mt-1 break-all">{formatError(error)}</p>
          </details>
        </div>
      ) : files === null ? (
        <div
          role="status"
          className="flex items-center justify-center py-12 gap-3 text-sm text-[var(--color-text-primary)]"
        >
          <span
            aria-hidden="true"
            className="w-5 h-5 rounded-full border-2 border-[var(--color-border-strong)] border-t-neutral-300 animate-spin"
          />
          Loading photos…
        </div>
      ) : files.length === 0 ? (
        // iter-356.24: per-person gallery empty state — distinct copy
        // from the dirs-empty case (which talks about face recog
        // generally; this one is scoped to ONE named person).
        <CatEmptyState
          heading="No photos here yet"
          body={`Once the camera sees ${_displayName(name)} again, their photos will show up here.`}
        />
      ) : (
        <>
          {/* iter-353a (a11y #8): sr-only h2 so screen-reader rotor
              users get an entry for the gallery section. The visible
              page-level h1 + this hidden h2 together give SR users
              both "Training" and "<name> — N photos" in the rotor. */}
          <h2 className="sr-only">
            {_displayName(name)} — {files.length}{' '}
            {files.length === 1 ? 'photo' : 'photos'}
          </h2>
          <ul
            className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 list-none"
            aria-label={`Photos labeled as ${_displayName(name)}`}
          >
            {files.map((f, idx) => (
              <li key={f.filename}>
                <figure className="space-y-1">
                  <img
                    src={f.url}
                    alt={`Capture ${idx + 1} of ${files.length}`}
                    loading="lazy"
                    className="w-full aspect-square object-cover rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)]"
                  />
                  <figcaption className="text-xs text-[var(--color-text-secondary)] px-1 flex items-center justify-between gap-1">
                    <span className="truncate">
                      {_formatRelative(f.ts_ms / 1000)}
                    </span>
                    {/* iter-355a/355aa: confidence badge. text-xs (11
                        px) is the readable floor; was text-[10px]
                        which Maya flagged. Color: green ≥0.75 (trust),
                        amber 0.5..0.75 (Tinder-queue candidate), red
                        <0.5 (likely wrong). */}
                    {f.confidence != null ? (
                      <span
                        className={
                          'flex-shrink-0 px-1.5 py-0.5 text-xs font-semibold rounded ' +
                          _confidenceClass(f.confidence)
                        }
                        title={`${(f.confidence * 100).toFixed(0)}% confident the classifier was correct about "${f.predicted_name ?? name}"`}
                      >
                        {(f.confidence * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {/* iter-355aa (Maya Major): the "→ Events" link
                        was a 10 px text affordance that read as a
                        debug button. Replaced with an icon-only
                        button (filmstrip glyph), 32×32, with
                        explicit aria-label. Lives inline with the
                        timestamp + confidence so the figcaption row
                        carries the three pieces of metadata at the
                        same visual weight. */}
                    <button
                      type="button"
                      onClick={() =>
                        navigate(
                          `/events?person=${encodeURIComponent(f.predicted_name ?? name)}`,
                        )
                      }
                      className="flex-shrink-0 w-8 h-8 inline-flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] rounded focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
                      aria-label={`View events from ${f.predicted_name ?? name}`}
                      title={`View events from ${f.predicted_name ?? name}`}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                        <line x1="7" y1="2" x2="7" y2="22" />
                        <line x1="17" y1="2" x2="17" y2="22" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <line x1="2" y1="7" x2="7" y2="7" />
                        <line x1="2" y1="17" x2="7" y2="17" />
                        <line x1="17" y1="17" x2="22" y2="17" />
                        <line x1="17" y1="7" x2="22" y2="7" />
                      </svg>
                    </button>
                  </figcaption>
                  {openMenu === f.filename ? (
                    <ActionPanel
                      filename={f.filename}
                      otherDirs={otherDirs}
                      moveTarget={moveTarget}
                      setMoveTarget={setMoveTarget}
                      showNewPersonInput={showNewPersonInput}
                      setShowNewPersonInput={setShowNewPersonInput}
                      actionInflight={actionInflight}
                      onMoveChip={(target) => moveTo(f.filename, target)}
                      onMoveTyped={() => onMoveTyped(f.filename)}
                      onDelete={() => onDelete(f.filename)}
                      onCancel={closeMenu}
                    />
                  ) : (
                    // iter-355aa (Maya Nit): "Actions" → "Move or
                    // delete" — commits to the verb instead of being
                    // engineer-default. Ref capture happens in
                    // onClick (the empty ref-callback was cruft).
                    <button
                      type="button"
                      onClick={(e) => {
                        triggerRef.current = e.currentTarget
                        setOpenMenu(f.filename)
                        setMoveTarget('')
                        setShowNewPersonInput(false)
                      }}
                      aria-label={`Move or delete photo ${idx + 1} of ${files.length}, from ${_formatRelative(f.ts_ms / 1000)}`}
                      className="w-full px-2 py-2 min-h-[44px] text-sm font-medium text-[var(--color-text-primary)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
                    >
                      Move or delete
                    </button>
                  )}
                </figure>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function ActionPanel({
  filename,
  otherDirs,
  moveTarget,
  setMoveTarget,
  showNewPersonInput,
  setShowNewPersonInput,
  actionInflight,
  onMoveChip,
  onMoveTyped,
  onDelete,
  onCancel,
}: {
  filename: string
  otherDirs: FaceCaptureDir[]
  moveTarget: string
  setMoveTarget: (s: string) => void
  showNewPersonInput: boolean
  setShowNewPersonInput: (b: boolean) => void
  actionInflight: boolean
  onMoveChip: (target: string) => void
  onMoveTyped: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  void filename
  return (
    <div className="space-y-2 pt-2 px-1">
      {otherDirs.length > 0 ? (
        <fieldset className="space-y-1">
          <legend className="text-xs text-[var(--color-text-secondary)] mb-1">Move this photo to</legend>
          <div className="flex flex-wrap gap-1">
            {otherDirs.map((d) => (
              <button
                key={d.name}
                type="button"
                disabled={actionInflight}
                onClick={() => onMoveChip(d.name)}
                className="px-2 py-1 min-h-[36px] text-xs font-medium bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] disabled:bg-[var(--color-surface)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed text-[var(--color-text-primary)] rounded-full focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
              >
                {_displayName(d.name)}
              </button>
            ))}
            {!showNewPersonInput && (
              // iter-355aa (Maya Minor): "+ New person" was rendered
              // with same fill as the move-to chips, but its `text-
              // blue-300` made it visually compete with "Move" as a
              // primary action. Demoted to ghost (transparent fill +
              // dashed border) so the chip row reads as "tap a name
              // OR escape via the ghost option" — single-primary rule.
              <button
                type="button"
                disabled={actionInflight}
                onClick={() => setShowNewPersonInput(true)}
                className="px-2 py-1 min-h-[36px] text-xs font-medium border border-dashed border-[var(--color-border-strong)] hover:border-neutral-500 hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--color-text-primary)] rounded-full focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
              >
                + New person
              </button>
            )}
          </div>
        </fieldset>
      ) : null}

      {(otherDirs.length === 0 || showNewPersonInput) && (
        <div className="space-y-1">
          <label className="block text-xs text-[var(--color-text-secondary)]">
            New person&apos;s name
            <input
              type="text"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              placeholder="Add a name"
              autoComplete="off"
              className="mt-1 w-full px-2 py-2 min-h-[44px] bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            />
          </label>
          {/* iter-356.3c: Move via Button primitive (size=sm fits the
              cramped action-panel column). */}
          <div className="flex gap-1">
            <Button
              variant="primary"
              size="sm"
              onClick={onMoveTyped}
              disabled={actionInflight || !moveTarget.trim()}
              className="flex-1"
            >
              Move
            </Button>
          </div>
        </div>
      )}

      {/* iter-355aa (Maya Minor): destructive-action divider strengthened
          (pt-3 mt-2 border-t was pt-1) so Delete reads as separate from
          the move flow above, not the next button in the same row. */}
      <div className="flex gap-1 pt-3 mt-2 border-t border-[var(--color-border)]">
        <Button
          variant="destructive"
          size="sm"
          onClick={onDelete}
          disabled={actionInflight}
          className="flex-1"
        >
          Delete
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={actionInflight}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

// `__unknown__` is the recognizer sentinel for "no match within
// tolerance." Show it as "Unknown" in the UI so non-technical
// operators don't get confused by the underscore-bracketed name.
function _displayName(name: string): string {
  if (name === '__unknown__') return 'Unknown'
  return name
}

// iter-355a: confidence-band coloring matches the iter-355b Tinder
// queue priority — green = trust the classifier, amber = ambiguous
// (will be queued for review), red = strong miss (move/delete).
function _confidenceClass(conf: number): string {
  // iter-356.3c: token-driven confidence ramp. Same green/amber/red
  // semantic as before but pulled from the iter-356.0 design tokens.
  // iter-356.14 (Maya MAJOR fix): pre-tokenized tinted bg via
  // color-mix in index.css instead of /20 opacity-on-CSS-var which
  // didn't apply reliably in Tailwind v4. Pills now have visible
  // soft tint regardless of browser quirks.
  if (conf >= 0.75) return 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
  if (conf >= 0.5) return 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]'
  return 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
}

function _formatRelative(ts: number): string {
  const now = Date.now() / 1000
  const delta = Math.max(0, now - ts)
  if (delta < 60) return 'just now'
  if (delta < 3600) {
    const m = Math.floor(delta / 60)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (delta < 86400) {
    const h = Math.floor(delta / 3600)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.floor(delta / 86400)
  if (d > 30) {
    const date = new Date(ts * 1000)
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  }
  return `${d} day${d === 1 ? '' : 's'} ago`
}
