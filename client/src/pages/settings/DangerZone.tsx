import { useState } from 'react'
import {
  listBackups,
  rebootJetson,
  triggerBackup,
  triggerRestore,
  triggerUpdate,
  type BackupItem,
} from '../../lib/api'
import { Button } from '../../components/primitives/Button'
import { useConfirm } from '../../lib/confirm'
import { formatBytes, formatError } from '../../lib/format'
import { useToast } from '../../lib/toast'

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

export function DangerZone() {
  const confirm = useConfirm()
  const { showToast } = useToast()
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
      title: 'Reboot Jetson?',
      body:
        'The camera and detection will be unavailable for about 30 seconds. Any clip currently being recorded will be lost. Open Live tabs will need to tap Reconnect. Saved logins and push notification setup are preserved.',
      confirmLabel: 'Reboot',
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
      showToast('Reboot failed: ' + formatError(e), 'error')
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
      showToast('Backup failed: ' + formatError(e), 'error')
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
      title: 'Update server software?',
      body:
        'Installs the new version and restarts the server. The camera and detection are unavailable for about 30 seconds. Any clip currently being recorded will be lost. Open Live tabs will need to tap Reconnect. Saved logins and push notification setup are preserved.',
      confirmLabel: 'Update',
      cancelLabel: 'Cancel',
      destructive: true,
    })
    if (!ok) return
    try {
      const r = await triggerUpdate()
      if (r.note) {
        showToast(
          "Update isn't set up yet on the camera box. Nothing was installed.",
          'info',
        )
      } else {
        showToast('Update requested', 'success')
      }
    } catch (e) {
      showToast('Update failed: ' + formatError(e), 'error')
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
      if (r.note) {
        showToast(
          "Restore isn't set up yet on the camera box. Nothing was changed.",
          'info',
        )
      } else {
        showToast(`Restored from ${r.backup_path}`, 'success')
      }
      // Close the form on any non-error completion (stubbed or real).
      setRestorePath(null)
    } catch (e) {
      showToast('Restore failed: ' + formatError(e), 'error')
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
      <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide mt-2">
        Maintenance
      </h3>
      <Button variant="secondary" size="lg" fullWidth onClick={onBackup}>
        Back up server state
      </Button>
      <Button variant="secondary" size="lg" fullWidth onClick={onUpdate}>
        Update server software
      </Button>
      <div className="pt-3 mt-3 border-t border-[var(--color-border)]">
        <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wide">
          Danger zone
        </h3>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1 mb-3">
          These actions can interrupt service or change disk state.
          Restore overwrites current data with a backup snapshot;
          Reboot restarts the camera box.
        </p>
      </div>
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
              .catch(() => {
                setBackupList([])
              })
          }}
        >
          Restore from backup
        </Button>
      ) : (
        <div className="w-full p-3 rounded-2xl bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 space-y-2">
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
                className="w-full mt-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-2 text-base focus-visible:outline-2 focus-visible:outline-[var(--color-accent-default)] focus-visible:outline-offset-2"
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
        Reboot Jetson
      </Button>
    </>
  )
}
