"""Auth foundation (iter-178, Auth Plan Phase 1).

This package is a no-op until Phase 3 wires the `/api/auth/*` routes.
Phase 1 lands the building blocks ONLY:

- `users_db.py`        sqlite store (init, get, create, update password)
- `passwords.py`       argon2-cffi wrapper (hash, verify)
- `jwt_secret.py`      32-byte HS256 secret loader (tolerant load,
                       generate-on-first-boot, mode 0o600)

Phase 2 (iter-179): `gen_admin` script + env-var seed via lifespan.
Phase 3 (iter-181): `tokens.py` + the 4 auth routes.

Lock-ins from the user (don't propose alternatives):
- Per-user accounts. JWT. sqlite via stdlib `sqlite3`.
- Full-page `/login` route on the client (Phase 4).
- `/api/_internal/*` worker routes use their own direct-peer bearer credential;
  they do not use browser JWT cookies.
- Bootstrap via env-var seed; day-2 admin via `gen_admin` script.
"""
