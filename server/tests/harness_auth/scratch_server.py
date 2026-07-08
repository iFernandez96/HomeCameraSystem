from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response

from app.routes import auth as auth_routes


@dataclass(frozen=True)
class ScratchUser:
    username: str
    password: str
    role: str = "admin"


@dataclass(frozen=True)
class ScratchAuthServer:
    app: FastAPI
    client: TestClient
    user: ScratchUser
    users_db_path: Path
    jwt_secret_path: Path
    access_token_ttl_s: int
    refresh_token_ttl_s: int
    cookie_secure: bool

    def post_login(self) -> Response:
        return self.client.post(
            "/api/auth/login",
            json={
                "username": self.user.username,
                "password": self.user.password,
            },
        )


@pytest.fixture
def scratch_auth_server(tmp_path, monkeypatch) -> ScratchAuthServer:
    """Scratch auth server for Harness #3.

    `server/tests/conftest.py` provides similar scratch auth state, but its
    TestClient fixture enters app lifespan. A1 only needs the auth route, so
    this fixture mirrors the same settings isolation without starting unrelated
    services.
    """
    from app.auth import passwords, users_db
    from app.config import settings
    app = FastAPI()
    app.include_router(auth_routes.router, prefix="/api")

    access_ttl_s = 11
    refresh_ttl_s = 29
    users_db_path = tmp_path / "users.db"
    jwt_secret_path = tmp_path / "jwt.bin"

    monkeypatch.setattr(settings, "users_db_path", users_db_path)
    monkeypatch.setattr(settings, "jwt_secret_path", jwt_secret_path)
    monkeypatch.setattr(settings, "access_token_ttl_s", access_ttl_s)
    monkeypatch.setattr(settings, "refresh_token_ttl_s", refresh_ttl_s)
    monkeypatch.setattr(settings, "cookie_secure", False)

    users_db.init_db(users_db_path)

    user = ScratchUser(username="harness_a1", password="correct horse battery staple")
    users_db.create_user(
        users_db_path,
        user.username,
        passwords.hash_password(user.password),
        role=user.role,
    )
    client = TestClient(app)

    server = ScratchAuthServer(
        app=app,
        client=client,
        user=user,
        users_db_path=users_db_path,
        jwt_secret_path=jwt_secret_path,
        access_token_ttl_s=access_ttl_s,
        refresh_token_ttl_s=refresh_ttl_s,
        cookie_secure=settings.cookie_secure,
    )
    yield server
    client.close()
