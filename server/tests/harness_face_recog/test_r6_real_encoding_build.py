import importlib
import pickle
import sys

import pytest

from server.tests.harness_face_recog.fixtures import (
    DETECTION_DIR,
    FACE_RECOG_DIR,
    PERSONS_DIR,
    load_known_usable_face_crop_paths,
    materialize_refs_manifest,
)


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


def test_given_real_person_crops_when_encoder_runs_then_temp_encodings_have_names_and_counts(
    tmp_path,
    monkeypatch,
):
    crop_paths = load_known_usable_face_crop_paths()[:5]
    if len(crop_paths) < 3:
        pytest.skip(
            "real full-person fixtures have fewer than 3 usable face detections"
        )
    refs_dir, manifest_path = materialize_refs_manifest(tmp_path, crop_paths)
    out_path = tmp_path / "encodings.pkl"

    sys.path.insert(0, str(DETECTION_DIR))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "encode_known_faces.py",
            "--refs",
            str(refs_dir),
            "--manifest",
            str(manifest_path),
            "--out",
            str(out_path),
            "--model",
            "hog",
        ],
    )
    encoder = importlib.import_module("face_recog.encode_known_faces")

    assert encoder.main() == 0
    with out_path.open("rb") as f:
        pairs = pickle.load(f)

    assert out_path.exists()
    assert len(pairs) == len(crop_paths)
    assert {name for name, _ in pairs} == {"fixture_subject"}
    assert all(len(encoding) == 128 for _, encoding in pairs)
    assert not (FACE_RECOG_DIR / "encodings.pkl").exists()
