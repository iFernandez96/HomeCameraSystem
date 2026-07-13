# PR-201 recovery inventory and authentication policy

Status: accepted for the constrained initial launch, 2026-07-13.

## Backup consistency contract

The backup route never adds a live SQLite file or its `-wal`/`-shm` sidecars to
an archive. It materializes `users.db`, `events.db`, and `audit.db` with
SQLite's online backup API, changes the closed snapshot to standalone DELETE
journal mode, and requires `PRAGMA integrity_check` to return exactly `ok`.
Committed writes may continue while each database is copied. Each database is
a valid point-in-time SQLite snapshot; the three independent databases are not
claimed to share one cross-database transaction boundary.

Ordinary state files are copied into the same private staging tree before the
manifest is hashed and the archive is written. The staging tree is removed on
success and failure. The published manifest records optional missing files and
identifies SQLite entries with `kind: sqlite`.

## Included recovery state

| State | Policy | Restore validation |
|---|---|---|
| `users.db` | Required, online SQLite snapshot | integrity check, schema loader, user query |
| `events.db` | Required, online SQLite snapshot | integrity check |
| `audit.db` including login backoff | Required, online SQLite snapshot | integrity check |
| VAPID private/public keys | Required | cryptographic key-pair validation |
| Push subscriptions | Optional | JSON list and real loader |
| Detection configuration and zones | Optional | JSON object and real loader |
| Clip-share digest records | Optional | JSON object |
| Daily-digest state | Optional | JSON object |
| Camera exposure configuration and presets | Optional | JSON object/list |
| Security-platform state | Optional | JSON object; ephemeral timeline jobs cleared |

Optional means absence is recorded in the manifest rather than blocking a
backup. It does not mean an existing file may be skipped.

## Authentication decision

Session continuity is intentionally not restored. `jwt_secret.bin` and
`sessions.db` are excluded from the archive. After all restored state passes
validation, the production restore path atomically persists a new JWT signing
secret and clears session rows. Consequently every access and refresh token
issued before restore fails signature verification and every client must log
in again. A restore cannot report success if durable key rotation or session
cleanup fails.

An older compatible archive containing a JWT secret may still be read through
the existing restore role, but the production restore rotates it immediately;
archived credentials are never made active as the terminal state.

## Explicit exclusions

| State | Reason and recovery treatment |
|---|---|
| JWT secret and sessions database | Deliberately replaced/cleared to force reauthentication. |
| Backup output directory | It is the destination, not an input; PR-202 adds encrypted off-device replication. |
| Backup ledger | Current operational evidence remains outside the archive being recorded and accompanies later replication/drill evidence. |
| Event clips, continuous recordings, snapshots, timelapses, face/person crops and consent files | Media corpus is outside the bounded system-state archive. Retention or separate media replication is an operator policy; PR-201 makes no media-protection claim. |
| Security timeline/incident exports | Ephemeral, reproducible exports; restore also clears their stale job records. |
| In-flight host-action and camera watchdog state | Runtime recovery state must not replay after a system restore. |
| Worker authentication secret and deterrence adapter | Root-owned host provisioning, restored by the deployment/recovery runbook rather than the server archive. |
| Client distribution | Versioned release artifact, restored by deployment rollback. |
| OTA manifest, artifacts, staging, active pointer and ledger | OTA remains disabled and this state belongs to PR-302/PR-303. |
| Static Compose, MediaMTX, systemd and application source | Version-controlled release inputs, not runtime backup data. |

The executable classification for every path-valued server setting is
`backup_manifest.PERSISTENCE_POLICY`; its completeness is pinned by PR-201
tests. Adding a new persisted path requires choosing an included or excluded
policy and updating this record.
