"""FastAPI dependencies for auth.

- ``get_current_user_optional`` (iter-181, Phase 3) — returns the
  username or ``None``. Used by routes that branch on auth state
  rather than 401-ing on anonymous (``/api/auth/me`` is the only
  caller today).
- ``get_current_user`` (iter-184, Phase 5) — STRICT. Raises 401 on
  any failure (missing cookie, expired, wrong kind, invalid
  signature). Wired into every gated route via FastAPI
  ``Depends(...)`` — see ``main.py`` and ``routes/{control,push}.py``
  / ``routes/events.py::list_events``. WS endpoint stays ungated
  here; Phase 6 (iter-185) gates it via cookie inside the handshake.

Cookie names are pinned here so the route handlers and the future
WS gate (Phase 6) reference the same constants — prevents a typo
in either spot from silently breaking auth sessions.
"""
from __future__ import annotations

import logging

from fastapi import Cookie, HTTPException, Request

from . import tokens, users_db
from ..config import settings
from ..log import auth_rejected


log = logging.getLogger(__name__)


COOKIE_ACCESS = "homecam_access"
COOKIE_REFRESH = "homecam_refresh"


def _req(request: Request | None):
    """(method, path) for the auth-rejection log line, tolerating a
    missing Request (FastAPI always injects one for a route dep, but a
    direct unit-test call may omit it)."""
    if request is None:
        return ("?", "?")
    return (request.method, request.url.path)


async def get_current_user_optional(
    request: Request = None,  # type: ignore[assignment]
    homecam_access: str | None = Cookie(default=None),
) -> str | None:
    """Return the username from a valid access cookie, or ``None``
    when the cookie is missing, expired, or otherwise invalid.
    Never raises — distinguishes those cases by returning ``None``
    silently. The strict variant below raises 401 instead.

    iter-266 (security-auditor C): also returns ``None`` when the
    user row no longer exists in users.db (admin deleted them while
    their session was live). Without this re-check, a deleted user
    keeps full access until their access cookie expires (up to 15
    minutes), including hitting owner-only routes.
    """
    if not homecam_access:
        # Normal anonymous case (no session yet) — silent, this is the
        # expected state on the login screen.
        return None
    method, path = _req(request)
    try:
        claims = tokens.decode(homecam_access, kind="access")
    except tokens.InvalidToken as e:
        # DEBUG (not WARN): the optional gate resolving anon despite a
        # PRESENT cookie is the interesting signal (stale/expired
        # session that the UI thinks is live). Skip the normal
        # no-cookie case above; this branch is cookie-present-but-bad.
        log.debug(
            "optional-auth resolved anon despite cookie on %s %s: %s",
            method,
            path,
            e,
        )
        return None
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        log.debug(
            "optional-auth resolved anon despite cookie on %s %s: malformed sub",
            method,
            path,
        )
        return None
    if users_db.get_user(settings.users_db_path, sub) is None:
        log.debug(
            "optional-auth resolved anon despite cookie on %s %s: "
            "user row gone (sub=%r)",
            method,
            path,
            sub,
        )
        return None
    return sub


async def get_current_user(
    request: Request = None,  # type: ignore[assignment]
    homecam_access: str | None = Cookie(default=None),
) -> str:
    """Return the username from a valid access cookie, or raise
    ``HTTPException(401)``. This is the gate every protected route
    sits behind from iter-184 onward.

    Routes attach this via:
        ``app.include_router(router, dependencies=[Depends(get_current_user)])``
    (router-wide) for ``control.py`` + ``push.py``, or via per-route
    ``Depends(...)`` for ``events.list_events`` (its sibling WS
    endpoint stays ungated until Phase 6 / iter-185).

    iter-266 (security-auditor C): re-checks ``users_db.get_user``
    on every request. A user deleted by the iter-265 admin/delete
    route keeps a valid signed JWT until cookie expiry; without this
    re-check they retain full access (including owner-only routes if
    their role claim was ``owner``) for up to 15 minutes after
    deletion. Cost: one PRIMARY-KEY SQLite lookup (~0.5 ms on the
    Jetson eMMC) per authed request — dominated by the existing
    iter-244 connection-per-call pattern's open/close.
    """
    method, path = _req(request)
    if not homecam_access:
        auth_rejected(log, method, path, "no cookie", cookie_present=False)
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        claims = tokens.decode(homecam_access, kind="access")
    except tokens.InvalidToken as e:
        # invalid signature / expired / malformed / wrong-kind — the
        # exception text carries the discriminator (tokens.decode also
        # DEBUG/WARN-logs the precise PyJWT type). Cookie was present.
        auth_rejected(
            log, method, path, "invalid/expired: {}".format(e),
            cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="invalid access cookie")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        auth_rejected(
            log, method, path, "malformed sub", cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="invalid access cookie")
    if users_db.get_user(settings.users_db_path, sub) is None:
        # SECURITY EVENT: a validly-signed, unexpired token whose user
        # row no longer exists = a session live when the admin deleted
        # the user. Refuse. WARN (survives prod) and name the sub so
        # the household audit trail records who was deleted-while-live.
        auth_rejected(
            log, method, path, "user row gone (deleted-while-live)",
            sub=sub, cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="user no longer exists")
    return sub


