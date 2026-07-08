import re

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from server.tests.harness_snapshots.fixtures import SNAPSHOT_DIR, list_snapshot_files


SNAP_FILENAME_RE = re.compile(r"^snap_[0-9]+\.jpg$")
SNAP_FIXTURES = [
    snapshot_file
    for snapshot_file in list_snapshot_files()
    if SNAP_FILENAME_RE.fullmatch(snapshot_file.name)
]


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
    pytest.mark.skipif(
        not SNAP_FIXTURES,
        reason="no Jetson snap fixtures - capture .jetson-snapshot/proof_fixtures/snapshots/snap_*.jpg",
    ),
]


def test_given_snapshot_carveout_edges_when_anonymous_client_fetches_then_only_digit_thumbs_can_serve(
    client_anon: TestClient, monkeypatch
):
    snap_file = SNAP_FIXTURES[0]
    monkeypatch.setattr(settings, "snapshots_dir", SNAPSHOT_DIR)

    latest_response = client_anon.get("/snapshots/latest.jpg", follow_redirects=False)
    snap_response = client_anon.get(f"/snapshots/{snap_file.name}", follow_redirects=False)
    traversal_response = client_anon.get(
        "/snapshots/../latest.jpg",
        follow_redirects=False,
    )
    evil_suffix_response = client_anon.get(
        "/snapshots/thumb_123.jpg.evil",
        follow_redirects=False,
    )
    alpha_thumb_response = client_anon.get(
        "/snapshots/thumb_abc.jpg",
        follow_redirects=False,
    )
    uppercase_thumb_response = client_anon.get(
        "/snapshots/THUMB_123.jpg",
        follow_redirects=False,
    )

    assert latest_response.status_code == 308
    assert latest_response.headers["location"] == "/api/snapshots/latest.jpg"
    assert snap_response.status_code == 308
    assert snap_response.headers["location"] == f"/api/snapshots/{snap_file.name}"

    assert traversal_response.status_code == 404
    assert evil_suffix_response.status_code == 404
    assert alpha_thumb_response.status_code == 308
    assert alpha_thumb_response.headers["location"] == "/api/snapshots/thumb_abc.jpg"
    assert uppercase_thumb_response.status_code == 404
