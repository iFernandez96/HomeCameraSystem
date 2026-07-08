**Challenges**

Push split into gateway + device legs: agree. Gateway 201/prune semantics are independently valuable; display/click is a different phone-dependent proof.

OTA/backup de-stub-first: agree. A harness over `ok: true` stubs would certify fiction.

Execution order: mostly agree, but move **Push gateway leg** ahead of **WebRTC/WHEP** and probably ahead of **Snapshot/thumb**. The gateway leg is already fixture-ready, cheap, and catches expiring VAPID/FCM/prune regressions; WHEP is live-rig heavier.

**Harness #1 Spec: Retention + Byte-Budget Evictor**

Create `server/tests/harness_retention/`:

- `__init__.py`
- `manifest_fixture.py`
- `test_retention_manifest.py`

Gate exactly like `server/tests/test_real_snapshot.py`: compute repo root from `Path(__file__).resolve().parents[3]`, fixture path `.jetson-snapshot/proof_fixtures/recordings_manifest.txt`, module-level `pytestmark = pytest.mark.skipif(not MANIFEST.exists(), reason="no Jetson recordings manifest - capture .jetson-snapshot/proof_fixtures/recordings_manifest.txt")`.

Drives real server code in `server/app/services/recording_service.py`:

- `sweep_old_clips(retention_days)`
- `_list_clips_by_mtime(rec_dir)` indirectly through evictor
- `evict_to_free_space(min_free_bytes, disk_usage=..., list_clips=...)`
- `sweep_and_evict(retention_days)` after adding injectable kwargs:
  `disk_usage=None, list_clips=None`, passed through to `evict_to_free_space`.
- Constants: `SERVER_MIN_FREE_BYTES`
- Cross-module floor invariant: import `detection/visit_runtime.py::WORKER_MIN_FREE_BYTES` by temporarily adding repo `detection/` to `sys.path`, matching existing detection tests.

Manifest parser:

- Input is `ls -ln --time-style=+%s` lines:
  `-rw-r--r-- 1 1000 1000 SIZE MTIME /home/.../NAME`
- Last line is `df -B1`:
  `/dev/mmcblk0p1 TOTAL USED AVAIL PCT /`
- Parse exactly 400 regular file rows; assert all parsed names are basename-only and all real rows end `.mp4`.
- Parse `df_avail_bytes` from column 4. This is the starting free-space model.

Scratch builder:

- For each parsed clip, create `tmp_path / "recordings" / name`.
- Use `Path.touch()`, `Path.truncate(size)` for sparse files. Do not copy 10GB.
- Apply `os.utime(path, (mtime, mtime))`.
- Monkeypatch `settings.recordings_dir` to scratch dir.
- Add sentinel files:
  `notes.txt`, `operator.mov`, `_preroll/seg_000.mp4`, `_visits/openvisit/seg_000.mp4`, `.open_visits.json`, `activevisit.mp4.tmp`.
- Add sidecars for selected clips:
  `<old_expired>.tracks.json`, `<fresh_evicted>.tracks.json`, `<fresh_survivor>.tracks.json`, with mtimes matching their MP4s.

Free-space model:

- Implement `DiskModel(start_free)` callable returning `shutil.disk_usage`-like namedtuple.
- On each call, free = `start_free + sum(size of deleted parsed mp4s)`.
- Do not use real filesystem `statvfs`; this is the statvfs/disk_usage injection seam proving behavior under captured Jetson `df -B1` pressure.
- Test must fail until `sweep_and_evict` accepts and forwards `disk_usage`.

Pinned invariants:

- Expiry before age eviction: `sweep_and_evict(retention_days=7, disk_usage=model)` deletes all clips older than `now - 7d` through sweep before byte eviction considers fresh survivors. Freeze `recording_service.time.time` to `max(mtime)+60` so “expired” is deterministic against the manifest.
- Byte floor: final modeled free bytes is `>= SERVER_MIN_FREE_BYTES` unless all evictable MP4s are gone; deleted count/freed bytes match the exact oldest-survivor prefix needed to cross the floor.
- Eviction order: byte eviction deletes fresh-but-oldest survivors by mtime ascending, never by filename or size.
- Worker/server ordering: `WORKER_MIN_FREE_BYTES > SERVER_MIN_FREE_BYTES`.
- Never touch non-evictable paths: non-mp4, `_preroll/*`, `_visits/*`, `.open_visits.json`, and `*.mp4.tmp` survive.
- Sidecars: time sweep removes expired `.tracks.json`; byte eviction deleting an MP4 does not delete its sidecar today, so pin current policy explicitly as “sidecar remains for later time sweep” unless implementation is intentionally changed.
- Idempotency: running the same pass twice leaves the second result `{"swept": 0, "evicted": 0, "freed_bytes": 0}` once the modeled floor is satisfied, with sentinels still present.
- Real manifest integrity: assert 400 MP4s, total sparse logical bytes equals parsed sum, and mtimes round-trip exactly.

BDD test names:

- `test_given_real_manifest_when_scratch_built_then_sizes_and_mtimes_match_without_copying_payloads`
- `test_given_real_manifest_under_disk_pressure_when_sweep_and_evict_runs_then_expired_clips_delete_before_byte_eviction`
- `test_given_real_manifest_when_evicting_to_server_floor_then_oldest_fresh_prefix_is_deleted_until_floor_is_met`
- `test_given_recordings_dir_with_preroll_visits_tmp_and_non_mp4_when_retention_runs_then_only_top_level_mp4_and_tracks_policy_apply`
- `test_given_evicted_manifest_when_retention_runs_again_then_it_is_idempotent`
- `test_given_worker_and_server_disk_floors_when_imported_then_worker_floor_is_above_server_floor`

Supersedes the mock-hollow confidence in `server/tests/test_recording_service.py` for `sweep_old_clips`, `evict_to_free_space`, and `sweep_and_evict`. Keep that unit file for path validation, malformed IDs, missing dirs, and small failure cases.
