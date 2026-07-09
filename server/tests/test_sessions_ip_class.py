from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.sessions.ip_class import ip_class


FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "ip_samples.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda item: item["expect"])
def test_given_remote_addr_fixture_when_classified_then_expected_bucket(fixture):
    # arrange
    remote_addr = fixture["ip"]

    # act
    bucket = ip_class(remote_addr)

    # assert
    assert bucket == fixture["expect"]


def test_given_none_remote_addr_when_classified_then_other():
    # arrange
    remote_addr = None

    # act
    bucket = ip_class(remote_addr)

    # assert
    assert bucket == "other"


def test_given_tailscale_v4_shared_range_when_classified_then_tailscale_before_fallthrough():
    # arrange
    remote_addr = "100.64.0.1"

    # act
    bucket = ip_class(remote_addr)

    # assert
    assert bucket == "tailscale"


def test_given_upper_tailscale_v4_boundary_when_classified_then_tailscale():
    # arrange
    remote_addr = "100.127.255.255"

    # act
    bucket = ip_class(remote_addr)

    # assert
    assert bucket == "tailscale"

