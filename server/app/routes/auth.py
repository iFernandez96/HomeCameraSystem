"""Auth REST routes (iter-181, Auth Plan Phase 3).

Four routes, all under ``/api/auth/``, all ungated at this phase
(any LAN client can hit them). Phase 5 (iter-183) gates the rest
of ``/api/*`` on the cookies these routes set.

- POST ``/api/auth/login``    body LoginIn  → LoginOut + Set-Cookie x2
- POST ``/api/auth/refresh``  body {}       → RefreshOut + Set-Cookie x2
- POST ``/api/auth/logout``   body {}       → {ok: true} + Set-Cookie max-age=0 x2
- GET  ``/api/auth/me``                     → MeOut or 401

Cookies (per the plan's Section "Stack picks"):

- HttpOnly: JS can't read them — XSS can't exfiltrate.
- Secure (toggle via ``COOKIE_SECURE`` env): only sent over HTTPS
  in prod; flipped to false for the dev vite server at
  ``http://localhost:5173``.
- SameSite=Strict: browser refuses to send these on cross-site
  requests, so a malicious LAN page can't mint authenticated
  requests via the user's session. This is the project's CSRF
  defense — no token-dance dance is required (see Charter
  anti-rec #18, no CORS middleware).
- Path=/api: scope to the API surface only; the SPA shell at ``/``
  doesn't need to see the cookies.

Login implements the timing-oracle defense per the Charter:
``verify_password(submitted, dummy_hash())`` on user-not-found so
the wall-clock for "no such user" matches "wrong password". The
dummy hash is precomputed at module import in
``passwords.py`` — see iter-178.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from fastapi import APIRouter, Cookie, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from fastapi import Depends

from ..auth import passwords, tokens, users_db
from ..auth.dependencies import (
    COOKIE_ACCESS,
    COOKIE_REFRESH,
    get_current_user,
    require_role,
)
from ..config import settings


router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str
    role: str


class LoginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user: UserOut


class RefreshOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user: UserOut


class MeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user: UserOut


def _set_session_cookies(response: Response, username: str, role: str) -> None:
    """Mint access + refresh tokens for ``username`` (with ``role``
    encoded into the claims, iter-192) and set both as HttpOnly
    cookies on the outbound response. Both rotate on every login
    and every refresh — sliding window.

    iter-264 (security-auditor D1): ``Cache-Control: no-store`` is
    set at the middleware tier (`main.py::_add_security_headers`)
    on every response under /api/auth/* — including the 401 / 422
    paths that bypass this helper. A forward proxy (Tailscale Funnel,
    future Caddy front, corporate egress) MUST NOT cache a response
    that includes ``Set-Cookie``; otherwise a second user's login
    could receive the first user's tokens.
    """
    access = tokens.issue(username, "access", role=role)
    refresh = tokens.issue(username, "refresh", role=role)
    response.set_cookie(
        COOKIE_ACCESS,
        access,
        max_age=settings.access_token_ttl_s,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/api",
    )
    response.set_cookie(
        COOKIE_REFRESH,
        refresh,
        max_age=settings.refresh_token_ttl_s,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/api",
    )


def _clear_session_cookies(response: Response) -> None:
    """Expire both cookies. Symmetric with ``_set_session_cookies`` —
    same path so the browser actually overwrites (a path mismatch
    would leave the originals in place and the next request would
    look authenticated). Cache-Control: no-store is set by the
    middleware (iter-264 D1), not here."""
    response.delete_cookie(COOKIE_ACCESS, path="/api")
    response.delete_cookie(COOKIE_REFRESH, path="/api")


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, response: Response) -> LoginOut:
    user = users_db.get_user(settings.users_db_path, body.username)
    if user is None:
        # Timing-oracle defense: spend the same ~120 ms verifying
        # against the dummy hash so wall-clock for "no such user"
        # matches "wrong password" — kills username enumeration.
        passwords.verify_password(body.password, passwords.dummy_hash())
        raise HTTPException(status_code=401, detail="invalid credentials")
    if not passwords.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="invalid credentials")
    _set_session_cookies(response, user["username"], user["role"])
    return LoginOut(user=UserOut(username=user["username"], role=user["role"]))


@router.post("/refresh", response_model=RefreshOut)
def refresh(
    response: Response,
    homecam_refresh: Optional[str] = Cookie(default=None),
) -> RefreshOut:
    # iter-186 (Auth Plan Phase 7): every failure path returns 401
    # with detail='session expired' — the client api.ts dispatches a
    # `homecam:session-expired` event on this exact response and the
    # AuthProvider toasts + redirects. Distinguishing missing-cookie
    # vs invalid-cookie vs deleted-user inside the body would help
    # debugging but the client never branches on the detail string,
    # and uniform messaging is friendlier to the operator who's
    # tailing logs trying to spot real failures vs idle expirations.
    if not homecam_refresh:
        raise HTTPException(status_code=401, detail="session expired")
    try:
        claims = tokens.decode(homecam_refresh, kind="refresh")
    except tokens.InvalidToken:
        raise HTTPException(status_code=401, detail="session expired")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(status_code=401, detail="session expired")
    user = users_db.get_user(settings.users_db_path, sub)
    if user is None:
        # User row deleted while their session was live (operator
        # ran `gen_admin`+row delete or the DB was wiped). Refuse
        # the refresh so a stale session can't be revived.
        raise HTTPException(status_code=401, detail="session expired")
    _set_session_cookies(response, user["username"], user["role"])
    return RefreshOut(user=UserOut(username=user["username"], role=user["role"]))


@router.post("/logout")
def logout(response: Response) -> dict:
    _clear_session_cookies(response)
    return {"ok": True}


class ChangePasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=256)
    # iter-264 (security-auditor B1): 8-char floor matches OWASP for
    # argon2-hashed passwords. The pre-iter-264 4-char floor let an
    # authed user self-degrade to a trivially-guessable secret; on a
    # tailnet-exposed deploy that's a short-time brute-force window.
    new_password: str = Field(min_length=8, max_length=256)


class AdminResetPasswordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    # iter-264 (security-auditor B1): see ChangePasswordIn note above —
    # owner-side admin reset shares the same floor so the operator
    # can't reset a family member to a 4-char string either.
    new_password: str = Field(min_length=8, max_length=256)


@router.post("/change_password")
def change_password(
    body: ChangePasswordIn,
    user: str = Depends(get_current_user),
) -> dict:
    """iter-258: self-service password change. Requires the caller's
    current password (defends against an unattended logged-in
    session being hijacked) and an 8+ char new password.

    The current_password verification uses the same constant-time
    `verify_password` as login. On success, replaces the hash and
    returns `{"ok": true}`.
    """
    row = users_db.get_user(settings.users_db_path, user)
    if row is None:
        # User row deleted while session was live — same shape as
        # /api/auth/refresh's "session expired" pathway.
        raise HTTPException(status_code=401, detail="user no longer exists")
    if not passwords.verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="current password incorrect")
    new_hash = passwords.hash_password(body.new_password)
    users_db.update_password(settings.users_db_path, user, new_hash)
    return {"ok": True}


@router.post(
    "/admin/reset_password",
    dependencies=[Depends(require_role("owner"))],
)
def admin_reset_password(body: AdminResetPasswordIn) -> dict:
    """iter-258: owner-only override that resets ANOTHER user's
    password without their current password. The "I forgot my
    password" recovery path for a 2-user home setup — the owner
    (you) resets the family member (e.g., spouse) from your own
    Settings page.

    For owner-self-recovery (you forgot YOUR own password), an
    operator-side recipe lives in CLAUDE.md "Auth recovery" — runs
    `gen_admin --reset` inside the Jetson container as root.
    """
    if users_db.get_user(settings.users_db_path, body.username) is None:
        raise HTTPException(status_code=404, detail="no such user")
    new_hash = passwords.hash_password(body.new_password)
    users_db.update_password(settings.users_db_path, body.username, new_hash)
    return {"ok": True}


# iter-265: owner-only user management. Adds list + create + delete
# so the UI's "Manage users" panel can replace the previous single-
# shot reset-password row. Uses the same require_role("owner") gate
# that admin_reset_password already pins.

class CreateUserIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    # iter-265 password floor matches the iter-264 B1 fix on
    # change_password / admin_reset_password — 8-char minimum so a
    # newly-created user can't be set to a 4-char password.
    password: str = Field(min_length=8, max_length=256)
    # iter-266 (security-auditor B1): create-time roles are the
    # iter-196 NEW vocab (owner / family / viewer). The legacy
    # `admin` role is intentionally OMITTED from the create wire —
    # it exists only as the carry-forward for pre-iter-196 seeded
    # users (handled by iter-178 bootstrap). Letting the wire
    # create new `admin` users would recreate the ambiguity the
    # iter-196 vocab was meant to eliminate. Storage layer
    # (`users_db.create_user`) keeps `admin` valid so the seed +
    # legacy-migration paths still work.
    role: str = Field(pattern=r"^(owner|family|viewer)$")


class UserRowOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str
    role: str
    created_at: float


class ListUsersOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    users: list[UserRowOut]


@router.get(
    "/admin/users",
    response_model=ListUsersOut,
    dependencies=[Depends(require_role("owner"))],
)
def admin_list_users() -> ListUsersOut:
    """iter-265: list every user, owner-only. Returns username +
    role + created_at — never the password hash. Used by the
    Settings "Manage users" panel."""
    rows = users_db.list_users(settings.users_db_path)
    return ListUsersOut(
        users=[
            UserRowOut(
                username=r["username"],
                role=r["role"],
                created_at=r["created_at"],
            )
            for r in rows
        ]
    )


@router.post(
    "/admin/users",
    dependencies=[Depends(require_role("owner"))],
    status_code=201,
)
def admin_create_user(body: CreateUserIn) -> dict:
    """iter-265: create a new user, owner-only. 409 on duplicate
    username (sqlite IntegrityError). 422 on bad role (handled by
    Pydantic before this body runs, but the storage layer also
    validates as belt-and-braces — InvalidRole is a ValueError
    subclass so a future wire schema drift can't sneak past)."""
    try:
        new_hash = passwords.hash_password(body.password)
        users_db.create_user(
            settings.users_db_path,
            body.username,
            new_hash,
            role=body.role,
        )
    except users_db.InvalidRole as e:
        raise HTTPException(status_code=422, detail=str(e))
    except sqlite3.IntegrityError as e:
        # iter-266 (security-auditor G1): catch IntegrityError
        # specifically rather than the broad `except Exception` in
        # iter-265. UNIQUE-constraint violation on the username
        # PRIMARY KEY → 409. Other integrity errors (e.g. a future
        # FK violation if the schema grows) re-raise as 500.
        if "UNIQUE constraint failed" in str(e):
            raise HTTPException(status_code=409, detail="username already exists")
        raise
    return {"ok": True, "username": body.username, "role": body.role}


class DeleteUserIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)


@router.post(
    "/admin/delete_user",
    dependencies=[Depends(require_role("owner"))],
)
def admin_delete_user(
    body: DeleteUserIn,
    caller: str = Depends(get_current_user),
) -> dict:
    """iter-265: delete a user, owner-only.

    Two safety guards beyond the role check:
    - You can't delete YOURSELF (would lock you out the next time
      your access cookie expires; the refresh would fail because
      the user row is gone).
    - You can't delete the LAST owner (would leave the deployment
      with no admin-capable account; recovery requires SSH + the
      operator-side `gen_admin --reset` recipe).
    """
    if body.username == caller:
        raise HTTPException(
            status_code=400,
            detail="cannot delete your own account",
        )
    # iter-267 (security-auditor D follow-up): atomic last-owner
    # check + delete in a single BEGIN IMMEDIATE transaction.
    # Pre-iter-267 the count was a separate read from the delete
    # statement; two concurrent owner-delete POSTs could each see
    # 2 owners, both proceed, and the deployment ended up with 0
    # owner-tier accounts (recovery cost: SSH + gen_admin --reset).
    try:
        deleted = users_db.delete_user_atomic(
            settings.users_db_path, body.username
        )
    except users_db.CannotDeleteLastOwner:
        raise HTTPException(
            status_code=400,
            detail="cannot delete the last owner",
        )
    if not deleted:
        raise HTTPException(status_code=404, detail="no such user")
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(homecam_access: Optional[str] = Cookie(default=None)) -> MeOut:
    # iter-264 (D1): Cache-Control: no-store applied via the
    # middleware path-prefix branch in main.py — covers the 401
    # paths below that build a fresh JSONResponse from HTTPException
    # (which loses any header set on an injected `Response`).
    if not homecam_access:
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        claims = tokens.decode(homecam_access, kind="access")
    except tokens.InvalidToken:
        raise HTTPException(status_code=401, detail="invalid access cookie")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(status_code=401, detail="invalid access cookie")
    user = users_db.get_user(settings.users_db_path, sub)
    if user is None:
        raise HTTPException(status_code=401, detail="user no longer exists")
    return MeOut(user=UserOut(username=user["username"], role=user["role"]))
