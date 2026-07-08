import re

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from server.tests.harness_snapshots.fixtures import SNAPSHOT_DIR, list_snapshot_files


THUMB_FILENAME_RE = re.compile(r"^thumb_[0-9]+\.jpg$")
THUMB_FIXTURES = [
    snapshot_file
    for snapshot_file in list_snapshot_files()
    if THUMB_FILENAME_RE.fullmatch(snapshot_file.name)
]


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
    pytest.mark.skipif(
        not THUMB_FIXTURES,
        reason="no Jetson thumb fixtures - capture .jetson-snapshot/proof_fixtures/snapshots/thumb_*.jpg",
    ),
]


def test_given_real_thumb_fixture_when_anonymous_client_gets_snapshot_then_serves_exact_jpeg_without_cookie(
    client_anon: TestClient, monkeypatch
):
    thumb_file = THUMB_FIXTURES[0]
    monkeypatch.setattr(settings, "snapshots_dir", SNAPSHOT_DIR)

    response = client_anon.get(f"/snapshots/{thumb_file.name}")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content == thumb_file.read_bytes()
    assert response.headers.get("set-cookie") is None
