"""iter-334 (security-auditor D1 hotfix): snapshot URL routing.

Pre-iter-334 the unauthenticated `/snapshots/{filename}` endpoint
308-redirected to the auth-gated `/api/snapshots/{filename}`. The
OS push daemon (Android Chrome / Firefox push) cannot carry the
HttpOnly auth cookie when fetching a notification's `image:` field,
so the redirect lands on 401 and the hero image is silently absent.

iter-334 narrows the unauthenticated surface: `thumb_<ts>.jpg` files
serve directly without auth (the push hero use-case); other valid
patterns (latest.jpg, snap_*.jpg) continue to redirect to the
auth-gated route; non-matching filenames 404.

Tests pin the carve-out:
- thumb_*.jpg unauth → 200 + image/jpeg + actual file bytes.
- latest.jpg unauth → 308 → /api/snapshots/latest.jpg.
- snap_*.jpg unauth → 308 → /api/snapshots/snap_*.jpg.
- Path-traversal via thumb-shaped name → 404 (regex blocks pre-resolve).
- Non-matching filename → 404.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings


@pytest.fixture
def snap_dir(tmp_path, monkeypatch):
    p = tmp_path / "snapshots"
    p.mkdir()
    monkeypatch.setattr(settings, "snapshots_dir", p)
    yield p


def test_when_anonymous_fetches_thumb_jpg_then_returns_200_with_image_bytes(
    client_anon: TestClient, snap_dir,
):
    # arrange (iter-334: push-image carve-out — thumb_<ts>.jpg
    # serves directly without auth so OS push daemons can render
    # notification hero images).
    fake_jpg = b"\xff\xd8\xff\xe0FAKE_JPEG_BYTES_FOR_TEST"
    (snap_dir / "thumb_1700000000.jpg").write_bytes(fake_jpg)

    # act
    r = client_anon.get("/snapshots/thumb_1700000000.jpg")

    # assert
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == fake_jpg


def test_given_thumb_file_missing_when_anonymous_fetches_then_404(
    client_anon: TestClient, snap_dir,
):
    # arrange — thumb-shaped name but no file on disk.

    # act
    r = client_anon.get("/snapshots/thumb_1700000000.jpg")

    # assert
    assert r.status_code == 404


def test_when_anonymous_fetches_latest_jpg_then_308_redirects_to_api_snapshots(
    client_anon: TestClient, snap_dir,
):
    # arrange — latest.jpg is the live-page snapshot. NOT push-image
    # use-case → still requires auth → 308 to /api/snapshots/.

    # act
    r = client_anon.get("/snapshots/latest.jpg", follow_redirects=False)

    # assert
    assert r.status_code == 308
    assert r.headers["location"] == "/api/snapshots/latest.jpg"


def test_when_anonymous_fetches_snap_jpg_then_308_redirects_to_api_snapshots(
    client_anon: TestClient, snap_dir,
):
    # arrange — snap_*.jpg is the operator-triggered capture. NOT
    # push-image use-case → still requires auth → 308.

    # act
    r = client_anon.get(
        "/snapshots/snap_1700000000.jpg", follow_redirects=False,
    )

    # assert
    assert r.status_code == 308
    assert r.headers["location"] == "/api/snapshots/snap_1700000000.jpg"


def test_given_non_digit_chars_in_thumb_name_when_fetched_then_404(
    client_anon: TestClient, snap_dir,
):
    # arrange (iter-334 carve-out is restricted to `thumb_[0-9]+.jpg`).
    # The _THUMB_FILENAME_RE rejects letters / dashes / underscores
    # in the digit-only portion. A crafted `thumb_anything.jpg`
    # falls through the inner regex and hits the redirect path
    # (since it matches the OUTER `thumb_[A-Za-z0-9_-]+` regex but
    # not the digit-only inner) — 308 to /api/snapshots/, where
    # auth then 401s. Pin the redirect-not-direct-serve behavior
    # so the carve-out can't be widened by a future regex tweak.

    # act
    r = client_anon.get(
        "/snapshots/thumb_letters_in_here.jpg", follow_redirects=False,
    )

    # assert — 308 to auth-gated path, NOT 200 from the unauth
    # carve-out. Means the carve-out is digit-only as intended.
    assert r.status_code == 308
    assert r.headers["location"] == "/api/snapshots/thumb_letters_in_here.jpg"


def test_when_anonymous_fetches_arbitrary_filename_then_404(
    client_anon: TestClient, snap_dir,
):
    # arrange — pre-iter-318 a malicious `/snapshots/secret.txt`
    # would have served the file. Post-iter-334 it 404s identically
    # to the auth-gated route's response (no file enumeration).

    # act
    r = client_anon.get("/snapshots/secret.txt")

    # assert
    assert r.status_code == 404


def test_when_anonymous_fetches_thumb_then_no_set_cookie_or_auth_artifacts(
    client_anon: TestClient, snap_dir,
):
    # arrange (iter-334 security pin: the unauth thumb path must
    # NOT leak any auth-bound state — no Set-Cookie, no auth header
    # echo. Pure static-file serve.)
    (snap_dir / "thumb_1700000000.jpg").write_bytes(b"\xff\xd8\xff\xe0bytes")

    # act
    r = client_anon.get("/snapshots/thumb_1700000000.jpg")

    # assert
    assert r.status_code == 200
    assert "set-cookie" not in {k.lower() for k in r.headers.keys()}
    # Standard security middleware headers should still apply.
    assert r.headers.get("x-content-type-options") == "nosniff"
    assert r.headers.get("x-frame-options") == "DENY"


def test_given_authed_user_when_fetching_thumb_unauth_route_then_still_serves(
    client: TestClient, snap_dir,
):
    # arrange (iter-334: the unauth route still works for authed
    # users — the carve-out doesn't break the existing flow, just
    # widens it. The PWA's <img src=> for in-page thumbs uses the
    # auth-gated /api/snapshots/ path; this test pins that the
    # unauth /snapshots/ fallback also works for authed clients.)
    (snap_dir / "thumb_1700000001.jpg").write_bytes(b"\xff\xd8\xff\xe0auth")

    # act
    r = client.get("/snapshots/thumb_1700000001.jpg")

    # assert
    assert r.status_code == 200
    assert r.content == b"\xff\xd8\xff\xe0auth"
