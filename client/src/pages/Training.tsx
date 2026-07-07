import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { CatEmptyState } from '../components/CatEmptyState'
import { ErrorState } from '../components/states/ErrorState'
import { LoadingState } from '../components/states/LoadingState'
import {
  type ConsentRecord,
  deleteFaceCapture,
  deleteTrainingCaptures,
  getDetectionConfig,
  getNameConsent,
  getTrainingExport,
  listFaceCaptureDirs,
  listFaceCapturesInDir,
  moveFaceCapture,
  patchDetectionConfig,
  setNameConsent,
  type FaceCaptureDir,
  type FaceCaptureFile,
} from '../lib/api'
import type { DetectionConfig } from '../lib/types'
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
        {/* iter-356.58: dropped page-title H1 + paw mark. */}
        <div>
          {/* iter-356.63 (Slice D a11y): sr-only <h1> for AT users.
              Visible "Teach Mushu" stays a <p> since the WatchRibbon
              owns the page identity. */}
          <h1 className="sr-only">Teach Mushu</h1>
          <p className="font-display text-2xl font-bold text-[var(--color-text-primary)] tracking-tight" aria-hidden="true">
            Teach Mushu
          </p>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {activeName
              ? `Photos the camera saved as "${_displayName(activeName)}". Move any that are wrong, then come back later to re-train.`
              : 'Photos of unfamiliar visitors. Sort them so the camera learns who is who.'}
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
            className="inline-flex items-center min-h-[44px] text-sm font-medium text-[var(--color-accent-default)] hover:text-[var(--color-accent-bright)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded whitespace-nowrap transition-colors"
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
        <>
          <CaptureRetentionSection />
          <ExportSection />
          <IndexView
            onPick={(name) => {
              navigate(`/training?name=${encodeURIComponent(name)}`)
            }}
          />
        </>
      )}
    </div>
  )
}

