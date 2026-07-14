from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def export_env(tmp_path, monkeypatch):
    from app.config import settings
    from app.services.security_export_capacity import reset_for_tests
    from app.services.security_store import security_store

    monkeypatch.setattr(settings, "security_state_path", tmp_path / "security.json")
    monkeypatch.setattr(settings, "security_exports_dir", tmp_path / "exports")
    monkeypatch.setattr(settings, "security_export_max_outstanding_jobs", 2)
    monkeypatch.setattr(settings, "security_export_max_total_bytes", 10**9)
    monkeypatch.setattr(settings, "security_export_min_free_bytes", 0)
    security_store.reset_for_tests()
    reset_for_tests()
    return tmp_path


def _segment(tmp_path: Path, *, size: int = 64, start: float = 1000.0):
    from app.services.security_timeline import Segment

    path = tmp_path / "segment.mp4"
    path.write_bytes(b"x")
    return Segment("front_door", path, start, start + 10.0, size)


def test_concurrent_timeline_claims_enforce_max_outstanding_atomically(
    export_env, monkeypatch
):
    from app.config import settings
    from app.services import security_timeline
    from app.services.security_export_capacity import ExportCapacityError
    from app.services.security_store import security_store

    segment = _segment(export_env)
    monkeypatch.setattr(
        security_timeline, "list_segments", lambda *_args: [segment]
    )
    monkeypatch.setattr(settings, "security_export_max_outstanding_jobs", 1)
    barrier = threading.Barrier(2)

    def claim():
        barrier.wait(timeout=5)
        try:
            return security_timeline.create_export_job(
                "front_door", 1000.0, 1005.0
            )
        except ExportCapacityError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: claim(), range(2)))

    jobs = security_store.read()["timeline_exports"]
    assert len(jobs) == 1
    assert sum(isinstance(result, dict) for result in results) == 1
    rejected = next(result for result in results if isinstance(result, Exception))
    assert isinstance(rejected, ExportCapacityError)
    assert rejected.status_code == 422
    assert "wait" in rejected.detail.lower()
    assert next(iter(jobs.values()))["reservation_bytes"] > 0


@pytest.mark.parametrize(
    ("max_total", "free", "minimum", "expected"),
    [
        (512, 10**9, 0, "storage limit"),
        (10**9, 1024, 1024, "free storage"),
    ],
)
def test_timeline_claim_rejects_total_cap_and_disk_floor_without_paths(
    export_env, monkeypatch, max_total, free, minimum, expected
):
    from app.config import settings
    from app.services import security_export_capacity, security_timeline
    from app.services.security_export_capacity import ExportCapacityError

    segment = _segment(export_env)
    monkeypatch.setattr(security_timeline, "list_segments", lambda *_: [segment])
    monkeypatch.setattr(settings, "security_export_max_total_bytes", max_total)
    monkeypatch.setattr(settings, "security_export_min_free_bytes", minimum)
    monkeypatch.setattr(
        security_export_capacity,
        "shutil",
        SimpleNamespace(disk_usage=lambda _path: SimpleNamespace(free=free)),
    )
    with pytest.raises(ExportCapacityError) as caught:
        security_timeline.create_export_job("front_door", 1000.0, 1005.0)
    assert caught.value.status_code == 507
    assert expected in caught.value.detail.lower()
    assert str(export_env) not in caught.value.detail


def test_finished_output_reserves_floor_for_other_pending_jobs(
    export_env, monkeypatch
):
    from app.config import settings
    from app.services import security_export_capacity
    from app.services.security_export_capacity import ExportCapacityError

    monkeypatch.setattr(settings, "security_export_min_free_bytes", 100)
    monkeypatch.setattr(
        security_export_capacity,
        "shutil",
        SimpleNamespace(disk_usage=lambda _path: SimpleNamespace(free=120)),
    )
    state = {
        "timeline_exports": {
            "current": {"status": "running", "reservation_bytes": 20},
            "other": {"status": "pending", "reservation_bytes": 40},
        }
    }
    with pytest.raises(ExportCapacityError, match="too little free storage"):
        security_export_capacity.ensure_finished_output_fits(
            state, 10, exclude_job_id="current"
        )


def test_cleanup_removes_only_exact_owned_inactive_temporaries(
    export_env, monkeypatch
):
    from app.config import settings
    from app.services.security_export_capacity import (
        CAPACITY_LOCK,
        cleanup_owned_temps,
        workspace_bytes,
    )

    root = settings.security_exports_dir
    root.mkdir(parents=True)
    active = "a" * 32
    orphan = "b" * 32
    active_file = root / ".timeline-{}.part.mp4".format(active)
    orphan_file = root / ".timeline-{}.ffconcat".format(orphan)
    incident_file = root / ".incident-{}-{}-abc123.part.zip".format(
        "c" * 32, "d" * 32
    )
    unrelated = root / ".timeline-not-owned.part.mp4"
    hidden = root / ".operator-note"
    for path in (active_file, orphan_file, incident_file, unrelated, hidden):
        path.write_bytes(b"123")
    state = {
        "timeline_exports": {
            active: {"status": "running", "reservation_bytes": 100}
        }
    }
    with CAPACITY_LOCK:
        removed = cleanup_owned_temps(state)
    assert removed == 2
    assert active_file.exists()
    assert unrelated.exists() and hidden.exists()
    assert not orphan_file.exists() and not incident_file.exists()
    # App-owned active temp is represented by its reservation; unrelated
    # hidden files are retained bytes and cannot bypass the total cap.
    assert workspace_bytes() == unrelated.stat().st_size + hidden.stat().st_size


