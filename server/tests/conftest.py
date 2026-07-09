"""Shared pytest fixtures.

Each test module imports `client` from this fixture; the TestClient context
manager runs FastAPI lifespan (which starts camera_service / detection_service),
so by the time the test body runs the app is fully initialised. Lifespan exit
also stops detection_service, so any test that toggles detection on doesn't
leak the simulator into subsequent tests in the same module.

iter-184 (Auth Plan Phase 5 — HARD CUTOVER): the default `client` fixture
is now AUTHENTICATED. It seeds a `testuser/testpass` admin into a tmp
users.db, monkeypatches `settings` to point auth state at tmp paths, and
performs `/api/auth/login` BEFORE yielding so the cookie flows on every
subsequent request. Tests that need to verify gate-rejected behaviour
(401 without auth) explicitly use the `client_anon` fixture.

This deviates from the auth_plan_iter177.md Phase 5 wording (which called
for renaming `client` → `client_anon` and forcing every test to opt into
`client_authed`). The end state is the same — gate enforced, two fixture
options — but the opt-in direction is flipped to keep the diff small. ~250+
test edits across 19 files would be a high-risk migration in an autonomous
loop iter; the chosen approach achieves identical security without that
blast radius. Documented in `loop_audit_log.md` iter-184 entry.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def _auth_setup(tmp_path, monkeypatch):
    """Per-test isolated users.db + jwt_secret + non-secure cookies.
    Seeds a `testuser` admin so the default `client` fixture can
    log in. Run as a dependency of `client` and `client_anon` (NOT
    autouse — tests that don't need a TestClient skip the work).
    """
    from app.auth import passwords, users_db
    from app.config import settings

    monkeypatch.setattr(settings, "users_db_path", tmp_path / "users.db")
    monkeypatch.setattr(settings, "jwt_secret_path", tmp_path / "jwt.bin")
    monkeypatch.setattr(settings, "vapid_private_key_path", tmp_path / "vapid_private.pem")
    monkeypatch.setattr(settings, "vapid_public_key_path", tmp_path / "vapid_public.pem")
    monkeypatch.setattr(settings, "push_subs_path", tmp_path / "push_subs.json")
    monkeypatch.setattr(settings, "detection_config_path", tmp_path / "detection_config.json")
    monkeypatch.setattr(settings, "events_db_path", tmp_path / "events.db")
    monkeypatch.setattr(settings, "audit_db_path", tmp_path / "audit.db")
    monkeypatch.setattr(settings, "sessions_db_path", tmp_path / "sessions.db")
    monkeypatch.setattr(settings, "backup_target_dir", tmp_path / "backups")
    monkeypatch.setattr(settings, "backup_ledger_path", tmp_path / "backup-ledger.jsonl")
    # TestClient runs over HTTP; Secure cookies wouldn't propagate.
    monkeypatch.setattr(settings, "cookie_secure", False)
    # OTA paths default to container-only /app/secrets — the update route
    # ALWAYS appends a ledger line (U18 invariant), so any test touching it
    # on a dev box needs scratch paths.
    ota_root = tmp_path / "dist-ota"
    ota_client_dist_target = tmp_path / "client_dist"
    ota_client_dist_target.mkdir()
    (ota_client_dist_target / "index.html").write_text("old client\n", encoding="utf-8")
    monkeypatch.setattr(settings, "ota_root", ota_root)
    monkeypatch.setattr(settings, "ota_manifest_path", ota_root / "update-manifest.json")
    monkeypatch.setattr(settings, "ota_artifacts_dir", ota_root / "artifacts")
    monkeypatch.setattr(settings, "ota_staging_root", ota_root / "staging")
    for _name in ("ota_active_pointer", "ota_ledger_path"):
        if hasattr(settings, _name):
            monkeypatch.setattr(
                settings, _name, ota_root / getattr(settings, _name).name
            )
    monkeypatch.setattr(settings, "ota_client_dist_target", ota_client_dist_target)

    users_db.init_db(tmp_path / "users.db")
    # Idempotent: a second test under a fresh tmp_path makes a new
    # db, but a test that ALSO uses test_auth_routes.py's
    # `seeded_user` fixture would already have called `init_db` on
    # the SAME path — no conflict, init_db is CREATE TABLE IF NOT
    # EXISTS. The user insert here may collide with a same-name
    # user from another fixture; `testuser` is unique to this
    # conftest so collisions are rare in practice.
    try:
        users_db.create_user(
            tmp_path / "users.db",
            "testuser",
            passwords.hash_password("testpass"),
            role="admin",
        )
    except Exception:
        # Already exists from a prior fixture in the same test —
        # no-op. The login below uses the (existing) hash.
        pass
    yield


@pytest.fixture
def client(_auth_setup) -> TestClient:
    """Default test client: AUTHENTICATED as testuser/admin (iter-184).
    Tests that need to verify the gate's 401-on-anonymous behavior
    should explicitly use the `client_anon` fixture instead."""
    from app.main import app

    with TestClient(app) as c:
        login = c.post(
            "/api/auth/login",
            json={"username": "testuser", "password": "testpass"},
        )
        # If this fails the entire test suite is meaningless — surface
        # loudly rather than letting downstream assertions confuse the
        # diagnosis.
        assert login.status_code == 200, (
            "auto-login failed in conftest: {} — body={!r}".format(
                login.status_code, login.text
            )
        )
        yield c


@pytest.fixture
def client_anon(_auth_setup) -> TestClient:
    """Explicitly anonymous test client (iter-184). Use for tests
    that pin the gate's behavior on unauthenticated requests, or
    that exercise public surface (`/api/_internal/*`,
    `/api/auth/login`, middleware that runs before the gate)."""
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_push_subs(tmp_path):
    """Make sure each test starts with no in-memory push subscriptions, and
    redirect the singleton's persistence file to a per-test tmp path so
    tests can't pollute each other or the working directory."""
    from app.services.push_service import push_service

    original_path = push_service.persist_path
    push_service.persist_path = tmp_path / "push_subs.json"
    push_service.subs.clear()
    yield
    push_service.subs.clear()
    push_service.persist_path = original_path


@pytest.fixture(autouse=True)
def _reset_worker_health():
    """Avoid heartbeat state bleeding between tests."""
    from app.services.health import worker_health

    worker_health.last_heartbeat = 0.0
    worker_health.last_metrics = None
    yield
    worker_health.last_heartbeat = 0.0
    worker_health.last_metrics = None


@pytest.fixture(autouse=True)
def _reset_event_bus():
    """Avoid event-history bleeding between tests. Older tests use
    before/after length deltas which work in isolation but break
    once a heavier test (e.g. iter-86's history-cap check) fills
    the maxlen=200 deque and the next post evicts an old entry."""
    from app.services.event_bus import event_bus

    event_bus.reset()
    yield
    event_bus.reset()


@pytest.fixture(autouse=True)
def _reset_unread_cache():
    """iter-288 (security-auditor F1): the per-event unread_count
    is now cached for 1 s in `_internal._UNREAD_CACHE` to avoid
    burst-storm SQLite contention. Reset between tests so the
    iter-276 test that asserts a fresh unread_count refresh on
    every event isn't tripped by a cached value from a prior test
    (especially across test ordering / random seeds)."""
    from app.routes import _internal

    _internal._UNREAD_CACHE["value"] = 0
    _internal._UNREAD_CACHE["ts"] = 0.0
    yield


@pytest.fixture(scope="session")
def _events_db_session_path(tmp_path_factory):
    """iter-236 (Risk #4 follow-up from iter-225/235): session-scoped
    events.db. Pre-iter-236 a per-test fresh DB + init_db ran on every
    test, doubling the suite duration (55s → 107s pre-venv-rebuild).
    Single init per session + per-test truncate (`events_db.reset()`)
    gives the same isolation at a fraction of the cost.

    Caveat: pytest-xdist (parallel runners) gives each worker its own
    session-scoped fixture instance, so this stays correct under
    parallelism. Within a single worker, tests run sequentially —
    reset-before-each is sufficient.
    """
    from app.services import events_db

    path = tmp_path_factory.mktemp("events_db_session") / "events.db"
    events_db.init_db(path)
    return path


@pytest.fixture(autouse=True)
def _isolate_events_db(_events_db_session_path, monkeypatch):
    """iter-217 (per-test redirect) + iter-236 (session-scoped DB).
    Truncates the session DB before each test via `events_db.reset()`
    so per-test isolation is preserved without the per-test init_db
    cost. Same external contract as the original fixture.
    """
    from app.config import settings
    from app.services import events_db

    monkeypatch.setattr(settings, "events_db_path", _events_db_session_path)
    events_db.reset(_events_db_session_path)
    yield


@pytest.fixture(scope="session")
def _audit_db_session_path(tmp_path_factory):
    from app.services import audit_db

    path = tmp_path_factory.mktemp("audit_db_session") / "audit.db"
    audit_db.init_db(path)
    return path


@pytest.fixture(autouse=True)
def _isolate_audit_db(_audit_db_session_path, monkeypatch):
    from app.config import settings
    from app.services import audit_db

    monkeypatch.setattr(settings, "audit_db_path", _audit_db_session_path)
    audit_db.reset(_audit_db_session_path)
    yield


@pytest.fixture(autouse=True)
def _isolate_host_bridge(tmp_path, monkeypatch):
    from app.config import settings
    from app.services import host_bridge

    path = tmp_path / "host_action.json"
    monkeypatch.setattr(settings, "host_action_state_path", path)
    host_bridge.reset_for_tests(path)
    yield
    host_bridge.reset_for_tests(path)


@pytest.fixture(autouse=True)
def _reset_detection_config(tmp_path):
    """Each test starts from defaults, persistence redirected to tmp."""
    from app.services.detection_config import (
        DetectionConfig,
        detection_config,
    )

    original_path = detection_config.path
    original_config = detection_config.config
    detection_config.path = tmp_path / "detection_config.json"
    detection_config.config = DetectionConfig()
    yield
    detection_config.path = original_path
    detection_config.config = original_config


@pytest.fixture(autouse=True)
def _reset_timelapse_state():
    """The timelapse route tracks background-build status in module-global
    dicts (control._TIMELAPSE_STATUS / _TIMELAPSE_TASKS). Without a reset,
    a build started by one test (e.g. the auth-gating POST to
    /api/system/timelapse) leaves a stale `building` entry — then a later
    test's de-dupe guard ("already building") skips its own build and its
    status poll never settles. Clear before AND after each test."""
    from app.routes import control

    control._TIMELAPSE_STATUS.clear()
    control._TIMELAPSE_TASKS.clear()
    yield
    control._TIMELAPSE_STATUS.clear()
    control._TIMELAPSE_TASKS.clear()
