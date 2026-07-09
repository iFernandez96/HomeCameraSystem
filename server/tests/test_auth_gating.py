"""Auth gate behavior (iter-184, Auth Plan Phase 5 — HARD CUTOVER).

Pins the wiring of `Depends(get_current_user)` across the
protected `/api/*` surface and the carve-outs that MUST stay open:

- `/api/auth/*` gates itself (login is the way IN; the route is
  unauthenticated by definition).
- `/api/_internal/*` is loopback-trusted (Charter lock-in,
  worker writes events here without auth).
- `/api/events/ws` (WS) is NOT gated yet — Phase 6 (iter-185)
  adds the cookie precondition inside the handshake. The REST
  sibling `/api/events?limit=...` IS gated this iter.

The default `client` fixture is auto-authed (see conftest.py
iter-184 note), so we use `client_anon` for the 401-on-anonymous
direction and `client` for the 200-when-authenticated direction.
"""
from __future__ import annotations


# --- /api/status -------------------------------------------------------


def test_api_status_anon_returns_401(client_anon):
    res = client_anon.get("/api/status")
    assert res.status_code == 401


def test_api_status_authed_returns_200(client):
    res = client.get("/api/status")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True


# --- /api/events (REST list) — gated; WS sibling stays ungated ---------


def test_api_events_list_anon_returns_401(client_anon):
    res = client_anon.get("/api/events?limit=10")
    assert res.status_code == 401


def test_api_events_list_authed_returns_200(client):
    res = client.get("/api/events?limit=10")
    assert res.status_code == 200
    assert isinstance(res.json(), list)


# --- /api/control/* — router-level gate -------------------------------


def test_api_detection_toggle_anon_returns_401(client_anon):
    res = client_anon.post("/api/detection/toggle")
    assert res.status_code == 401


def test_api_detection_toggle_authed_returns_200(client):
    res = client.post("/api/detection/toggle")
    assert res.status_code == 200


# --- /api/push/* — router-level gate ----------------------------------


def test_api_push_subscribe_anon_returns_401(client_anon):
    res = client_anon.post(
        "/api/push/subscribe",
        json={
            "endpoint": "https://push.example/x",
            "keys": {"p256dh": "a", "auth": "b"},
        },
    )
    assert res.status_code == 401


# --- carve-outs --------------------------------------------------------


def test_api_auth_login_remains_anon_accessible(client_anon):
    """Login is the way IN — must NEVER be gated. Wrong-creds 401
    here is from the route's own credential-check, not from the
    auth gate (which would 401 on missing cookie too — but the body
    detail differs)."""
    res = client_anon.post(
        "/api/auth/login",
        json={"username": "ghost", "password": "anything"},
    )
    # 401 from the route's bad-creds path, NOT from the gate.
    # Body detail confirms.
    assert res.status_code == 401
    detail = res.json().get("detail", "")
    assert detail == "invalid credentials", (
        "expected route-level 401 'invalid credentials'; got {!r} — "
        "if this is 'not authenticated' the gate is incorrectly "
        "applied to /api/auth/login".format(detail)
    )


def test_api_internal_event_anon_accessible(client_anon):
    """Loopback-trusted carve-out — the host-side detection worker
    posts events here without auth. Charter lock-in: NEVER gate.

    We deliberately POST a body that may or may not satisfy the
    endpoint's Pydantic schema — what we're pinning here is that
    NO 401 comes back. A 422 (validation) or 200 (ok) both prove
    the auth gate didn't fire on this prefix."""
    res = client_anon.post(
        "/api/_internal/event",
        json={
            "label": "person",
            "score": 0.9,
            "boxes": [{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}],
        },
    )
    assert res.status_code != 401, (
        "auth gate fired on /api/_internal/event (carve-out broken)"
    )


def test_api_internal_heartbeat_anon_accessible(client_anon):
    """Worker heartbeats also bypass auth. Same carve-out."""
    res = client_anon.post(
        "/api/_internal/heartbeat",
        json={"metrics": {"fps": 5}},
    )
    assert res.status_code == 200


# --- iter-197 (Feature #3 slice 3): role gates on destructive routes ---

# Helper: mint a role-tagged access cookie and inject it on the
# anon client so the test can target a specific role without
# needing a per-role fixture matrix. iter-184's `client_anon`
# starts with no cookie; the manually-issued token here gives it
# the gating identity we need.

from app.auth import passwords, tokens, users_db  # noqa: E402
from app.auth.dependencies import COOKIE_ACCESS  # noqa: E402
from app.config import settings  # noqa: E402


