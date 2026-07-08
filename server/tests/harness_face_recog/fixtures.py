import json
import shutil
import sqlite3
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
DETECTION_DIR = REPO_ROOT / "detection"
FACE_RECOG_DIR = DETECTION_DIR / "face_recog"
ENCODINGS_PATH = FACE_RECOG_DIR / "encodings.pkl"
PERSONS_DIR = REPO_ROOT / ".jetson-snapshot" / "proof_fixtures" / "persons"
EVENTS_DB = REPO_ROOT / ".jetson-snapshot" / "db" / "events.sqlite"

SIDECAR_REQUIRED_KEYS = {
    "confidence",
    "detection",
    "event_id",
    "gear",
    "infer_ms",
    "jpeg_quality",
    "kind",
    "model",
    "pad_frac",
    "person_index",
    "predicted_name",
    "schema_version",
    "source",
    "sw_rev",
    "ts_ms",
}


def load_crop_paths() -> list[Path]:
    return sorted(PERSONS_DIR.glob("*/*.jpg"))


def load_sidecar_paths() -> list[Path]:
    return sorted(PERSONS_DIR.glob("*/*.json"))


def load_sidecar(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    assert isinstance(data, dict)
    return data


def load_sidecars() -> list[dict[str, Any]]:
    return [load_sidecar(path) for path in load_sidecar_paths()]


def load_db_rows_by_id() -> dict[str, dict[str, Any]]:
    with sqlite3.connect(EVENTS_DB) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM events").fetchall()
    return {row["id"]: dict(row) for row in rows}


def count_person_events() -> int:
    with sqlite3.connect(EVENTS_DB) as conn:
        return int(
            conn.execute("SELECT COUNT(*) FROM events WHERE label = 'person'").fetchone()[0]
        )


def count_named_person_name_rows() -> int:
    with sqlite3.connect(EVENTS_DB) as conn:
        return int(
            conn.execute(
                """
                SELECT COUNT(*)
                FROM events
                WHERE person_name IS NOT NULL AND person_name != ''
                """
            ).fetchone()[0]
        )


def known_usable_face_crop_names() -> list[str]:
    """Full-person fixture crops where face_recognition HOG found a face.

    These names are intentionally pinned from the real fixture scan. Most
    full-person captures contain no detectable face, so R6/R7 use this list
    to avoid spending every run rediscovering the same no-face outcomes.
    """
    return [
        "1783475562919_003e01dc91cd4bd590636f41869c7f56.jpg",
        "1783477557077_76a98a7ad9ab4b599360ad74d93bac5f.jpg",
        "1783478845477_84344095a34749c9bae3f5de233a9f4e.jpg",
        "1783483839029_34533790ec314e6fb5ea41177d2b3c29.jpg",
        "1783483875183_3b1870380cad46e1b82ac5adb06b016b.jpg",
        "1783484203027_634a280c25e04229b8877d18e40ac465.jpg",
        "1783484220579_2207055b12c641cca864ced8a4ef574d.jpg",
        "1783485001494_6d85caf59a174ff68bdb7037457bc94f.jpg",
        "1783488671844_e03991149ab94bfcadabc44572e03b2d.jpg",
        "1783488699506_7e5645210cad4a1f8327555cf35e9c89.jpg",
        "1783488936799_878babc45e64439f82d3a598cb6f3c8a.jpg",
    ]


def load_known_usable_face_crop_paths() -> list[Path]:
    by_name = {path.name: path for path in load_crop_paths()}
    return [by_name[name] for name in known_usable_face_crop_names() if name in by_name]


def materialize_refs_manifest(
    tmp_path: Path,
    crop_paths: list[Path],
    label: str = "fixture_subject",
) -> tuple[Path, Path]:
    refs_dir = tmp_path / "refs"
    refs_dir.mkdir()
    manifest: dict[str, list[str]] = {}

    for idx, crop_path in enumerate(crop_paths, start=1):
        ref_name = f"photo_{idx:02d}.jpg"
        shutil.copy2(crop_path, refs_dir / ref_name)
        manifest[ref_name] = [label]

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    return refs_dir, manifest_path
