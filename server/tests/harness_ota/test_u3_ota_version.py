import pytest

from app.services.ota_version import (
    CurrentVersionError,
    current_version_from_env,
    normalize_current_version,
)


@pytest.mark.parametrize(
    ("raw", "semverish", "build_id"),
    [
        ("1.2.3", "1.2.3", None),
        ("v1.2.3", "1.2.3", None),
        ("1.2.3+build.7", "1.2.3", "build.7"),
        ("1.2.3-rc.1+jetson.42", "1.2.3-rc.1", "jetson.42"),
        (" 2.0.0 ", "2.0.0", None),
    ],
)
def test_given_semverish_homecam_version_when_normalized_then_core_and_build_id_are_split(
    raw, semverish, build_id
):
    parsed = normalize_current_version(raw)

    assert parsed.semverish == semverish
    assert parsed.build_id == build_id


@pytest.mark.parametrize(
    "raw",
    ["", "latest", "1.2", "1.2.x", "01.2.3", "1.2.3+bad/slash", None],
)
def test_given_malformed_homecam_version_when_normalized_then_typed_error_blocks_apply(
    raw,
):
    with pytest.raises(CurrentVersionError) as exc:
        normalize_current_version(raw)

    assert exc.value.blocks_apply is True


def test_given_missing_env_when_current_version_read_then_default_is_normalized():
    parsed = current_version_from_env({})

    assert parsed.semverish == "0.1.0"
    assert parsed.build_id is None
