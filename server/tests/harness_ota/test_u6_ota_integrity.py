import hashlib

from app.services.ota_integrity import verify_local_artifact


def _tree_snapshot(path):
    return sorted(
        (child.relative_to(path).as_posix(), child.read_bytes())
        for child in path.rglob("*")
        if child.is_file()
    )


def test_given_local_artifact_when_size_and_sha256_match_then_verified(tmp_path):
    artifact = tmp_path / "homecam.tar.gz"
    payload = b"offline artifact bytes"
    artifact.write_bytes(payload)

    result = verify_local_artifact(
        artifact,
        expected_size=len(payload),
        expected_sha256=hashlib.sha256(payload).hexdigest(),
    )

    assert result.status == "verified"
    assert result.can_apply is True
    assert result.size == len(payload)
    assert result.sha256 == hashlib.sha256(payload).hexdigest()


def test_given_digest_mismatch_when_artifact_checked_then_scratch_deploy_tree_is_byte_identical(
    tmp_path,
):
    artifact = tmp_path / "homecam.tar.gz"
    artifact.write_bytes(b"artifact bytes")
    scratch = tmp_path / "scratch"
    (scratch / "data").mkdir(parents=True)
    (scratch / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
    (scratch / ".env").write_text("HOMECAM_VERSION=1.2.3\n", encoding="utf-8")
    (scratch / "data" / "keep.bin").write_bytes(b"persisted")
    before = _tree_snapshot(scratch)

    result = verify_local_artifact(
        artifact,
        expected_size=len(b"artifact bytes"),
        expected_sha256="0" * 64,
    )

    assert result.status == "rejected"
    assert result.reason == "sha256_mismatch"
    assert result.can_apply is False
    assert _tree_snapshot(scratch) == before
