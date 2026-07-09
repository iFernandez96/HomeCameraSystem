from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.sessions.device_parse import device_label


FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "user_agents.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda item: item["expect"])
def test_given_real_user_agent_fixture_when_labelled_then_expected_human_label(fixture):
    # arrange
    ua = fixture["ua"]

    # act
    label = device_label(ua)

    # assert
    assert label == fixture["expect"]


def test_given_none_like_user_agent_when_labelled_then_unknown_device():
    # arrange
    ua = None

    # act
    label = device_label(ua)  # type: ignore[arg-type]

    # assert
    assert label == "Unknown device"


def test_given_non_ascii_junk_when_labelled_then_never_raises_and_unknown_device():
    # arrange
    ua = "🧪" * 100

    # act
    label = device_label(ua)

    # assert
    assert label == "Unknown device"


def test_given_four_kb_spoofed_junk_when_labelled_then_scan_is_capped():
    # arrange
    ua = ("x" * 4096) + (
        " Mozilla/5.0 (Linux; Android 14; Pixel 8) "
        "AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36"
    )

    # act
    label = device_label(ua)

    # assert
    assert label == "Unknown device"


def test_given_edge_user_agent_with_chrome_and_safari_tokens_when_labelled_then_edge_wins():
    # arrange
    ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91"
    )

    # act
    label = device_label(ua)

    # assert
    assert label == "Edge on Windows"
