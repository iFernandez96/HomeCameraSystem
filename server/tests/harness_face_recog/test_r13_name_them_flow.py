import shutil
from types import SimpleNamespace

import pytest

from server.tests.harness_face_recog.fixtures import (
    PERSONS_DIR,
    load_sidecar,
    load_sidecar_paths,
)


async def _inline_to_thread(func, /, *args, **kwargs):
    return func(*args, **kwargs)


pytestmark = pytest.mark.skipif(
    not PERSONS_DIR.exists(),
    reason="no Jetson person crop fixtures - capture .jetson-snapshot/proof_fixtures/persons",
)


async def test_given_unrecognized_capture_when_named_then_file_and_sidecar_move_preserve_content(
    tmp_path,
    monkeypatch,
):
    from app.config import settings
    from app.routes import face

    source_sidecar = next(
        (
            path for path in load_sidecar_paths()
            if path.parent.name == "__unknown__" and path.with_suffix(".jpg").is_file()
        ),
        None,
    )
    if source_sidecar is None:
        pytest.skip("real person fixture tree has no __unknown__ jpg/json sidecar pair")

    root = tmp_path / "persons"
    source_jpg_fixture = source_sidecar.with_suffix(".jpg")
    source_dir = root / source_sidecar.parent.relative_to(PERSONS_DIR)
    source_dir.mkdir(parents=True)
    shutil.copy2(source_jpg_fixture, source_dir / source_jpg_fixture.name)
    shutil.copy2(source_sidecar, source_dir / source_sidecar.name)
    monkeypatch.setattr(settings, "face_captures_dir", root)
    monkeypatch.setattr(face, "asyncio", SimpleNamespace(to_thread=_inline_to_thread))

    filename = source_sidecar.with_suffix(".jpg").name
    source_jpg = root / "__unknown__" / filename
    source_json = source_jpg.with_suffix(".json")
    target_name = "review_named_subject"

    expected_jpg_bytes = source_jpg.read_bytes()
    expected_json_bytes = source_json.read_bytes()
    expected_sidecar = load_sidecar(source_sidecar)

    result = await face.move_capture(
        "__unknown__",
        filename,
        face._MoveBody(target_name=target_name),
    )

    target_jpg = root / target_name / filename
    target_json = target_jpg.with_suffix(".json")

    assert result == {"ok": True, "moved_to": f"{target_name}/{filename}"}
    assert not source_jpg.exists()
    assert not source_json.exists()
    assert target_jpg.read_bytes() == expected_jpg_bytes
    assert target_json.read_bytes() == expected_json_bytes
    assert load_sidecar(target_json) == expected_sidecar

    dirs = await face.list_capture_dirs()
    by_name = {item["name"]: item for item in dirs["dirs"]}
    assert by_name[target_name]["count"] == 1

    listing = await face.list_captures_in_dir(target_name)
    moved = next(item for item in listing["files"] if item["filename"] == filename)
    assert moved["event_id"] == expected_sidecar["event_id"]
    assert moved["predicted_name"] == expected_sidecar.get("predicted_name")
