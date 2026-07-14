from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


class Settings:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = int(os.getenv("PORT", "8000"))

    # iter-232 (Feature #12 OTA slice 3a): server version string. Hand-
    # bumped on releases. Used by `GET /api/system/version` so the
    # client (iter-233 slice 3b) can display "Server version 0.1.0"
    # in Settings + the eventual slice 4 host-helper can compare to a
    # registry tag for "update available?" checks. Operator updates
    # this value when cutting a new release; CI could automate via
    # sed-on-tag if a release pipeline lands.
    version: str = os.getenv("HOMECAM_VERSION", "0.1.0")

    vapid_private_key_path: Path = Path(
        os.getenv("VAPID_PRIVATE_KEY_PATH", "./vapid_private.pem")
    )
    vapid_public_key_path: Path = Path(
        os.getenv("VAPID_PUBLIC_KEY_PATH", "./vapid_public.pem")
    )
    vapid_subject: str = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")

    camera_device: str = os.getenv("CAMERA_DEVICE", "/dev/video0")

    # docs/multicam_contract.md (2026-07-07): camera registry. JSON
    # array of {"id","name","path"} objects; unset/invalid falls back
    # to the default single front_door/Front Door/cam entry (see
    # services/camera_registry.py — invalid values log WHY and never
    # crash boot).
    cameras_json: str = os.getenv("HOMECAM_CAMERAS", "")
    client_dist: Path = Path(os.getenv("CLIENT_DIST", "../client/dist"))
    snapshots_dir: Path = Path(os.getenv("SNAPSHOTS_DIR", "./snapshots"))
    # iter-201 (Feature #1 Event clip recording, slice 1): the dir
    # ffmpeg writes per-event MP4 clips into. Bind-mounted similarly
    # to snapshots_dir so the host-side recorder can write while the
    # containerized server reads. Sweeper deletes clips older than
    # `recordings_retention_days`.
    recordings_dir: Path = Path(os.getenv("RECORDINGS_DIR", "./recordings"))
    # MediaMTX's short-retention continuous fMP4 archive. Files live under
    # ``<root>/<mediamtx camera path>/<unix-seconds>.mp4`` and are deliberately
    # separate from the event-clip sweeper, which only scans the top level of
    # ``recordings_dir``.
    continuous_recordings_dir: Path = Path(
        os.getenv("CONTINUOUS_RECORDINGS_DIR", "./recordings/continuous")
    )
    recordings_retention_days: int = int(
        os.getenv("RECORDINGS_RETENTION_DAYS", "14")
    )
    # iter-351 (face-capture-for-retraining): the dir the worker's
    # face_recog/recognizer.py saves face crops into, organized by
    # what the classifier matched. Operator browses + sorts via the
    # iter-351 /api/face/captures route + iter-352 /training PWA page,
    # then re-runs encode_known_faces.py to update encodings.pkl.
    # Bind-mounted similarly to snapshots_dir + recordings_dir so the
    # host-side detection worker can write while the containerized
    # server reads.
    face_captures_dir: Path = Path(
        os.getenv("FACE_CAPTURES_DIR", "./face_captures")
    )
    # iter-356.62 (tiered-capture slices 1+2+3): parallel root for the
    # full-person crop the worker saves alongside each face crop. NOT a
    # subdir of face_captures_dir — the existing /face/captures listing
    # route walks face_captures_dir/<name>/ and would treat a nested
    # _person subtree as a name bucket. Same bind-mount + 0o600
    # conventions as face_captures_dir. Read by /api/training/export
    # (slice 2) when `kind=person`. Slice 3 sweeps + purges via
    # face_capture_sweeper + DELETE /api/training/captures.
    person_captures_dir: Path = Path(
        os.getenv("PERSON_CAPTURES_DIR", "./person_captures")
    )

    # Persisted Web Push subscriptions. Lives next to the VAPID PEMs in the
    # `homecam-secrets` Docker volume so it survives container restarts.
    push_subs_path: Path = Path(
        os.getenv("PUSH_SUBS_PATH", "./push_subs.json")
    )

    # User-tunable detection knobs (threshold, cooldown). Same volume as
    # push_subs / VAPID so changes survive a `docker compose up --build`.
    detection_config_path: Path = Path(
        os.getenv("DETECTION_CONFIG_PATH", "./detection_config.json")
    )

    mediamtx_whep_base: str = os.getenv("MEDIAMTX_WHEP_BASE", "http://localhost:8889")

    # iter-178: auth foundation (Auth Plan Phase 1). All four settings
    # are inert until Auth Phase 3 wires routes that consume them. The
    # paths default to the same `homecam-secrets` Docker volume that
    # holds VAPID + push_subs + detection_config — survives container
    # rebuilds. The token TTLs are the access/refresh defaults from the
    # plan; cookie_secure can flip to false in dev (vite at
    # http://localhost:5173) but stays true under TLS in prod.
    users_db_path: Path = Path(
        os.getenv("USERS_DB_PATH", "./users.db")
    )
    jwt_secret_path: Path = Path(
        os.getenv("JWT_SECRET_PATH", "./jwt_secret.bin")
    )
    access_token_ttl_s: int = int(os.getenv("ACCESS_TOKEN_TTL_S", "900"))
    refresh_token_ttl_s: int = int(os.getenv("REFRESH_TOKEN_TTL_S", "604800"))
    cookie_secure: bool = (
        os.getenv("COOKIE_SECURE", "true").lower() in ("true", "1", "yes")
    )

    # iter-179: Auth Plan Phase 2 env-var bootstrap. Both default to
    # empty string so a server with NO admin seeding starts cleanly.
    # When BOTH are set, lifespan calls `seed_from_env_if_empty(...)`
    # which inserts a single admin row IF AND ONLY IF the users
    # table is empty. The hash is pre-computed (operator runs argon2
    # CLI once, drops the result in env) — keeps plaintext passwords
    # out of compose files / journals. Day-2 operators use the
    # `gen_admin` script instead.
    admin_user_seed: str = os.getenv("HOMECAM_ADMIN_USER", "")
    admin_password_hash_seed: str = os.getenv("HOMECAM_ADMIN_PASSWORD_HASH", "")

    # iter-212 (Feature #10 slice 3): the dir that backup archives
    # land in (slice 4 host-helper writes; slice 3 restore reads).
    # The /api/system/restore route's `backup_path` body parameter
    # MUST `Path.resolve()` to a path under this dir — same pattern
    # as the iter-? SPA traversal-guard in `main.py`. Default ./backups
    # is dev-friendly; production should point at a mounted volume
    # (USB drive, NAS share) that's backed up by the host-helper.
    backup_target_dir: Path = Path(
        os.getenv("BACKUP_TARGET_DIR", "./backups")
    )
    backup_ledger_path: Path = Path(
        os.getenv("BACKUP_LEDGER_PATH", "/app/secrets/backup-ledger.jsonl")
    )

    # iter-213 (Feature #8 slice 1): the dir that daily-timelapse
    # MP4s land in. iter-213 ships the route + listing + stub; the
    # eventual host-side ffmpeg helper (slice 2, operator action)
    # writes `<YYYY-MM-DD>.mp4` files here from the day's snapshots.
    # Mounted at /timelapses by main.py (same StaticFiles pattern
    # as snapshots_dir).
    timelapses_dir: Path = Path(
        os.getenv("TIMELAPSES_DIR", "./timelapses")
    )

    # iter-216 (Feature #6 slice 1): SQLite-backed event store.
    # iter-216 ships the schema + helpers; slice 2 wires writes
    # through alongside the in-memory deque, slice 3 swaps the
    # deque read path, slice 4 adds /api/events/search. Same
    # secrets-volume placement convention as users.db / VAPID
    # keys / push_subs.json.
    events_db_path: Path = Path(
        os.getenv("EVENTS_DB_PATH", "./events.db")
    )
    clip_shares_path: Path = Path(
        os.getenv("CLIP_SHARES_PATH", "./clip_shares.json")
    )
    digest_state_path: Path = Path(
        os.getenv("DIGEST_STATE_PATH", "./daily_digest_state.json")
    )
    audit_db_path: Path = Path(
        os.getenv("AUDIT_DB_PATH", "/app/secrets/audit.db")
    )
    sessions_db_path: Path = Path(
        os.getenv("SESSIONS_DB_PATH", "/app/secrets/sessions.db")
    )
    host_action_state_path: Path = Path(
        os.getenv("HOST_ACTION_STATE_PATH", "/app/secrets/host_action.json")
    )
    camera_exposure_path: Path = Path(
        os.getenv("CAMERA_EXPOSURE_PATH", "/app/secrets/camera_exposure.json")
    )
    # Security-platform state contains automation webhook credentials,
    # incident notes and deterrence audit records. Keep it on the private
    # persistent volume; SecurityStore atomically writes it mode 0o600.
    security_state_path: Path = Path(
        os.getenv("SECURITY_STATE_PATH", "/app/secrets/security-state.json")
    )
    security_exports_dir: Path = Path(
        os.getenv("SECURITY_EXPORTS_DIR", "/app/secrets/security-exports")
    )
    security_timeline_max_range_s: int = int(
        os.getenv("SECURITY_TIMELINE_MAX_RANGE_S", "86400")
    )
    security_timeline_export_max_range_s: int = int(
        os.getenv("SECURITY_TIMELINE_EXPORT_MAX_RANGE_S", "21600")
    )
    security_export_max_outstanding_jobs: int = int(
        os.getenv("SECURITY_EXPORT_MAX_OUTSTANDING_JOBS", "2")
    )
    security_export_max_total_bytes: int = int(
        os.getenv("SECURITY_EXPORT_MAX_TOTAL_BYTES", str(5 * 1024**3))
    )
    security_export_min_free_bytes: int = int(
        os.getenv("SECURITY_EXPORT_MIN_FREE_BYTES", str(4 * 1024**3))
    )
    # Source addresses allowed to call the otherwise unauthenticated MediaMTX
    # auth callback. Docker deployments must explicitly include the observed
    # host-to-container bridge gateway (fixed at 172.30.0.1 in Compose).
    mediamtx_auth_trusted_callers: str = os.getenv(
        "MEDIAMTX_AUTH_TRUSTED_CALLERS", "127.0.0.1,::1"
    )
    automation_webhook_timeout_s: float = float(
        os.getenv("AUTOMATION_WEBHOOK_TIMEOUT_S", "5")
    )
    mqtt_host: str = os.getenv("HOMECAM_MQTT_HOST", "")
    mqtt_port: int = int(os.getenv("HOMECAM_MQTT_PORT", "1883"))
    mqtt_username: str = os.getenv("HOMECAM_MQTT_USERNAME", "")
    mqtt_password: str = os.getenv("HOMECAM_MQTT_PASSWORD", "")
    # Optional dedicated hardware driver. This is intentionally independent
    # of host_bridge: an absent executable produces an explicit `unavailable`
    # result and can never masquerade as an executed deterrence action.
    deterrence_driver_path: Path | None = (
        Path(os.environ["HOMECAM_DETERRENCE_DRIVER"])
        if os.getenv("HOMECAM_DETERRENCE_DRIVER")
        else None
    )

    # OTA artifact-bundle apply paths. Defaults live under the existing
    # persistent server data volume (`homecam-secrets` mounts at /app/secrets
    # in deploy/docker-compose.yml) so no compose change is required.
    ota_root: Path = Path(os.getenv("OTA_ROOT", "/app/secrets/dist-ota"))
    ota_manifest_path: Path = Path(
        os.getenv("OTA_MANIFEST_PATH", "/app/secrets/dist-ota/update-manifest.json")
    )
    ota_artifacts_dir: Path = Path(
        os.getenv("OTA_ARTIFACTS_DIR", "/app/secrets/dist-ota/artifacts")
    )
    ota_staging_root: Path = Path(
        os.getenv("OTA_STAGING_ROOT", "/app/secrets/dist-ota/staging")
    )
    ota_active_pointer: Path = Path(
        os.getenv("OTA_ACTIVE_POINTER", "/app/secrets/dist-ota/active-version")
    )
    ota_ledger_path: Path = Path(
        os.getenv("OTA_LEDGER_PATH", "/app/secrets/dist-ota/ota-ledger.jsonl")
    )
    ota_client_dist_target: Path = Path(
        os.getenv("OTA_CLIENT_DIST_TARGET", "/app/client_dist")
    )
    ota_restart_command: tuple[str, ...] = tuple(
        part
        for part in os.getenv(
            "OTA_RESTART_COMMAND", "docker restart homecam-server"
        ).split()
        if part
    )


settings = Settings()
