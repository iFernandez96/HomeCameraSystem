import re
from urllib.parse import urlsplit

import pytest

from server.tests.harness_snapshots.fixtures import EVENTS_DB, db_thumb_urls


THUMB_URL_RE = re.compile(r"^/snapshots/thumb_[0-9]+\.jpg$")


pytestmark = [
    pytest.mark.skipif(
        not EVENTS_DB.exists(),
        reason="no Jetson events DB fixture - capture .jetson-snapshot/db/events.sqlite",
    ),
]


def _url_shape(value):
    parts = urlsplit(value)
    path = re.sub(r"[0-9]+", "[0-9]+", parts.path or value)
    if parts.scheme or parts.netloc:
        return f"{parts.scheme or '<scheme>'}://<host>{path}"
    return path


def test_given_all_real_db_thumb_urls_when_validated_then_every_non_null_value_has_thumb_path_shape():
    thumb_urls = db_thumb_urls()

    offending = [value for value in thumb_urls if not THUMB_URL_RE.fullmatch(value)]
    offending_shapes = sorted({_url_shape(value) for value in offending})[:3]

    assert not offending, (
        f"{len(offending)} db thumb_url values had unexpected shape; "
        f"offending_shapes={offending_shapes}"
    )