def _seed_and_token(role: str) -> str:
    """Seed a user with the given role + return an access cookie
    string for them. Uses the test conftest's monkey-patched
    settings.users_db_path so the user lands in the per-test tmp DB."""
    users_db.init_db(settings.users_db_path)
    username = "u_{}".format(role)
    try:
        users_db.create_user(
            settings.users_db_path,
            username,
            passwords.hash_password("p"),
            role=role,
        )
    except Exception:
        pass
    return tokens.issue(username, "access", role=role)


def test_reboot_owner_passes(client_anon):
    """An owner-role user can hit /api/system/reboot."""
    token = _seed_and_token("owner")
    res = client_anon.post(
        "/api/system/reboot",
        json={"confirm": True},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_reboot_legacy_admin_passes(client_anon):
    """iter-197 transitional carve-out: pre-iter-196 seeded `admin`
    users keep working on owner-only routes."""
    token = _seed_and_token("admin")
    res = client_anon.post(
        "/api/system/reboot",
        json={"confirm": True},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_reboot_family_403s(client_anon):
    """A family-role user is blocked from rebooting the Jetson —
    Charter-most-destructive op stays owner-only."""
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/system/reboot",
        json={"confirm": True},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_reboot_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.post(
        "/api/system/reboot",
        json={"confirm": True},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


# iter-210 (Feature #10 slice 1): /api/system/backup is owner-only,
# same RBAC profile as /api/system/reboot. Symmetric coverage —
# anon / family / viewer 401-or-403; owner / legacy admin pass.

def test_backup_owner_passes(client_anon):
    """An owner-role user can hit /api/system/backup."""
    token = _seed_and_token("owner")
    res = client_anon.post(
        "/api/system/backup",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_backup_legacy_admin_passes(client_anon):
    """iter-197 transitional carve-out: legacy `admin` users keep
    working on owner-only routes including backup."""
    token = _seed_and_token("admin")
    res = client_anon.post(
        "/api/system/backup",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_backup_family_403s(client_anon):
    """Backup operations affect persisted state and credentials —
    family-role users must not initiate them."""
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/system/backup",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_backup_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.post(
        "/api/system/backup",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_backup_anon_401s(client_anon):
    """No cookie → /api/system/backup must 401 (not 403). Same as
    every other auth-gated route."""
    res = client_anon.post("/api/system/backup")
    assert res.status_code == 401


# iter-212 (Feature #10 slice 3): /api/system/restore — owner-only,
# same RBAC profile as backup. Symmetric coverage. Tests pass a
# valid `backup_path` body so the route gets past Pydantic; the
# RBAC dep fires BEFORE the body validates, but a 422 would
# obscure the assertion target.

def _restore_body() -> dict:
    return {"backup_path": "test.tar.gz"}


def test_restore_owner_passes(client_anon, tmp_path, monkeypatch):
    from app.config import settings

    target = tmp_path / "backups"
    target.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", target)
    token = _seed_and_token("owner")
    res = client_anon.post(
        "/api/system/restore",
        cookies={COOKIE_ACCESS: token},
        json=_restore_body(),
    )
    assert res.status_code == 200


def test_restore_legacy_admin_passes(client_anon, tmp_path, monkeypatch):
    """iter-197 transitional carve-out applies to restore too."""
    from app.config import settings

    target = tmp_path / "backups"
    target.mkdir()
    monkeypatch.setattr(settings, "backup_target_dir", target)
    token = _seed_and_token("admin")
    res = client_anon.post(
        "/api/system/restore",
        cookies={COOKIE_ACCESS: token},
        json=_restore_body(),
    )
    assert res.status_code == 200


def test_restore_family_403s(client_anon):
    """Restore overwrites credentials + push subs — family-role
    must not initiate."""
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/system/restore",
        cookies={COOKIE_ACCESS: token},
        json=_restore_body(),
    )
    assert res.status_code == 403


def test_restore_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.post(
        "/api/system/restore",
        cookies={COOKIE_ACCESS: token},
        json=_restore_body(),
    )
    assert res.status_code == 403


def test_restore_anon_401s(client_anon):
    """No cookie → 401 (not 403)."""
    res = client_anon.post(
        "/api/system/restore",
        json=_restore_body(),
    )
    assert res.status_code == 401


# iter-213 (Feature #8 slice 1): /api/system/timelapse + /api/system
# /timelapses are owner-only. Symmetric RBAC profile to backup/
# restore — Charter-destructive operations (host-side ffmpeg
# subprocess + dir scanning of state directory).

def _timelapse_body() -> dict:
    return {"date": "2026-04-30"}


def test_timelapse_post_owner_passes(client_anon):
    token = _seed_and_token("owner")
    res = client_anon.post(
        "/api/system/timelapse",
        cookies={COOKIE_ACCESS: token},
        json=_timelapse_body(),
    )
    assert res.status_code == 200


def test_timelapse_post_legacy_admin_passes(client_anon):
    """iter-197 transitional carve-out applies."""
    token = _seed_and_token("admin")
    res = client_anon.post(
        "/api/system/timelapse",
        cookies={COOKIE_ACCESS: token},
        json=_timelapse_body(),
    )
    assert res.status_code == 200


def test_timelapse_post_family_403s(client_anon):
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/system/timelapse",
        cookies={COOKIE_ACCESS: token},
        json=_timelapse_body(),
    )
    assert res.status_code == 403


def test_timelapse_post_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.post(
        "/api/system/timelapse",
        cookies={COOKIE_ACCESS: token},
        json=_timelapse_body(),
    )
    assert res.status_code == 403


def test_timelapse_post_anon_401s(client_anon):
    res = client_anon.post("/api/system/timelapse", json=_timelapse_body())
    assert res.status_code == 401


def test_timelapse_list_owner_passes(client_anon):
    token = _seed_and_token("owner")
    res = client_anon.get(
        "/api/system/timelapses",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_timelapse_list_viewer_403s(client_anon):
    """Listing the timelapse dir is owner-only — surface area
    consistent with the trigger route. iter-198 RBAC philosophy:
    if you can't generate it, you can't list it."""
    token = _seed_and_token("viewer")
    res = client_anon.get(
        "/api/system/timelapses",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_timelapse_list_anon_401s(client_anon):
    res = client_anon.get("/api/system/timelapses")
    assert res.status_code == 401


# iter-230 (Feature #12 OTA slice 1): /api/system/update is owner-
# only, same RBAC profile as backup/restore/reboot. Charter-most-
# destructive op (replaces running code).

def test_update_owner_passes(client_anon):
    token = _seed_and_token("owner")
    res = client_anon.post(
        "/api/system/update",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_update_legacy_admin_passes(client_anon):
    """iter-197 transitional carve-out applies to update too."""
    token = _seed_and_token("admin")
    res = client_anon.post(
        "/api/system/update",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_update_family_403s(client_anon):
    """Update replaces running code — family-role must not initiate."""
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/system/update",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_update_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.post(
        "/api/system/update",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_update_anon_401s(client_anon):
    res = client_anon.post("/api/system/update")
    assert res.status_code == 401


# iter-238 (Feature #10/12 follow-up): /api/system/backups listing.
# Owner-only — same RBAC profile as backup/restore (the listing
# discloses backup filenames + sizes which are operator-sensitive).

def test_backups_list_owner_passes(client_anon):
    token = _seed_and_token("owner")
    res = client_anon.get(
        "/api/system/backups",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_backups_list_legacy_admin_passes(client_anon):
    token = _seed_and_token("admin")
    res = client_anon.get(
        "/api/system/backups",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_backups_list_family_403s(client_anon):
    token = _seed_and_token("family")
    res = client_anon.get(
        "/api/system/backups",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_backups_list_viewer_403s(client_anon):
    token = _seed_and_token("viewer")
    res = client_anon.get(
        "/api/system/backups",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_backups_list_anon_401s(client_anon):
    res = client_anon.get("/api/system/backups")
    assert res.status_code == 401


def test_detection_config_patch_owner_passes(client_anon):
    token = _seed_and_token("owner")
    res = client_anon.patch(
        "/api/detection/config",
        json={"threshold": 0.6},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_detection_config_patch_family_403s(client_anon):
    token = _seed_and_token("family")
    res = client_anon.patch(
        "/api/detection/config",
        json={"threshold": 0.6},
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 403


def test_detection_config_get_open_to_family(client_anon):
    """GET /api/detection/config is auth-gated (iter-184) but NOT
    role-gated. Family + viewer can see the current settings even
    though they can't change them. Pin to prevent overgating."""
    token = _seed_and_token("family")
    res = client_anon.get(
        "/api/detection/config",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200


def test_detection_toggle_open_to_family(client_anon):
    """`/api/detection/toggle` (the live Detect on/off in the UI)
    stays open to all authenticated users — family members can
    pause detection (e.g. when guests are over). Owner-only
    gating applies only to PATCH /api/detection/config + reboot."""
    token = _seed_and_token("family")
    res = client_anon.post(
        "/api/detection/toggle",
        cookies={COOKIE_ACCESS: token},
    )
    assert res.status_code == 200
