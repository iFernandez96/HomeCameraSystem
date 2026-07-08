import pytest

from server.tests.harness_face_recog.fixtures import (
    EVENTS_DB,
    count_named_person_name_rows,
)


pytestmark = pytest.mark.skipif(
    not EVENTS_DB.exists(),
    reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
)


def test_given_snapshot_when_named_rows_exist_then_operator_must_implement_r15_diff():
    named_rows = count_named_person_name_rows()
    if named_rows == 0:
        pytest.skip(
            "named parity requires a refreshed Jetson snapshot with recognized rows — see plan R15"
        )

    pytest.fail(
        "events.sqlite now has named person rows; implement R15's diff now "
        f"instead of silently accepting the refreshed snapshot (named_rows={named_rows})"
    )
