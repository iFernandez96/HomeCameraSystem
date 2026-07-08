import pytest

from server.tests.harness_face_recog.fixtures import (
    EVENTS_DB,
    PERSONS_DIR,
    SIDECAR_REQUIRED_KEYS,
    load_db_rows_by_id,
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


def test_given_sampled_person_sidecars_when_validated_then_shapes_are_stable():
    failures = []

    for path in load_sidecar_paths()[:25]:
        sidecar = load_sidecar(path)
        if set(sidecar) < SIDECAR_REQUIRED_KEYS:
            failures.append(f"{path.name}: missing required keys")
        if sidecar["kind"] != "person":
            failures.append(f"{path.name}: kind={sidecar['kind']!r}")
        if not isinstance(sidecar["event_id"], str) or not sidecar["event_id"]:
            failures.append(f"{path.name}: invalid event_id")
        if sidecar["predicted_name"] is not None:
            failures.append(f"{path.name}: predicted_name={sidecar['predicted_name']!r}")
        detection = sidecar["detection"]
        if detection.get("label") != "person":
            failures.append(f"{path.name}: detection.label={detection.get('label')!r}")
        if len(detection.get("bbox_norm", [])) != 4:
            failures.append(f"{path.name}: invalid bbox_norm")
        if len(detection.get("bbox_pixels", [])) != 4:
            failures.append(f"{path.name}: invalid bbox_pixels")

    assert not failures, "person sidecar integrity failures:\n" + "\n".join(failures)


def test_given_sidecar_event_ids_when_they_exist_in_db_then_rows_match_person_events():
    db_rows_by_id = load_db_rows_by_id()
    failures = []
    matched = 0

    for path in load_sidecar_paths():
        sidecar = load_sidecar(path)
        db_row = db_rows_by_id.get(sidecar["event_id"])
        if db_row is None:
            continue

        matched += 1
        if db_row["label"] != "person":
            failures.append(f"{sidecar['event_id']}: db label={db_row['label']!r}")
        if db_row["person_name"] != sidecar["predicted_name"]:
            failures.append(
                f"{sidecar['event_id']}: person_name sidecar={sidecar['predicted_name']!r} db={db_row['person_name']!r}"
            )

    assert matched > 0
    assert not failures, "person sidecar DB overlap failures:\n" + "\n".join(failures)
