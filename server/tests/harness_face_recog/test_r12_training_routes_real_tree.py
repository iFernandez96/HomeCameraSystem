import shutil
from types import SimpleNamespace

from server.tests.harness_face_recog.fixtures import (
    PERSONS_DIR,
    load_sidecar,
    load_sidecar_paths,
)

import pytest


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


pytestmark = pytest.mark.skipif(
    not PERSONS_DIR.exists(),
    reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
)


async def test_given_real_person_fixture_slice_when_training_routes_point_at_it_then_lists_reflect_sidecars(
    tmp_path,
    monkeypatch,
):
    from app.config import settings
    from app.routes import face

    source_sidecars = [
        path for path in load_sidecar_paths()
        if path.with_suffix(".jpg").is_file()
    ][:5]
    if not source_sidecars:
        pytest.skip("real person fixture tree has no jpg/json sidecar pairs")

    root = tmp_path / "persons"
    expected = []
    for sidecar_path in source_sidecars:
        jpg_path = sidecar_path.with_suffix(".jpg")
        rel_dir = sidecar_path.parent.relative_to(PERSONS_DIR)
        dst_dir = root / rel_dir
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(jpg_path, dst_dir / jpg_path.name)
        shutil.copy2(sidecar_path, dst_dir / sidecar_path.name)
        expected.append(
            {
                "dir": rel_dir.as_posix(),
                "jpg": jpg_path.name,
                "sidecar": load_sidecar(sidecar_path),
            }
        )

    monkeypatch.setattr(settings, "face_captures_dir", root)
    monkeypatch.setattr(face, "asyncio", SimpleNamespace(to_thread=_inline_to_thread))

    dirs = await face.list_capture_dirs()
    unknown_dir = next(
        item for item in dirs["dirs"] if item["name"] == "__unknown__"
    )
    assert unknown_dir["count"] == len(expected)

    listing = await face.list_captures_in_dir("__unknown__")
    files = {item["filename"]: item for item in listing["files"]}

    for item in expected:
        listed = files[item["jpg"]]
        sidecar = item["sidecar"]
        expected_name = sidecar.get("predicted_name", "__unknown__")
        assert listed["predicted_name"] == expected_name
        assert listed["confidence"] == sidecar.get("confidence")
        assert listed["event_id"] == sidecar["event_id"]

    uncertain_expected = [
        item for item in expected
        if isinstance(item["sidecar"].get("confidence"), (int, float))
        and 0.3 <= item["sidecar"]["confidence"] <= 0.75
    ]
    queue = await face.list_review_queue(limit=100)
    assert queue["total_uncertain"] == len(uncertain_expected)
    assert len(queue["items"]) == len(uncertain_expected)
