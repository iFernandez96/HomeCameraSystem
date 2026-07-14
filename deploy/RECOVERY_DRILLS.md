# Recovery drills

`deploy/recovery-drill.sh` packages the recurring server-restart, disk-floor,
session-revocation, and MediaMTX recovery exercises. It prints its actions by
default and changes nothing:

```sh
./deploy/recovery-drill.sh --dry-run all
```

Run one drill during a maintenance window only after checking that the unit
names and `HOMECAM_BASE_URL` match the target:

```sh
export HOMECAM_DRILL_CONFIRM=YES
export HOMECAM_BASE_URL=http://127.0.0.1:8000
./deploy/recovery-drill.sh --execute media
```

The disk drill deliberately uses temporary-directory tests rather than filling
the recording filesystem. The session drill uses the test fixtures and never
revokes a production session. Server and media execution are disruptive and
therefore require the explicit confirmation variable.

## Off-box alert delivery drill

The PR-206 drill injects synthetic alerts directly into loopback-only
Alertmanager. It includes every critical rule plus the successful
server-restart warning, waits for grouped Web Push delivery, resolves the same
alerts, and requires exactly one successful receiver log for each firing and
recovery transition. Synthetic annotations contain no production identifiers,
paths, credentials, or data.

First confirm at least one off-box browser/phone has a working HomeCam Web Push
subscription with `Settings -> Send`, then preview the alert names:

```sh
bash deploy/alert-drill.sh --dry-run
```

Execute only when the operator is ready for the notification burst:

```sh
export HOMECAM_DRILL_CONFIRM=YES
bash deploy/alert-drill.sh --execute
```

A passing script proves Alertmanager deduplication, receiver acceptance, and
Web Push gateway submission. The operator must separately confirm that each
notification displayed once on the off-box device and that recovery notices
were visible; a Jetson-local log cannot prove OS notification display.

Total Jetson power-off is deliberately outside this on-box stack. The Android
wrapper's persisted `JetsonHealthJobService` probes `/healthz` independently,
notifies after two failed checks, and sends a recovery notification when the
Jetson returns. Verify that criterion on a connected phone by powering the
Jetson off long enough for two job runs, without stopping or force-closing the
Android wrapper.

## Encrypted backup key setup

Generate the recovery pair on the recovery machine, never on the Jetson. Keep
the private file outside the repository and outside routine deployment syncs:

```sh
mkdir -p "$HOME/.config/homecam"
PYTHONPATH="$PWD:$PWD/server" .venv/bin/python \
  -m app.scripts.gen_backup_key \
  --private-key "$HOME/.config/homecam/backup-recovery-private.pem" \
  --public-key "$HOME/.config/homecam/backup-recipient-public.pem"
stat -c 'mode=%a bytes=%s path=%n' \
  "$HOME/.config/homecam/backup-recovery-private.pem"
```

The private-key mode must be `600`. Transfer only the public file, then install
it on the Jetson without printing either key:

```sh
scp "$HOME/.config/homecam/backup-recipient-public.pem" \
  jetson:/tmp/homecam-backup-recipient.pem
ssh jetson 'sudo install -o root -g root -m 0644 \
  /tmp/homecam-backup-recipient.pem /etc/homecam/backup-recipient.pem && \
  rm -f /tmp/homecam-backup-recipient.pem'
```

Do not place the private key on the Jetson, in the repository, in an image, or
in a support artifact. Loss of that private key makes every `.hcbk` artifact
unrecoverable; disclosure allows decryption of all artifacts for that recipient.

## Local encrypted backup schedule

Install and start the timer through `deploy/install-jetson.sh`, or explicitly:

```sh
sudo cp deploy/systemd/homecam-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now homecam-backup.timer
sudo systemctl start homecam-backup.service
sudo systemctl status homecam-backup.service homecam-backup.timer --no-pager
```

Verify ciphertext-only publication and status without displaying protected
content:

```sh
docker exec homecam-server python -m app.scripts.run_backup
find /srv/homecam-media/backups -maxdepth 1 -type f -printf '%f\n'
docker exec homecam-server python -c \
  'from app.config import settings; from app.services.backup_status import read_backup_status; import json; print(json.dumps(read_backup_status(settings.backup_status_path), sort_keys=True))'
```

Expected backup finals end in `.hcbk`. There must be no published
`.manifest.json`, `.tar.gz`, `.tmp`, or `.tmp~` backup file. The reported
replication state is intentionally `deferred_off_device`.

Migrate existing PR-201 plaintext backups only after provisioning the public
key and retaining a separately verified recovery copy:

```sh
docker exec homecam-server python -m app.scripts.migrate_plaintext_backups
```

The migration validates each old archive and sidecar, encrypts it, atomically
publishes `.hcbk`, and removes the plaintext pair. Do not interrupt it.

## Clean-scratch recovery drill

Copy one ciphertext artifact to the recovery machine for the drill. This
manual verification copy is not the deferred automatic off-device replication
control. Run the restore into a new local scratch root:

```sh
rm -rf /tmp/homecam-pr202-restore
PYTHONPATH="$PWD:$PWD/server" .venv/bin/python \
  -m app.scripts.verify_backup_recovery \
  --backup /path/to/homecam-backup-YYYYMMDDTHHMMSSZ.hcbk \
  --private-key "$HOME/.config/homecam/backup-recovery-private.pem" \
  --scratch /tmp/homecam-pr202-restore
```

Passing output reports `ok: true`, changed-file count, forced
reauthentication, elapsed time, and the 3,600-second RTO. The command never
prints restored contents or key bytes. Also mutate a disposable ciphertext
copy and confirm the command exits nonzero and leaves no decrypted restore
inputs; never tamper with the only retained backup.

## Explicit off-device deferral

PR-202 does not configure cloud storage, SSH replication, a laptop target, or
a second drive on the same Jetson. Automatic genuine off-device replication
and its 24-hour RPO remain future work. See
`docs/decisions/pr-202-encrypted-local-backups.md` and the roadmap; do not mark
that criterion complete from the daily local timer or a one-time drill copy.
