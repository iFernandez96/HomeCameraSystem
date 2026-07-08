import asyncio

import pytest

from app.routes import clips as clips_route
from server.tests.harness_export_zip.fixtures import CLIPS_DIR, EVENTS_DB


pytestmark = [
    pytest.mark.skipif(
        not CLIPS_DIR.exists(),
        reason="no Jetson clip fixtures - capture .jetson-snapshot/proof_fixtures/clips",
    ),
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def test_given_two_concurrent_export_builds_when_first_is_running_then_second_starts_after_first_finishes(
    monkeypatch,
):
    build_order = []

    async def run_concurrent_builds():
        monkeypatch.setattr(clips_route, "_EXPORT_SEMAPHORE", asyncio.Semaphore(1))
        first_started = asyncio.Event()
        release_first = asyncio.Event()

        async def export_build_request(name):
            async with clips_route._EXPORT_SEMAPHORE:
                build_order.append("start-{}".format(name))
                if name == "1":
                    first_started.set()
                    await release_first.wait()
                build_order.append("finish-{}".format(name))

        first = asyncio.create_task(export_build_request("1"))
        await asyncio.wait_for(first_started.wait(), timeout=5)
        second = asyncio.create_task(export_build_request("2"))
        await asyncio.sleep(0)
        assert build_order == ["start-1"]

        release_first.set()
        await asyncio.wait_for(asyncio.gather(first, second), timeout=5)

    asyncio.run(run_concurrent_builds())

    assert build_order == ["start-1", "finish-1", "start-2", "finish-2"]
