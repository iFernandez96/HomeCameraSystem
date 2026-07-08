import json

import pytest

from app.services.ota_manifest import read_local_manifest


def test_given_valid_local_manifest_when_read_then_available_with_artifact_digest(
    tmp_path,
):
    manifest_path = tmp_path / "update-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "version": "1.2.4",
                "artifact": {
                    "name": "homecam-1.2.4.tar.gz",
                    "sha256": "A" * 64,
                },
            }
        ),
        encoding="utf-8",
    )

    result = read_local_manifest(manifest_path)

    assert result.status == "available"
    assert result.can_apply is True
    assert result.manifest is not None
    assert result.manifest.version == "1.2.4"
    assert result.manifest.artifact.name == "homecam-1.2.4.tar.gz"
    assert result.manifest.artifact.sha256 == "a" * 64


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ({}, "missing_version"),
        ({"version": "1.2.4"}, "missing_artifact"),
        ({"version": "1.2.4", "artifact": {}}, "missing_artifact_name"),
        (
            {"version": "1.2.4", "artifact": {"name": "../escape", "sha256": "a" * 64}},
            "malformed_artifact_name",
        ),
        (
            {
                "version": "1.2.4",
                "artifact": {"name": "homecam.tar.gz", "sha256": "not-a-digest"},
            },
            "malformed_sha256",
        ),
    ],
)
def test_given_missing_or_malformed_local_manifest_when_read_then_unavailable_never_apply(
    tmp_path, payload, reason
):
    manifest_path = tmp_path / "update-manifest.json"
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")

    result = read_local_manifest(manifest_path)

    assert result.status == "unavailable"
    assert result.reason == reason
    assert result.can_apply is False
    assert result.manifest is None


def test_given_manifest_path_missing_when_read_then_unavailable_never_apply(tmp_path):
    result = read_local_manifest(tmp_path / "missing.json")

    assert result.status == "unavailable"
    assert result.reason == "missing"
    assert result.can_apply is False
