import json

from app.services import recording_assurance


def _payload(status="ok", checked_at=100.0):
    return {
        "v": 1,
        "status": status,
        "checked_at": checked_at,
        "stage": "complete" if status == "ok" else "decode",
        "reason": "playable" if status == "ok" else "decode_failed",
        "sample_bytes": 4096,
        "elapsed_ms": 321.0,
        "storage": {
            "writable": True,
            "filesystem": "ext4",
            "read_only": False,
            "smart_status": "unavailable",
            "free_bytes": 100000,
            "write_probe_ms": 1.2,
        },
    }


def test_given_fresh_success_when_read_then_status_proves_playable(tmp_path):
    # arrange
    path = tmp_path / "assurance.json"
    path.write_text(json.dumps(_payload()))

    # act
    result = recording_assurance.status(now=120.0, path=path)

    # assert
    assert result["state"] == "ok"
    assert result["age_s"] == 20.0
    assert result["reason"] == "playable"


def test_given_old_success_when_read_then_status_is_stale_not_ok(tmp_path):
    # arrange
    path = tmp_path / "assurance.json"
    path.write_text(json.dumps(_payload()))

    # act
    result = recording_assurance.status(
        now=100.0 + recording_assurance.STALE_AFTER_S + 1,
        path=path,
    )

    # assert
    assert result["state"] == "stale"


def test_given_failure_then_success_when_recorded_then_transitions_are_deduplicated(tmp_path):
    # arrange
    path = tmp_path / "assurance.json"

    # act / assert
    assert recording_assurance.record(_payload("failed"), path=path) == "failed"
    assert recording_assurance.record(_payload("failed", 101.0), path=path) is None
    assert recording_assurance.record(_payload("ok", 102.0), path=path) == "recovered"
    assert recording_assurance.record(_payload("ok", 103.0), path=path) is None
    assert path.stat().st_mode & 0o777 == 0o600


def test_given_malformed_state_when_read_then_status_is_unknown(tmp_path):
    # arrange
    path = tmp_path / "assurance.json"
    path.write_text('{"v":99,"status":"ok"}')

    # act / assert
    assert recording_assurance.status(path=path)["state"] == "unknown"

