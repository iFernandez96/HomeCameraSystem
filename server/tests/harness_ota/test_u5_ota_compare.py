from app.services.ota_compare import compare_available_version


def test_given_available_version_newer_when_compared_then_apply_allowed_without_side_effects(
    tmp_path,
):
    deploy_marker = tmp_path / "deploy" / "marker.txt"
    deploy_marker.parent.mkdir()
    deploy_marker.write_text("live", encoding="utf-8")

    result = compare_available_version(
        current_version="1.2.3+build.7", available_version="1.2.4"
    )

    assert result.status == "newer"
    assert result.relation == "newer"
    assert result.can_apply is True
    assert deploy_marker.read_text(encoding="utf-8") == "live"


def test_given_available_version_equal_or_older_when_compared_then_rejected_without_side_effects(
    tmp_path,
):
    deploy_marker = tmp_path / "deploy" / "marker.txt"
    deploy_marker.parent.mkdir()
    deploy_marker.write_text("live", encoding="utf-8")

    equal = compare_available_version(
        current_version="1.2.3+build.7", available_version="1.2.3+newer-build"
    )
    older = compare_available_version(current_version="1.2.3", available_version="1.2.2")

    assert equal.status == "rejected"
    assert equal.relation == "equal"
    assert equal.reason == "available_equal"
    assert equal.can_apply is False
    assert older.status == "rejected"
    assert older.relation == "older"
    assert older.reason == "available_older"
    assert older.can_apply is False
    assert deploy_marker.read_text(encoding="utf-8") == "live"


def test_given_prerelease_available_when_compared_then_semver_precedence_is_used():
    release = compare_available_version(current_version="1.2.3-rc.1", available_version="1.2.3")
    prerelease = compare_available_version(current_version="1.2.3", available_version="1.2.4-rc.1")

    assert release.can_apply is True
    assert prerelease.can_apply is True
