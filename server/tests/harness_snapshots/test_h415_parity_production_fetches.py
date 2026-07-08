import warnings
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from server.tests.harness_snapshots.fixtures import (
    APP_LOG,
    EVENTS_DB,
    SNAPSHOT_DIR,
    db_thumb_urls,
    logged_thumb_fetches,
)


pytestmark = [
    pytest.mark.skipif(
        not SNAPSHOT_DIR.exists(),
        reason="no Jetson snapshot fixtures - capture .jetson-snapshot/proof_fixtures/snapshots",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
    pytest.mark.skipif(
        not APP_LOG.exists(),
        reason="no Jetson app log fixture - capture .jetson-snapshot/logs/homecam-server-app.log",
    ),
    pytest.mark.skipif(
        APP_LOG.exists() and not logged_thumb_fetches(),
        # docker log resets on container recreation (deploys), so a refetched
        # window can lack push-image fetches. Proven green 2026-07-08 against
        # the pre-restart log; regenerate by refetching after a push-with-image
        # renders on a subscribed device.
        reason="snapshot app log window has no production thumb fetches - refetch after a push-with-image renders on a device",
    ),
]


def test_given_production_logged_thumb_fetches_when_checked_against_db_and_route_then_parity_holds(
    client_anon: TestClient, monkeypatch
):
    logged_filenames = sorted(set(logged_thumb_fetches()))
    db_filenames = {Path(thumb_url).name for thumb_url in db_thumb_urls()}
    monkeypatch.setattr(settings, "snapshots_dir", SNAPSHOT_DIR)

    failures = []
    replayed = 0
    uncaptured = []

    for filename in logged_filenames:
        if filename not in db_filenames:
            failures.append(f"{filename}: db_missing")

        fixture_file = SNAPSHOT_DIR / filename
        if not fixture_file.exists():
            uncaptured.append(filename)
            continue

        response = client_anon.get(f"/snapshots/{filename}")
        replayed += 1

        if response.status_code != 200:
            failures.append(
                f"{filename}: route_status expected 200 got {response.status_code}"
            )
            continue

        if response.content != fixture_file.read_bytes():
            failures.append(f"{filename}: bytes_mismatch")

    if uncaptured:
        warnings.warn(
            "H4.15 skipped uncaptured logged thumb fixtures: "
            + ", ".join(uncaptured),
            stacklevel=1,
        )

    assert logged_filenames, "logged_thumb_fetches: no production thumb fetches found"
    assert replayed > 0, "route_replay: no logged filenames existed in fixture capture"
    assert not failures, "H4.15 parity failures:\n" + "\n".join(failures)
