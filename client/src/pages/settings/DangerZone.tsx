import { useState } from 'react'
import {
  listBackups,
  rebootJetson,
  triggerBackup,
  triggerRestore,
  triggerUpdate,
  type BackupItem,
  type RestoreStatus,
  type UpdateStatus,
} from '../../lib/api'
import { Button } from '../../components/primitives/Button'
import { useConfirm } from '../../lib/confirm'
import { formatBytes, formatError } from '../../lib/format'
import { log, errFields } from '../../lib/log'
import { useReportError, useToast } from '../../lib/toast'

// iter-293: extracted from Settings.tsx (~120 lines of inline JSX +
// 4 destructive handlers + restore form state). Owner-only block —
// parent gates rendering with `{isOwner && <DangerZone />}`. The
// server enforces require_role("owner") on every route this hits;
// the client visibility hide is belt-and-braces.
//
// Visual gradient: blue (Backup, safe) → amber (Update, medium) →
// red (Restore + Reboot, destructive). All four routes return a
// `note` field while the host-helper is operator-blocked
// (CLAUDE.md "Stub-with-note pattern" sharp edge); the toast
// surfaces an honest "isn't set up yet" message instead of a
// fake green-checkmark success.

function updateToastFor(
  r: { note?: string; status?: UpdateStatus },
): { message: string; variant: 'success' | 'info' | 'error' } {
  if (r.note || r.status === 'unavailable') {
    return {
      message: "Update isn't set up yet on the camera box. Nothing was installed.",
      variant: 'info',
    }
  }
  if (r.status === 'blocked') {
    return {
      message: 'Update is blocked right now. Nothing was installed.',
      variant: 'error',
    }
  }
  if (r.status === 'staged') {
    return {
      message: 'Update is staged, but it has not been applied yet.',
      variant: 'info',
    }
  }
  if (r.status === 'rolled_back') {
    return {
      message: 'Update was rolled back. The camera box kept the previous version.',
      variant: 'error',
    }
  }
  if (r.status === 'applied') {
    return { message: 'Update applied', variant: 'success' }
  }
  return { message: 'Update requested', variant: 'success' }
}

function restoreToastFor(r: {
  note?: string
  status?: RestoreStatus
  backup_path?: string
}): { message: string; variant: 'success' | 'info' | 'error' } {
  if (r.note) {
    return {
      message: "Restore isn't set up yet on the camera box. Nothing was changed.",
      variant: 'info',
    }
  }
  if (r.status === 'no_backups') {
    return {
      message: 'No backups are available yet. Nothing was restored.',
      variant: 'info',
    }
  }
  if (r.status === 'invalid_backup') {
    return {
      message: 'That backup file is not valid. Nothing was restored.',
      variant: 'error',
    }
  }
  if (r.status === 'incompatible') {
    return {
      message: 'That backup does not match this camera box. Nothing was restored.',
      variant: 'error',
    }
  }
  if (r.status === 'dry_run_failed') {
    return {
      message: 'Restore check failed before anything changed.',
      variant: 'error',
    }
  }
  if (r.status === 'dry_run_only') {
    return {
      message: 'Restore check finished. Nothing was changed.',
      variant: 'info',
    }
  }
  if (r.status === 'rolled_back') {
    return {
      message: 'Restore was rolled back. The current settings were kept.',
      variant: 'error',
    }
  }
  if (r.status === 'restored') {
    return {
      message: `Restored from ${r.backup_path ?? 'backup'}`,
      variant: 'success',
    }
  }
  return {
    message: `Restored from ${r.backup_path ?? 'backup'}`,
    variant: 'success',
  }
}