// iter-356.6X (tiered-inference slice 4): operator-facing capture
// + retention controls. Mirrors the `face_capture_enabled` /
// `face_capture_retention_days` server fields. Fetch once on mount,
// PATCH on change (toggle) / blur (numeric input) per the
// DetectionSection convention — half-typed values must not churn
// the worker config-poll.
function CaptureRetentionSection() {
  const { showToast } = useToast()
  const [config, setConfig] = useState<DetectionConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    getDetectionConfig()
      .then((c) => {
        if (cancelled) return
        setConfig(c)
      })
      .catch(() => {
        if (cancelled) return
        // Owner-only; family/viewer 401 is expected. Leave config
        // null so the section degrades to disabled inputs.
        setConfig(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const commit = (patch: Partial<DetectionConfig>) => {
    patchDetectionConfig(patch)
      .then((next) => {
        setConfig(next)
        showToast('Capture settings saved', 'success')
      })
      .catch((e) => {
        showToast(`Could not save: ${formatError(e)}`, 'error')
      })
  }

  const enabled = config?.face_capture_enabled ?? false
  const retention = config?.face_capture_retention_days ?? 30
  const disabled = config === null

  return (
    <section
      aria-labelledby="capture-retention-heading"
      className="bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-xl)] p-4 space-y-3 shadow-[var(--shadow-card),var(--shadow-card-inset)]"
    >
      <h2
        id="capture-retention-heading"
        className="text-base font-semibold text-[var(--color-text-primary)]"
      >
        Capture & retention
      </h2>
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="face-capture-enabled"
          className="text-sm text-[var(--color-text-primary)] flex-1"
        >
          Save face captures for retraining
        </label>
        <input
          id="face-capture-enabled"
          type="checkbox"
          role="switch"
          aria-label="Save face captures for retraining"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => commit({ face_capture_enabled: e.target.checked })}
          className="w-5 h-5 accent-[var(--color-accent-default)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="face-capture-retention"
          className="text-sm text-[var(--color-text-primary)] flex-1"
        >
          Keep captures for N days
        </label>
        <input
          id="face-capture-retention"
          type="number"
          min={1}
          max={365}
          aria-label="Keep captures for N days"
          value={retention}
          disabled={disabled}
          onChange={(e) =>
            setConfig((c) =>
              c
                ? {
                    ...c,
                    face_capture_retention_days: Number(e.target.value) || 1,
                  }
                : c,
            )
          }
          onBlur={(e) => {
            const v = Math.max(1, Math.min(365, Number(e.target.value) || 1))
            // Always PATCH on blur — the comparator-against-state
            // path was misleading because onChange already mirrored
            // the typed value into local config. Re-clamping here
            // is the load-bearing safety: 999 typed → 365 saved.
            if (config) {
              commit({ face_capture_retention_days: v })
            }
          }}
          inputMode="numeric"
          // iter-356.66 (iOS oddities sweep): text-sm + type=number
          // triggers iOS Safari auto-zoom on focus; inputMode=numeric
          // surfaces the digit pad on Android. Bumped to text-base
          // so retention-input focus doesn't reflow the page.
          // Sunroom sweep: 44px touch floor + form-field radius token
          // (rounded-lg = --radius-lg) so the retention field matches
          // the rest of the form rhythm.
          className="w-24 min-h-[44px] bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg px-2 py-2 text-base text-[var(--color-text-primary)] tabular-nums focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
        />
      </div>
      <p className="text-xs text-[var(--color-text-secondary)]">
        Captures older than this are swept off disk. Range 1–365 days.
      </p>
    </section>
  )
}

// iter-356.6X (tiered-inference slice 4): training-ZIP export.
// Two fixed presets — face crops at 224 px (face-recog input size),
// person crops at 640 px (YOLO input size). Server returns
// `application/zip`; we trigger a download via
// URL.createObjectURL + a synthetic anchor click.
function ExportSection() {
  const { showToast } = useToast()
  const [busy, setBusy] = useState<'face' | 'person' | null>(null)

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } finally {
      // Free the blob URL on the next tick — Safari needs the
      // anchor click to dispatch first.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
  }

  const onExport = (kind: 'face' | 'person', size: number) => {
    if (busy) return
    setBusy(kind)
    getTrainingExport(kind, size)
      .then((blob) => {
        downloadBlob(blob, `homecam-training-${kind}-${size}.zip`)
        showToast('Export ready', 'success')
      })
      .catch((e) => {
        showToast(`Export failed: ${formatError(e)}`, 'error')
      })
      .finally(() => {
        setBusy(null)
      })
  }

  // iter-356.x (Frank I1): pre-fix two prominent primary-orange buttons
  // labeled "Export face crops (224×224)" sat at the top of the
  // Training tab. Non-technical homeowners read this as "this is what
  // I'm supposed to do" and tapped them. Now collapsed behind a
  // disclosure with explicit "ML developers only" framing — the buttons
  // are still one click away for power users, but homeowners aren't
  // led into them.
  return (
    <section
      aria-labelledby="export-heading"
      className="bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-xl)] p-4 shadow-[var(--shadow-card),var(--shadow-card-inset)]"
    >
      <details>
        <summary
          id="export-heading"
          className="text-sm font-medium text-[var(--color-text-secondary)] cursor-pointer hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded list-none [&::-webkit-details-marker]:hidden flex items-center gap-2"
        >
          <span aria-hidden="true">▸</span>
          Advanced — export training data for ML
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)]">
            For developers training a custom model on a separate machine.
            If you don&apos;t know what that means, you can skip this
            section — the camera trains itself from the photos it
            captures.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExport('face', 224)}
              disabled={busy !== null}
              aria-label="Export face crops (224×224)"
            >
              {busy === 'face' ? 'Exporting…' : 'Export face crops (224×224)'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExport('person', 640)}
              disabled={busy !== null}
              aria-label="Export person crops (640×640)"
            >
              {busy === 'person' ? 'Exporting…' : 'Export person crops (640×640)'}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-tertiary)]">
            Letterboxed PNGs + manifest.csv. Capped at 5,000 entries per export.
          </p>
        </div>
      </details>
    </section>
  )
}

