import pytest

from server.tests.harness_face_recog.fixtures import (
    EVENTS_DB,
    PERSONS_DIR,
    SIDECAR_REQUIRED_KEYS,
    load_crop_paths,
    load_sidecar,
    load_sidecar_paths,
)


pytestmark = [
    pytest.mark.skipif(
        not PERSONS_DIR.exists(),
        reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_person_fixture_sources_when_loaded_then_counts_are_nonzero():
    crop_paths = load_crop_paths()
    sidecar_paths = load_sidecar_paths()

    assert PERSONS_DIR.exists()
    assert EVENTS_DB.exists()
    assert len(crop_paths) > 0
    assert len(sidecar_paths) > 0


def test_given_person_sidecars_when_loaded_then_schema_keys_are_present():
    failures = []

    for path in load_sidecar_paths():
        sidecar = load_sidecar(path)
        missing_keys = sorted(SIDECAR_REQUIRED_KEYS - set(sidecar))
        if missing_keys:
            failures.append(f"{path.relative_to(PERSONS_DIR)}: missing {missing_keys}")

    assert not failures, "person sidecar schema failures:\n" + "\n".join(failures)