export function DangerZone() {
  const confirm = useConfirm()
  const { showToast } = useToast()
  const reportError = useReportError()
  // iter-237: inline restore-from-backup form. null = button view;
  // string = form open with current selected filename. iter-239
  // populates the dropdown from the live backup list.
  const [restorePath, setRestorePath] = useState<string | null>(null)
  const [restoreSubmitting, setRestoreSubmitting] = useState(false)
  const [backupList, setBackupList] = useState<BackupItem[] | null>(null)

  const onReboot = async () => {
    // iter-356.C (mobile-redesign Slice C — security clarity): be
    // specific about what reboot disrupts. Pre-356.C the body said
    // "unavailable for about 30 seconds", which is true but doesn't
    // warn that an in-flight clip recording is lost (the post-roll
    // ffmpeg dies with the host) or that any open Live tab will
    // need to manually Reconnect. Push subscriptions DO survive —
    // they're persisted in push_subs.json on disk.
    const ok = await confirm({
      // Premium-launch slice (Frank top-3 #3): "Reboot Jetson?"
      // leaked the SoC brand into user-facing copy. The visible
      // button below already reads "Restart camera box"; the
      // confirm title now matches that vocabulary so a 72-year-old
      // tapping the button doesn't second-guess whether they hit
      // the right one.
      title: 'Restart the camera box?',
      body:
        'The camera and detection will be unavailable for about 30 seconds. Any clip currently being recorded will be lost. Open Live tabs will need to tap Reconnect. Saved logins and push notification setup are preserved.',
      // Premium-launch slice: confirm action label tracks the
      // surface vocabulary too — "Reboot" → "Restart" matches
      // the button + title.
      confirmLabel: 'Restart',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    try {
      const r = await rebootJetson()
      // The server returns `note` when the endpoint is still a
      // scaffold (no host-side helper wired up yet). Don't claim
      // we rebooted when we didn't; surface the truth instead.
      if (r.note) {
        showToast(
          "Restart isn't set up yet on the camera box. Nothing changed.",
          'info',
        )
      } else {
        showToast('Reboot requested', 'success')
      }
    } catch (e) {
      // docs/logging_plan.md §2: reboot/backup/update/restore are the
      // HIGHEST-consequence ops in the app and were toast-only — a
      // failed reboot left no durable record. Pair each toast with a
      // structured ERROR carrying the status / network reason.
      reportError('dangerZone:reboot-failed', 'Reboot failed: ' + formatError(e), errFields(e))
    }
  }

  // iter-211 (Feature #10 slice 2): mirror onReboot — owner-only,
  // confirm-gated, surface server's `note` when stubbed instead of
  // pretending success.
  const onBackup = async () => {
    const ok = await confirm({
      title: 'Back up camera settings?',
      // iter-356.19 (Frank Round-6 #4 + Round-7 #2): "VAPID keys"
      // and "push subscriptions" are jargon. Frank: "VAPID. My wife
      // thinks it's a medical term." Plain-English equivalent.
      body: 'Saves your accounts, notification setup, detection settings, and camera zones to the backup folder.',
      confirmLabel: 'Back up',
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    try {
      const r = await triggerBackup()
      if (r.note) {
        showToast(
          "Backup isn't set up yet on the camera box. Nothing was saved.",
          'info',
        )
      } else {
        showToast('Backup requested', 'success')
      }
    } catch (e) {
      reportError('dangerZone:backup-failed', 'Backup failed: ' + formatError(e), errFields(e))
    }
  }

  // iter-231 (Feature #12 OTA slice 2): mirror onBackup. Owner-only
  // software update. Destructive (replaces running code + restarts
  // services) so confirm dialog warns about ~30 s service
  // unavailability.
  const onUpdate = async () => {
    // iter-356.C (mobile-redesign Slice C — security clarity):
    // expand on what's disrupted so the operator isn't surprised.
    // In-flight clips die with the server restart; existing Live
    // tabs disconnect; logins and push subscriptions persist
    // because they're on disk (users.db + push_subs.json).
    const ok = await confirm({
      // Premium-launch slice (Frank top-3 #2): "Update server
      // software" reads as datacenter copy. The button now reads
      // "Install camera updates"; the confirm title matches.
      title: 'Install camera updates?',
      body:
        'Installs the new version and restarts the server. The camera and detection are unavailable for about 30 seconds. Any clip currently being recorded will be lost. Open Live tabs will need to tap Reconnect. Saved logins and push notification setup are preserved.',
      confirmLabel: 'Install',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    try {
      const r = await triggerUpdate()
      const toast = updateToastFor(r)
      showToast(toast.message, toast.variant)
    } catch (e) {
      reportError('dangerZone:update-failed', 'Update failed: ' + formatError(e), errFields(e))
    }
  }

  // iter-237 (Feature #12 OTA slice 6): submit the inline-form
  // restore. backup_path comes from the user's text input; server
  // (iter-212) does the two-tier traversal defense. Confirm dialog
  // before destructive write because restore wipes current state.
  const onRestoreSubmit = async () => {
    const path = (restorePath ?? '').trim()
    if (!path || restoreSubmitting) return
    const ok = await confirm({
      title: 'Restore from backup?',
      // iter-356.19 (Frank Round-6 #4 + Round-7 #2): jargon strip.
      body: `Replaces your accounts, notification setup, detection settings, and camera zones with what's in "${path}". This can't be undone.`,
      confirmLabel: 'Restore',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    setRestoreSubmitting(true)
    try {
      const r = await triggerRestore(path)
      const toast = restoreToastFor(r)
      showToast(toast.message, toast.variant)
      // Close the form on any non-error completion (stubbed or real).
      setRestorePath(null)
    } catch (e) {
      // NEVER log `path` raw — it's user-typed and the server's
      // traversal defense owns rejecting it; the status carries the
      // diagnostic. Log only the error shape.
      reportError('dangerZone:restore-failed', 'Restore failed: ' + formatError(e), errFields(e))
    } finally {
      setRestoreSubmitting(false)
    }
  }

  return (
    <>
      {/* iter-355ac (Maya Critical 1): hierarchy fix. Pre-iter-355ac
          all 4 buttons rendered as identical 2xl pills with no
          grouping — blue Back-up looked the same weight as red
          Reboot. Now: Maintenance section (Back up + Update as
          neutral outline buttons) clearly separated from a
          "Danger zone" section (Restore + Reboot, the only red-
          fill treatments). The header copy tells the user what
          they're about to mess with. */}
      {/* iter-356.2: button primitive applied. Maintenance buttons
          = secondary variant; Restore + Reboot below = destructive. */}
      {/* Premium-launch slice (Frank top-3 #2): the section header
          + caveat paragraph were datacenter copy ("Maintenance",
          "host-side helpers", "configured by whoever installed
          your camera"). The replacement keeps the operator-honest
          stub-with-note signal but speaks to the household user
          who actually opens this tab. */}
      {/* redesign/warm-boutique (Sunroom): the four buttons used to
          float directly on the linen page with the tabpanel's 24px
          gaps between them — no grouping surface at all. Now two
          paper cards matching the Section primitive's tier: a calm
          maintenance card, and a distinct danger card whose
          danger-muted border keeps the destructive cluster visibly
          separate. Whimsy never touches this surface — the danger
          card must read genuinely serious.
          Playroom Modern (Task 8 sweep): migrated the hand-rolled
          `rounded-2xl` + `shadow-card` recreation onto the shared
          `.card-paper` class (Task 3's flat-paper grammar — 1.5px
          hairline, `--radius-xl`) so this card matches every Section
          row-group in the app. */}
      <div className="card-paper p-4 space-y-2">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
          Camera maintenance
        </h3>
        <p className="text-xs text-[var(--color-text-secondary)] mb-3">
          These options need a one-time setup on the camera box by
          the person who first installed it. If that&apos;s not done
          yet, tapping a button will tell you so — nothing will
          break.
        </p>
        {/* Premium-launch slice (Frank top-3 #2): button labels in
            camera-product vocabulary. "Back up server state" → "Back
            up camera settings"; "Update server software (~30 s
            outage)" → "Install camera updates". The 30 s outage is
            already in the confirm body — duplicating a truncated
            warning on the button label trains the user to skip the
            confirm dialog. */}
        <Button variant="secondary" size="lg" fullWidth onClick={onBackup}>
          Back up camera settings
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          onClick={onUpdate}
          disabled
          aria-describedby="ota-launch-status"
        >
          Install camera updates
        </Button>
        <p
          id="ota-launch-status"
          role="status"
          className="text-xs font-semibold text-[var(--color-warning)]"
        >
          Unavailable for this release. The operator installs versioned builds
          from a laptop; release signing is not production-supported yet.
        </p>
      </div>
      {/* Playroom Modern (Task 8 sweep): same card-grammar migration as
          the maintenance card above (1.5px border, `--radius-xl`, no
          shadow) but can't use the `.card-paper` class verbatim — its
          border color is fixed to `--color-border`, and this card's
          whole point is the danger-muted border that visually separates
          the destructive cluster. Border width/radius now match; color
          stays danger. */}
      <div className="bg-[var(--color-surface)] border-[1.5px] border-[var(--color-danger-muted)] rounded-[var(--radius-xl)] p-4 space-y-2">
        <h3 className="text-lg font-semibold text-[var(--color-danger)]">
          Danger zone
        </h3>
        {/* Premium-launch slice (Frank top-3): "interrupt service"
            and "change disk state" / "backup snapshot" are
            cable-company + datacenter language. Plain English
            without softening the gravity. The "Danger zone"
            heading itself stays — universal, dramatic in the
            right way, deliberately loud. */}
        <p className="text-xs text-[var(--color-text-secondary)] mb-3">
          These actions are harder to undo. Restore replaces your
          current settings with a saved backup. Restart takes the
          camera offline for about 30 seconds.
        </p>
      {/* iter-237 (Feature #12 slice 6): inline restore form.
          Two-tap pattern — first tap opens the form (cheap path
          for the common no-restore case), second-tap-on-Restore
          triggers the confirm dialog (the iter-212 server is
          auth-gated + path-traversal-defended; the client is
          just collecting the filename). */}
      {restorePath === null ? (
        <Button
          variant="destructive"
          size="lg"
          fullWidth
          onClick={() => {
            setRestorePath('')
            // iter-239: lazy-fetch the backup list when the form
            // opens.
            listBackups()
              .then((r) => {
                setBackupList(r.items)
                if (r.items.length > 0) {
                  setRestorePath(r.items[0].filename)
                }
              })
              .catch((e) => {
                // docs/logging_plan.md §2: the empty-array fallback
                // renders "No backups found" — a silent failure looks
                // identical to a genuinely empty backup folder, so the
                // operator can't tell a misconfig from "nothing saved
                // yet". Log the status. Toast-only would be noisy here
                // (the form is mid-open), so this is log-only ERROR.
                log.error('dangerZone:list-backups-failed', errFields(e))
                setBackupList([])
              })
          }}
        >
          Restore from backup
        </Button>
      ) : (
        // Sunroom sweep: /opacity-on-var tints → the pre-mixed danger
        // surface tokens (color-mix'd in index.css).
        <div className="w-full p-3 rounded-[var(--radius-xl)] bg-[var(--color-danger-bg)] border-[1.5px] border-[var(--color-danger-border)] space-y-2">
          {backupList === null ? (
            <p className="text-sm text-[var(--color-text-secondary)]">Loading backups…</p>
          ) : backupList.length === 0 ? (
            <p
              className="text-sm text-[var(--color-text-secondary)]"
              aria-label="No backups available"
            >
              No backups found. Run Backup first to create one.
            </p>
          ) : (
            <label className="block">
              <span className="text-sm text-[var(--color-text-secondary)]">Backup file</span>
              <select
                value={restorePath}
                onChange={(e) => setRestorePath(e.target.value)}
                aria-label="Backup file"
                className="w-full mt-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-base text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
                disabled={restoreSubmitting}
              >
                {backupList.map((b) => (
                  <option key={b.filename} value={b.filename}>
                    {b.filename} ({formatBytes(b.size_bytes)})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="md"
              onClick={onRestoreSubmit}
              disabled={
                !restorePath.trim() ||
                backupList === null ||
                backupList.length === 0
              }
              loading={restoreSubmitting}
              loadingText="Restoring…"
              aria-label="Restore from backup"
              className="flex-1"
            >
              Restore
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setRestorePath(null)
                setBackupList(null)
              }}
              disabled={restoreSubmitting}
              aria-label="Cancel restore"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
        <Button
          variant="destructive"
          size="lg"
          fullWidth
          onClick={onReboot}
        >
          Restart camera box
        </Button>
      </div>
    </>
  )
}
