import sys
from pathlib import Path

from app.services import recording_service


def test_worker_disk_floor_exceeds_server_eviction_floor():
    detection_dir = Path(__file__).resolve().parents[3] / "detection"
    sys.path.insert(0, str(detection_dir))
    try:
        from visit_runtime import WORKER_MIN_FREE_BYTES  # type: ignore[import-not-found]
    finally:
        sys.path.remove(str(detection_dir))

    assert WORKER_MIN_FREE_BYTES > recording_service.SERVER_MIN_FREE_BYTES

