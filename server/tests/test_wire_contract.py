"""Pins handwritten runtime validators to the canonical generated contract."""
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _schema():
    return json.loads((ROOT / "contracts/internal-worker.schema.json").read_text())


def test_detection_payload_field_names_match_contract():
    from app.routes._internal import DetectionPayload

    expected = set(_schema()["$defs"]["DetectionEvent"]["properties"])
    assert set(DetectionPayload.model_fields) == expected


def test_heartbeat_whitelist_matches_contract():
    from app.routes._internal import _ALLOWED_METRIC_FIELDS

    expected = set(_schema()["$defs"]["Heartbeat"]["properties"])
    assert set(_ALLOWED_METRIC_FIELDS) == expected


def test_generated_contracts_are_current():
    import subprocess
    subprocess.run(["python3", "scripts/generate-contracts.py", "--check"], cwd=ROOT, check=True)