function IndexView({ onPick }: { onPick: (name: string) => void }) {
  const [dirs, setDirs] = useState<FaceCaptureDir[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const confirm = useConfirm()
  const toast = useToast()

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
    // iter-356.63 (mobile redesign Slice F): consolidated to shared
    // <ErrorState> so this surface matches Events / People / etc.
    return (
      <ErrorState
        title="Could not load training photos."
        message="You need to be signed in as the main account holder. Sign out and try signing in as the owner if a different person set up your camera."
        retry={() => {
          setError(null)
          setDirs(null)
          setRetryNonce((n) => n + 1)
        }}
        technicalDetail={formatError(error)}
      />
    )
  }
  if (dirs === null) {
    // iter-356.63: route-shaped skeleton instead of a centered ring
    // spinner. Training is a grid of person folders.
    return (
      <div role="status">
        <span className="sr-only">Loading photos…</span>
        <LoadingState shape="grid" />
      </div>
    )
  }
  if (dirs.length === 0) {
    // iter-356.24 (Maya iter-356.23 Major #1 carryover): migrated
    // from plain-text shrug to <CatEmptyState> primitive so this
    // surface matches Events / People / Timelapses / Review.
    return (
      // iter-356.57: Mushu is the Greeter (cat-brand brief). Body
      // copy names him as the queue keeper for unfamiliar faces.
      <CatEmptyState
        mood="curious"
        heading="Nothing to review."
        body="When the camera sees an unfamiliar face, Mushu queues a photo here so you can name them."
        hint="Check that face recognition is turned on in Settings."
      />
    )
  }
  const onDeleteAll = async (name: string, count: number) => {
    const ok = await confirm({
      title: `Delete all captures of ${_displayName(name)}?`,
      body: `Delete ${count} captures of ${_displayName(name)}? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      const r = await deleteTrainingCaptures(name)
      toast.showToast(`Deleted ${r.deleted} captures`, 'success')
      setDirs((cur) => (cur ? cur.filter((x) => x.name !== name) : cur))
    } catch (e) {
      toast.showToast(`Delete failed: ${formatError(e)}`, 'error')
    }
  }

  return (
    <>
      {/* iter-356.x (Frank I2 + feature audit P2-2): pre-fix every
          person card showed a "Consent required" amber badge with no
          inline explanation of what consent means. Frank: "She doesn't
          know what consent means in this context." A one-line section
          explainer at the top of the gallery sets context once. */}
      <p className="text-sm text-[var(--color-text-secondary)] px-1 -mt-1 mb-2">
        Grant consent to include each person&apos;s photos in training-
        data exports. The camera still recognizes everyone normally
        either way — consent only affects exports.
      </p>
      <ul className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-3 list-none">
        {dirs.map((d) => (
        <li key={d.name}>
          <div className="flex flex-col gap-2 bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] rounded-[var(--radius-xl)] p-3 shadow-[var(--shadow-card),var(--shadow-card-inset)] [@media(hover:hover)]:hover:border-[var(--color-border-strong)] transition-colors">
          <button
            type="button"
            onClick={() => onPick(d.name)}
            className="w-full text-left flex items-center gap-3 min-h-[48px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 rounded-lg"
            aria-label={`${_displayName(d.name)}: ${d.count} ${d.count === 1 ? 'photo' : 'photos'}, most recent ${_formatRelative(d.latest_ts)}`}
          >
            {/* iter-355aa (Maya: Iconography Major): success-green is
                the positive-recognition semantic color — keep it off
                the fallback avatar. Sunroom sweep: warm-brass portrait
                chip (decorative-neutral, matches People) so both
                face-suite pages share the family-album avatar voice. */}
            <div className="w-16 h-16 rounded-xl bg-[var(--color-brass-subtle)] border border-[var(--color-brass-border)] flex items-center justify-center flex-shrink-0">
              <span aria-hidden="true" className="text-2xl font-semibold text-[var(--color-brass-default)]">
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
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <ConsentControl name={d.name} />
            <Button
              variant="destructive"
              size="md"
              onClick={() => onDeleteAll(d.name, d.count)}
              aria-label={`Delete all captures of ${_displayName(d.name)}`}
            >
              Delete all
            </Button>
          </div>
          </div>
        </li>
      ))}
      </ul>
    </>
  )
}

// iter-356.6X (tiered-inference slice 4): per-name consent badge +
// grant/revoke control. The badge mirrors the server's stored
// record (default-deny shape on miss). Granting is one click;
// revoking goes through `useConfirm` so the operator must confirm
// breaking the consent chain. consent_text_version is hard-coded
// to 'v1' for now — when the household prose changes the operator
// bumps this string + re-prompts.
function ConsentControl({ name }: { name: string }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [record, setRecord] = useState<ConsentRecord | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getNameConsent(name)
      .then((r) => {
        if (cancelled) return
        setRecord(r)
      })
      .catch(() => {
        if (cancelled) return
        setRecord({
          granted: false,
          recorded_at_ms: null,
          consent_text_version: null,
          recorded_by: null,
        })
      })
    return () => {
      cancelled = true
    }
  }, [name])

  const onClick = async () => {
    if (busy || record === null) return
    if (record.granted) {
      const ok = await confirm({
        title: 'Revoke consent?',
        body: `Revoke consent for ${_displayName(name)}? Their captures will be excluded from future exports.`,
        confirmLabel: 'Revoke',
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const next = await setNameConsent(name, !record.granted, 'v1')
      setRecord(next)
      toast.showToast(
        next.granted ? 'Consent granted' : 'Consent revoked',
        'success',
      )
    } catch (e) {
      toast.showToast(`Could not save consent: ${formatError(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  if (record === null) {
    return (
      <span className="text-xs text-[var(--color-text-secondary)]">
        Loading consent…
      </span>
    )
  }

  const grantedDate =
    record.granted && record.recorded_at_ms != null
      ? new Date(record.recorded_at_ms).toISOString().slice(0, 10)
      : null

  return (
    <div className="flex items-center gap-2">
      <span
        className={
          'text-xs px-2 py-0.5 rounded-full ' +
          (record.granted
            ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
            : 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]')
        }
        aria-live="polite"
      >
        {record.granted
          ? `Consent granted ${grantedDate ?? ''}`.trim()
          : 'Consent required'}
      </span>
      <Button
        variant="ghost"
        size="md"
        onClick={onClick}
        disabled={busy}
        aria-label={
          record.granted
            ? `Revoke consent for ${_displayName(name)}`
            : `Grant consent for ${_displayName(name)}`
        }
      >
        {record.granted ? 'Revoke' : 'Grant'}
      </Button>
    </div>
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
        className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-text-primary)] bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] hover:border-[var(--color-border-strong)] active:border-[var(--color-border-strong)] rounded-full px-3 py-2 min-h-[44px] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
        aria-label="Back to all people"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        All people
      </button>

      {error ? (
        <ErrorState
          title="Could not load these photos."
          retry={() => {
            setError(null)
            setFiles(null)
            setRetryNonce((n) => n + 1)
          }}
          technicalDetail={formatError(error)}
        />
      ) : files === null ? (
        <div role="status">
          <span className="sr-only">Loading photos…</span>
          <LoadingState shape="grid" />
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
                {/* Sunroom sweep: the tile whose action panel is open
                    reads as SELECTED — marmalade ring + light peach
                    accent-subtle wash (ink text on it, never white).
                    p-1/-m-1 keeps the tile footprint identical so the
                    grid doesn't reflow when the panel opens. */}
                <figure
                  className={
                    'space-y-1 rounded-2xl p-1 -m-1 transition-colors duration-[160ms] ease-out ' +
                    (openMenu === f.filename
                      ? 'ring-2 ring-[var(--color-accent-default)] bg-[var(--color-accent-subtle)]'
                      : '')
                  }
                >
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
                          'flex-shrink-0 px-1.5 py-0.5 text-xs font-semibold rounded tabular-nums ' +
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
                      className="flex-shrink-0 min-w-[44px] min-h-[44px] inline-flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-raised)] rounded focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
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
                      className="w-full px-2 py-2 min-h-[44px] text-sm font-medium text-[var(--color-text-primary)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)] border-[1.5px] border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-full focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
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
    // Sunroom sweep: the action surface floats as a paper card with
    // the overlay shadow, sitting on the selected tile's peach wash.
    <div className="space-y-2 mt-1 p-2 rounded-[var(--radius-xl)] bg-[var(--color-surface)] border-[1.5px] border-[var(--color-border)] shadow-[var(--shadow-overlay)]">
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
                className="px-2 py-1 min-h-[44px] text-xs font-medium bg-[var(--color-surface-raised)] hover:bg-[var(--color-accent-subtle)] disabled:bg-[var(--color-surface)] disabled:text-[var(--color-text-tertiary)] disabled:cursor-not-allowed text-[var(--color-text-primary)] rounded-full focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
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
                className="px-2 py-1 min-h-[44px] text-xs font-medium border border-dashed border-[var(--color-border-strong)] hover:border-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--color-text-primary)] rounded-full focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2 transition-colors"
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
              // iter-356.66 (iOS oddities sweep): text-sm = 14 px after
              // the Slice-A token bump, still under iOS Safari's 16-px
              // zoom-on-focus threshold. Bumped to text-base so the
              // training-page name input doesn't reflow the gallery
              // grid the moment the operator taps it on a phone.
              className="mt-1 w-full px-2 py-2 min-h-[44px] bg-[var(--color-bg)] border border-[var(--color-border-strong)] rounded text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
            />
          </label>
          {/* iter-356.3c: Move via Button primitive; redesign fix bumps
              the touch-heavy action panel to size=md (full tap target). */}
          <div className="flex gap-1">
            <Button
              variant="primary"
              size="md"
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
          size="md"
          onClick={onDelete}
          disabled={actionInflight}
          className="flex-1"
        >
          Delete
        </Button>
        <Button
          variant="ghost"
          size="md"
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
