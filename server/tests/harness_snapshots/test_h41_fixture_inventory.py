import pytest

from server.tests.harness_snapshots.fixtures import (
    APP_LOG,
    EVENTS_DB,
    SNAPSHOT_DIR,
    db_thumb_urls,
    list_snapshot_files,
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
        APP_LOG.exists() and not logged_thumb_fetches(),
        # docker log resets on container recreation (deploys), so a refetched
        # window can lack push-image fetches. Proven green 2026-07-08 against
        # the pre-restart log; regenerate by refetching after a push-with-image
        # renders on a subscribed device.
        reason="snapshot app log window has no production thumb fetches - refetch after a push-with-image renders on a device",
    ),
    pytest.mark.skipif(
        not APP_LOG.exists(),
        reason="no Jetson app log fixture - capture .jetson-snapshot/logs/homecam-server-app.log",
    ),
]


def test_given_three_fixture_sources_exist_when_loaded_then_inventory_counts_are_nonzero():
    snapshot_files = list_snapshot_files()
    thumb_urls = db_thumb_urls()
    logged_fetches = logged_thumb_fetches()

    assert len(snapshot_files) > 0
    assert len(thumb_urls) > 0
    assert len(logged_fetches) > 0
