from detection.generated_wire_contract import HEARTBEAT_FIELDS
from detection.metrics import Metrics


def test_worker_snapshot_matches_generated_heartbeat_contract():
    assert set(Metrics().snapshot()) == set(HEARTBEAT_FIELDS)
