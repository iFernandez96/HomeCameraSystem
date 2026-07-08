import json

import pytest

from server.tests.harness_face_recog.fixtures import PERSONS_DIR, load_crop_paths


pytestmark = [
    pytest.mark.skipif(
        not PERSONS_DIR.exists(),
        reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
    ),
    pytest.mark.skipif(
        pytest.importorskip("face_recognition") is None,
        reason="face_recognition is not importable in this environment",
    ),
]


def test_given_all_real_person_crops_when_replayed_then_face_counts_are_reported(
    tmp_path,
):
    face_recognition = pytest.importorskip("face_recognition")
    image = pytest.importorskip("PIL.Image")
    np = pytest.importorskip("numpy")

    crop_paths = load_crop_paths()
    assert crop_paths

    max_edge_px = 320
    face_count = 0
    no_face_count = 0
    rows = []

    for crop_path in crop_paths:
        with image.open(crop_path) as im:
            original_size = im.size
            im.thumbnail((max_edge_px, max_edge_px))
            rgb = np.array(im.convert("RGB"))
            boxes = face_recognition.face_locations(
                rgb,
                number_of_times_to_upsample=0,
                model="hog",
            )

        if boxes:
            face_count += 1
        else:
            no_face_count += 1
        rows.append(
            {
                "crop": str(crop_path.relative_to(PERSONS_DIR)),
                "original_size": list(original_size),
                "face_locations": len(boxes),
            }
        )

    ledger = {
        "runtime_cap": {
            "model": "hog",
            "number_of_times_to_upsample": 0,
            "max_edge_px": max_edge_px,
            "scope": "all fixture person crops",
        },
        "total_crops": len(crop_paths),
        "face_count": face_count,
        "no_face_count": no_face_count,
        "rows": rows,
    }
    ledger_path = tmp_path / "r8_full_crop_replay_ledger.json"
    ledger_path.write_text(json.dumps(ledger, indent=2, sort_keys=True))

    assert ledger_path.exists()
    assert face_count + no_face_count == len(crop_paths)
    assert "face_count" in ledger
    assert "no_face_count" in ledger