def test_startup_cleanup_removes_only_exact_orphaned_incident_outputs(
    export_env,
):
    from app.config import settings
    from app.services.security_export_capacity import (
        cleanup_incident_outputs_at_startup,
    )

    root = settings.security_exports_dir
    root.mkdir(parents=True, exist_ok=True)
    orphan = root / "incident-{}-{}.zip".format("a" * 32, "b" * 32)
    lookalike = root / "incident-{}-{}-keep.zip".format("a" * 32, "b" * 32)
    operator = root / "incident-not-owned.zip"
    for path in (orphan, lookalike, operator):
        path.write_bytes(b"zip")
    assert cleanup_incident_outputs_at_startup() == 1
    assert not orphan.exists()
    assert lookalike.exists() and operator.exists()


def test_prune_drops_ready_metadata_when_ephemeral_file_is_missing(
    export_env,
):
    from app.services import security_timeline
    from app.services.security_store import security_store

    missing = export_env / "exports" / "timeline-missing.mp4"

    def seed(state):
        state["timeline_exports"]["e" * 32] = {
            "id": "e" * 32,
            "status": "ready",
            "updated_ts": 9999.0,
            "file_path": str(missing),
            "reservation_bytes": 0,
        }

    security_store.transact(seed)
    assert security_timeline.prune_export_jobs(now=10000.0) == 1
    assert security_store.read()["timeline_exports"] == {}


def test_runner_crash_releases_pending_reservation(export_env, monkeypatch):
    from app.services import security_timeline
    from app.services.security_store import security_store

    job_id = "f" * 32

    def seed(state):
        state["timeline_exports"][job_id] = {
            "id": job_id,
            "status": "pending",
            "updated_ts": 1.0,
            "reservation_bytes": 123456,
            "file_path": None,
        }

    security_store.transact(seed)

    def crash(_job_id):
        raise OSError("private path must not become a user error")

    monkeypatch.setattr(security_timeline, "_run_export_job_locked", crash)
    security_timeline.run_export_job(job_id)
    row = security_store.read()["timeline_exports"][job_id]
    assert row["status"] == "failed"
    assert row["reservation_bytes"] == 0
    assert row["error"] == "timeline export failed"


def test_restore_normalization_never_revives_ephemeral_export_paths(
    export_env,
):
    from app.services.backup_restore import RestoreStaging, validate_restored_state

    path = export_env / "restored-security.json"
    path.write_text(
        json.dumps(
            {
                "v": 1,
                "incidents": {"keep": {}},
                "timeline_exports": {
                    "stale": {
                        "status": "ready",
                        "file_path": "/private/old-export.mp4",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    staging = RestoreStaging(
        staging_root=export_env,
        actions=(
            {
                "role": "security_state",
                "target_path": str(path),
            },
        ),
    )
    validate_restored_state(staging)
    restored = json.loads(path.read_text(encoding="utf-8"))
    assert restored["incidents"] == {"keep": {}}
    assert restored["timeline_exports"] == {}
    assert path.stat().st_mode & 0o777 == 0o600


def test_incident_export_uses_shared_cap_and_never_false_audits_success(
    client, export_env, monkeypatch
):
    from app.config import settings
    from app.services import security_timeline
    from app.services.security_store import security_store

    segment = _segment(export_env)
    monkeypatch.setattr(security_timeline, "list_segments", lambda *_: [segment])
    timeline = security_timeline.create_export_job(
        "front_door", 1000.0, 1005.0
    )
    assert timeline["status"] == "pending"
    # Each empty incident/tiny timeline conservatively reserves at least 1 MiB.
    monkeypatch.setattr(settings, "security_export_max_total_bytes", 1_500_000)
    created = client.post(
        "/api/security/incidents", json={"title": "Capacity test"}
    )
    assert created.status_code == 201
    response = client.post(
        "/api/security/incidents/{}/export".format(created.json()["id"])
    )
    assert response.status_code == 507
    assert str(export_env) not in response.text
    row = security_store.read()["incidents"][created.json()["id"]]
    actions = [entry["action"] for entry in row["audit"]]
    assert "evidence_export_requested" in actions
    assert "evidence_exported" not in actions
    assert not list(settings.security_exports_dir.glob("incident-*.zip"))


def test_incident_export_cleans_published_zip_if_success_audit_fails(
    client, export_env, monkeypatch
):
    from app.config import settings
    from app.services.security_store import security_store

    created = client.post(
        "/api/security/incidents", json={"title": "Audit failure cleanup"}
    )
    assert created.status_code == 201
    original = security_store.transact

    def fail_success_audit(operation):
        if getattr(operation, "__name__", "") == "_audit_success":
            raise OSError("simulated state persistence failure")
        return original(operation)

    monkeypatch.setattr(security_store, "transact", fail_success_audit)
    with pytest.raises(OSError, match="simulated state persistence failure"):
        client.post(
            "/api/security/incidents/{}/export".format(created.json()["id"])
        )
    assert not list(settings.security_exports_dir.glob("incident-*.zip"))