async def get_current_user_role(
    request: Request = None,  # type: ignore[assignment]
    homecam_access: str | None = Cookie(default=None),
) -> tuple[str, str]:
    """Return ``(username, role)`` from a valid access cookie, or
    raise ``HTTPException(401)`` (iter-192, Feature #3 RBAC).

    The ``role`` claim is read off the JWT — pre-iter-192 tokens
    that lack it default to ``"admin"`` (every seeded user before
    iter-192 was admin-by-default; the fallback keeps existing
    sessions valid across the iter-192 deploy without forcing a
    re-login).

    iter-266 (security-auditor C): role is read from the **current**
    DB row rather than the JWT claim when available. This means a
    role change via owner-side edit (future iter; not yet exposed)
    propagates within one request, AND a deleted user 401s instead
    of retaining access. The JWT role claim stays as a fallback for
    pre-iter-192 sessions (no DB roundtrip path).

    Pair with ``require_role(role)`` to gate a specific route. Bare
    ``Depends(get_current_user)`` (the iter-184 strict variant) is
    fine when the route only needs to know the user is authed.
    """
    method, path = _req(request)
    if not homecam_access:
        auth_rejected(log, method, path, "no cookie", cookie_present=False)
        raise HTTPException(status_code=401, detail="not authenticated")
    try:
        claims = tokens.decode(homecam_access, kind="access")
    except tokens.InvalidToken as e:
        auth_rejected(
            log, method, path, "invalid/expired: {}".format(e),
            cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="invalid access cookie")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        auth_rejected(
            log, method, path, "malformed sub", cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="invalid access cookie")
    row = users_db.get_user(settings.users_db_path, sub)
    if row is None:
        auth_rejected(
            log, method, path, "user row gone (deleted-while-live)",
            sub=sub, cookie_present=True,
        )
        raise HTTPException(status_code=401, detail="user no longer exists")
    # iter-266: prefer DB row's role over JWT claim. Falls through
    # to claim-or-admin for tokens that pre-date the iter-192 role
    # claim AND somehow have a row missing the role column (won't
    # happen post-iter-178 schema, but cheap belt-and-braces).
    db_role = row.get("role")
    if isinstance(db_role, str) and db_role:
        return (sub, db_role)
    # SILENT PRIVILEGE ESCALATION risk: the DB row has no usable role
    # so we fall back to the JWT claim, and if that's also missing, to
    # "admin" (the pre-iter-192 default). Either fallback can grant a
    # user more privilege than the operator believes they have. WARN
    # so this anomalous resolution is never silent.
    claim_role = claims.get("role")
    if isinstance(claim_role, str) and claim_role:
        log.warning(
            "role resolution fell back to JWT claim on %s %s "
            "(sub=%r role=%r) — DB row had no role",
            method, path, sub, claim_role,
        )
        return (sub, claim_role)
    log.warning(
        "role resolution fell back to default 'admin' on %s %s "
        "(sub=%r) — neither DB row nor JWT claim carried a role; "
        "possible silent privilege escalation",
        method, path, sub,
    )
    return (sub, "admin")


def require_role(required: str):
    """Factory: returns a dep that raises 403 unless the current
    user's role matches ``required`` (iter-192, Feature #3 RBAC).

    iter-192 ships the foundation only; the role-name vocabulary
    (today: ``admin`` for everyone) will expand at the next RBAC
    iter to ``owner`` / ``family`` / ``viewer`` per
    `feature_ideas_iter177.md` Feature #3. Callers wire via:

        @router.post("/system/reboot",
                     dependencies=[Depends(require_role("owner"))])
        async def reboot(...): ...

    or per-route ``_user: str = Depends(require_role("owner"))``
    when the route also wants the username.
    """
    # Local Depends import keeps the dep injection clean: FastAPI
    # resolves `get_current_user_role` and passes the tuple in.
    from fastapi import Depends

    async def _dep(
        request: Request = None,  # type: ignore[assignment]
        user_and_role: tuple[str, str] = Depends(get_current_user_role),
    ) -> str:
        username, role = user_and_role
        # iter-197 (Feature #3 slice 3): legacy `admin` users (seeded
        # by iter-178/179 bootstrap, JWT-decoded as `admin` per
        # iter-192's fallback) are treated as effective `owner` until
        # a future cleanup iter migrates them to explicit `owner`
        # role. Without this, every existing seeded user 403s on
        # `require_role("owner")` immediately after iter-197 deploys.
        # Transitional — drop the `admin` carve-out once the user
        # vocabulary is fully `owner`/`family`/`viewer`.
        if role == required:
            return username
        if required == "owner" and role == "admin":
            return username
        # RBAC deny — authenticated but under-privileged. WARN with the
        # user, their actual role, and the required role so the
        # household has an audit trail of attempted privilege use.
        method, path = _req(request)
        auth_rejected(
            log, method, path,
            "RBAC deny: role={!r} required={!r}".format(role, required),
            sub=username, cookie_present=True,
        )
        raise HTTPException(
            status_code=403,
            detail="role '{}' required".format(required),
        )

    return _dep
