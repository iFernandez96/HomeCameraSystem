import json
import sys
from pathlib import Path
from unittest.mock import MagicMock


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.modules.setdefault("jetson_inference", MagicMock())
sys.modules.setdefault("jetson_utils", MagicMock())

import detect  # noqa: E402


def test_given_terminal_failure_when_result_post_retries_then_exact_failure_replays(
    tmp_path, monkeypatch,
):
    # arrange
    path = tmp_path / ".host_action_seen.json"
    monkeypatch.setattr(detect, "_HOST_ACTION_SEEN_PATH", str(path))
    monkeypatch.setattr(detect, "_HOST_ACTION_SEEN_IDS", set())
    monkeypatch.setattr(detect, "_HOST_ACTION_RESULTS", {})

    # act — execution is claimed first, then the true terminal result is made
    # durable before the network POST is attempted.
    detect._mark_host_action_seen("exposure-1")
    detect._record_host_action_terminal(
        "exposure-1",
        "failed",
        "camera exposure failed; previous settings restored",
        None,
    )

    # assert — same-process retry and post-restart load preserve failure truth.
    expected = (
        "failed",
        "camera exposure failed; previous settings restored",
        None,
    )
    assert detect._replay_host_action_terminal("exposure-1") == expected
    assert detect._load_host_action_seen(str(path)) == {"exposure-1"}
    loaded = detect._load_host_action_results(str(path))
    assert loaded["exposure-1"] == {
        "status": "failed",
        "detail": expected[1],
        "result": None,
    }
    persisted = json.loads(path.read_text())
    assert persisted["v"] == 2


def test_given_legacy_seen_id_without_outcome_when_replayed_then_fail_honestly(
    tmp_path, monkeypatch,
):
    # arrange — v1 ledgers were only a list of ids and cannot prove success.
    path = tmp_path / ".host_action_seen.json"
    path.write_text(json.dumps(["legacy-action"]))
    monkeypatch.setattr(
        detect, "_HOST_ACTION_SEEN_IDS", detect._load_host_action_seen(str(path)),
    )
    monkeypatch.setattr(
        detect, "_HOST_ACTION_RESULTS", detect._load_host_action_results(str(path)),
    )

    # act / assert
    assert detect._replay_host_action_terminal("legacy-action") == (
        "failed",
        "execution outcome unknown after worker restart",
        None,
    )


def test_given_server_rollback_metadata_when_exposure_args_validated_then_ignored():
    # arrange — server durably embeds its prior desired config for rollback.
    args = {
        "enabled": True,
        "x": 0.25,
        "y": 0.25,
        "width": 0.5,
        "height": 0.5,
        "compensation": 0.0,
        "locked": False,
        "_previous_config": {
            "enabled": False,
            "x": 0.25,
            "y": 0.25,
            "width": 0.5,
            "height": 0.5,
            "compensation": 0.0,
            "locked": False,
        },
    }

    # act
    values = detect._valid_exposure_args(args)

    # assert — worker applies only the bounded camera fields; rollback metadata
    # remains server-owned and cannot alter the host pipeline command.
    assert values == (True, 0.25, 0.25, 0.5, 0.5, 0.0, False)
