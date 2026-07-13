# PR-202 scope decision: encrypted local backups

Date: 2026-07-13

## Decision

PR-202 delivers encrypted-at-rest backup publication, tamper detection, local
daily scheduling, backup age/status reporting, off-Jetson recovery-key custody,
plaintext migration, and clean-scratch recovery proof.

Genuine off-device replication and its `RPO <= 24 h` acceptance criterion are
explicitly deferred. The operator does not have an always-available laptop,
cloud destination, or SSH-accessible second system. A copy to another drive on
the same Jetson is not off-device and must never be represented as satisfying
that criterion. The API therefore reports `replication_status` as
`deferred_off_device`; the roadmap remains partially implemented and the
production checklist remains open.

## Encryption and publication contract

- The Jetson/container receives only an X25519 recipient public key through a
  read-only bind mount.
- The unencrypted recovery private key is generated and held off the Jetson.
- Each `.hcbk` envelope uses an ephemeral X25519 key, HKDF-SHA256, and
  AES-256-GCM. The authenticated plaintext contains the manifest and the
  PR-201 consistent tar snapshot as one bundle.
- The route-visible final is ciphertext only. The manifest is inside the
  envelope; there is no plaintext sidecar.
- Encryption writes a mode-0600 temporary ciphertext and atomically publishes
  it. The plaintext tar draft is deleted on success and every handled failure.
- A missing/malformed public key blocks before snapshot/archive creation.
- Header, ciphertext, or tag modification, and the wrong recovery key, fail
  authentication and remove all decrypted temporary output.

The format identifiers are versioned in
`server/app/services/backup_crypto.py` and
`server/app/services/backup_archive.py`. They are an internal recovery format,
not a general-purpose interchange standard.

## Scheduling and status

`homecam-backup.timer` creates a local encrypted backup daily at 03:15 with up
to 30 minutes of jitter and catches missed runs after boot. The status file
records backup time, age, ciphertext digest, recipient fingerprint, and the
explicit replication deferral. This schedule reduces local recovery-point age;
it does not provide an off-device RPO. The default local retention is the 14
newest valid backup names (`BACKUP_RETENTION_COUNT`); the just-created artifact
is protected from deletion. A shared filesystem lock serializes timer and API
backup/restore maintenance across container processes.

## Restore custody

Production Compose never mounts or configures the recovery private key. A
restore is therefore an operator recovery action: bring the key from the
off-Jetson recovery location for the bounded recovery session, verify a clean
scratch restore, then remove any temporary key copy. The normal production
restore route fails closed when no recovery key is mounted.

## Deferred follow-up

Future work must first select an independently powered and routinely reachable
destination. It then needs authenticated automatic replication, bounded
retries, remote integrity/retention checks, off-box outcome alerting, and a
measured `RPO <= 24 h` drill. Until that work is implemented and verified,
PR-202 is not complete as originally specified.
