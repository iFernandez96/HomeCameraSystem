import hashlib

from app.services.ota_apply import switch_active_version_pointer
from app.services.ota_ledger import read_events
from app.services.ota_rollback import rollback_active_version_pointer


def _sha256_tree(path):
    digest = hashlib.sha256()
    for child in sorted(path.rglob("*")):
        if child.is_file():
            digest.update(child.relative_to(path).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(child.read_bytes())
            digest.update(b"\0")
    return digest.hexdigest()


def test_given_unhealthy_new_version_when_rollback_runs_then_previous_pointer_restored_and_reason_recorded(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    staged = tmp_path / "staging" / "1.2.4"
    staged.mkdir(parents=True)
    ledger = tmp_path / "ota-ledger.jsonl"

    apply_result = switch_active_version_pointer(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=staged,
    )
    result = rollback_active_version_pointer(
        active_pointer=active_pointer,
        previous_version=apply_result.previous_version,
        ledger_path=ledger,
        attempt_id="attempt-rollback",
        reason="health_failed",
    )

    assert result.status == "rolled_back"
    assert result.rolled_back is True
    assert result.restored_version == "1.2.3"
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
    assert [(row["status"], row["reason"]) for row in read_events(ledger)] == [
        ("rolled_back", "health_failed")
    ]
    assert not active_pointer.with_name("active-version.rollback.tmp").exists()


def test_given_failed_apply_and_rollback_when_checked_then_persisted_files_are_byte_identical(
    tmp_path,
):
    active_pointer = tmp_path / "deploy" / "active-version"
    active_pointer.parent.mkdir()
    active_pointer.write_text("1.2.3\n", encoding="utf-8")
    persisted = tmp_path / "persisted"
    (persisted / "clips" / "cam-a").mkdir(parents=True)
    (persisted / "clips" / "cam-a" / "clip.bin").write_bytes(b"persisted-video")
    (persisted / "db.sqlite").write_bytes(b"sqlite-bytes")
    before = _sha256_tree(persisted)
    staged = tmp_path / "staging" / "1.2.4"
    staged.mkdir(parents=True)

    apply_result = switch_active_version_pointer(
        active_pointer=active_pointer,
        version="1.2.4",
        staged_version_dir=staged,
    )
    rollback_active_version_pointer(
        active_pointer=active_pointer,
        previous_version=apply_result.previous_version,
        ledger_path=tmp_path / "ota-ledger.jsonl",
        attempt_id="attempt-persisted",
        reason="health_failed",
    )

    assert _sha256_tree(persisted) == before
    assert active_pointer.read_text(encoding="utf-8") == "1.2.3\n"
