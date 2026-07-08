import importlib
import json
import pickle
import sys

import pytest

from server.tests.harness_face_recog.fixtures import (
    DETECTION_DIR,
    PERSONS_DIR,
    load_crop_paths,
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


def _first_face_encoding(face_recognition, crop_path):
    image = face_recognition.load_image_file(str(crop_path))
    boxes = face_recognition.face_locations(image, model="hog")
    if not boxes:
        return None
    boxes_sorted = sorted(
        boxes,
        key=lambda b: (b[2] - b[0]) * (b[1] - b[3]),
        reverse=True,
    )
    encs = face_recognition.face_encodings(image, boxes_sorted[:1])
    if not encs:
        return None
    return image, encs[0]


def _build_temp_encoding(tmp_path, monkeypatch, training_crop):
    refs_dir, manifest_path = materialize_refs_manifest(
        tmp_path,
        [training_crop],
        label="fixture_subject",
    )
    out_path = tmp_path / "encodings.pkl"
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
        assert len(pickle.load(f)) == 1
    return out_path


def test_given_temp_real_encoding_when_matching_real_crops_then_same_candidates_are_closer_on_average(
    tmp_path,
    monkeypatch,
):
    face_recognition = pytest.importorskip("face_recognition")
    np = pytest.importorskip("numpy")
    sys.path.insert(0, str(DETECTION_DIR))
    from face_recog.recognizer import FaceRecognizer

    embeddings = []
    skipped_no_face = 0
    pinned_usable = set(load_known_usable_face_crop_paths())
    for crop_path in load_crop_paths():
        if crop_path not in pinned_usable:
            skipped_no_face += 1
            continue
        result = _first_face_encoding(face_recognition, crop_path)
        if result is None:
            skipped_no_face += 1
            continue
        _, encoding = result
        embeddings.append((crop_path, encoding))

    if len(embeddings) < 7:
        pytest.skip(
            f"need at least 7 usable real face crops for R7 ledger; got {len(embeddings)}"
        )

    training_crop, training_encoding = embeddings[0]
    ranked = sorted(
        (
            (
                crop_path,
                float(np.linalg.norm(training_encoding - encoding)),
                encoding,
            )
            for crop_path, encoding in embeddings[1:]
        ),
        key=lambda item: item[1],
    )
    same_candidates = ranked[:3]
    different_candidates = ranked[-3:]

    encodings_path = _build_temp_encoding(tmp_path, monkeypatch, training_crop)
    rec = FaceRecognizer(str(encodings_path))
    assert rec.load() is True
    assert rec.names == ["fixture_subject"]

    ledger_rows = []
    for group, candidates in (
        ("same_candidate", same_candidates),
        ("different_candidate", different_candidates),
    ):
        for crop_path, precomputed_distance, encoding in candidates:
            name, confidence = rec.match(encoding)
            distance = float(np.linalg.norm(rec.encs[0] - encoding))
            ledger_rows.append(
                {
                    "group": group,
                    "crop": str(crop_path.relative_to(PERSONS_DIR)),
                    "distance": distance,
                    "precomputed_distance": precomputed_distance,
                    "matched_name": name,
                    "confidence": confidence,
                }
            )

    same_distances = [
        row["distance"] for row in ledger_rows if row["group"] == "same_candidate"
    ]
    different_distances = [
        row["distance"]
        for row in ledger_rows
        if row["group"] == "different_candidate"
    ]
    same_avg = sum(same_distances) / len(same_distances)
    different_avg = sum(different_distances) / len(different_distances)
    ledger = {
        "training_crop": str(training_crop.relative_to(PERSONS_DIR)),
        "basis": (
            "current fixtures have no identity labels; same candidates are "
            "nearest embeddings to the training crop and different candidates "
            "are farthest embeddings"
        ),
        "usable_faces": len(embeddings),
        "skipped_no_face": skipped_no_face,
        "same_avg_distance": same_avg,
        "different_avg_distance": different_avg,
        "rows": ledger_rows,
    }
    ledger_path = tmp_path / "face_recog_threshold_ledger.json"
    ledger_path.write_text(json.dumps(ledger, indent=2, sort_keys=True))

    assert ledger_path.exists()
    assert len(same_distances) == 3
    assert len(different_distances) == 3
    assert same_avg < different_avg
