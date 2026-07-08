**Harness #3: Auth/Session Lifecycle**

**1. Risky-Core Contract**

Lifecycle to pin against the real server:

1. Login: `POST /api/auth/login` with valid user sets `homecam_access` and `homecam_refresh`, both HttpOnly, `SameSite=Strict`, `path=/api`, `Secure=settings.cookie_secure`. Access token claim `kind=access`, refresh token claim `kind=refresh`; wrong-kind use must 401.
2. Access expiry: any non-`/api/auth/*` REST request returning 401 triggers exactly one `POST /api/auth/refresh`, then retries the original request once.
3. Silent refresh: valid refresh cookie rotates both cookies and returns the user. The UI must remain authed and must not emit `homecam:session-expired`.
4. Refresh expiry/invalid: refresh 401 emits `homecam:session-expired`; `AuthProvider` sets anon, shows one “Session expired” toast, and login redirect can carry the expired flag.
5. Re-login: successful login clears the expired flag and restores authed state.
6. WS 1008: `events_ws` rejects missing/expired/bad access cookie with close `1008 reason="auth required"`. `client/src/lib/ws.ts` emits `homecam:auth-failed`; `AuthProvider` currently calls `/api/auth/me`.
7. Critical distinction: `homecam:auth-failed` is a “WS policy/auth ambiguity, re-check state” signal. `homecam:session-expired` means refresh failed and the session is unrecoverable without credentials.

**Likely contract bug to expose:** WS access expiry currently causes `/api/auth/me` 401, and `/me` deliberately does not refresh. So a valid refresh cookie may exist, but the client still flips anon.

**2. Compressed-Clock Strategy**

Server half: use the real FastAPI app with real `users_db`, real `tokens.issue/decode`, real cookies. Start with `TestClient` for atomic server invariants because it can isolate `USERS_DB_PATH`, `JWT_SECRET_PATH`, `COOKIE_SECURE=false`, `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_S` via `settings` monkeypatch before requests. For the browser leg, run `uvicorn` on a scratch port with env vars set before process start:

`USERS_DB_PATH`, `JWT_SECRET_PATH`, `COOKIE_SECURE=false`, `ACCESS_TOKEN_TTL_S=1`, `REFRESH_TOKEN_TTL_S=4`.

Client half: use Playwright, not jsdom, for lifecycle proof. jsdom is fine for unit pins of `CustomEvent` dispatch/dedupe, but it cannot honestly prove HttpOnly cookie expiry, cookie `path=/api`, browser WebSocket cookie sending, visibility/background behavior, or real navigation/redirect/toast outcomes. Playwright should assert: login succeeds; cookies are HttpOnly/path `/api`; after access TTL a protected REST call silently refreshes; after refresh TTL a protected call redirects/shows expired UX; WS 1008 while refresh is still valid does not sign out once fixed; WS 1008 after refresh expiry does sign out.

**3. Ranked Hypotheses For Double Sign-Out**

1. **Most likely: WS 1008 path bypasses refresh.** Expired access cookie closes WS with 1008; `homecam:auth-failed` calls `/api/auth/me`; `/me` 401 does not attempt refresh; UI signs out despite valid refresh cookie.
2. **Likely: refresh is only reactive to REST calls.** No proactive refresh timer exists. Backgrounded phone may wake with expired access; first signal may be WS, not REST, hitting hypothesis #1.
3. **Medium: refresh cookie expiry shorter than operator expects.** Code default is 7 days, but env `REFRESH_TOKEN_TTL_S` could be lower in deploy.
4. **Medium: server restart/volume issue rotates `JWT_SECRET_PATH`.** Secret is file-backed and read every issue/decode; if the secret path is not persisted, restart invalidates all sessions.
5. **Lower: cookie `Secure`/SameSite/path mismatch.** `SameSite=Strict`, `path=/api`, `Secure=true` are correct for same-origin HTTPS, but proxy/hostname changes or HTTP access would drop cookies.
6. **Lower: user row deleted/DB path changed.** Server re-checks user row on access and refresh; a wiped or different `USERS_DB_PATH` makes live sessions unrecoverable.

**4. Atomic Step List**

1. A1: Server fixture creates scratch users DB and JWT secret; invariant: login sets both cookies with expected names/path/security attributes.
2. A2: Token claims pin; invariant: access and refresh have correct `kind`, `sub`, `role`, `exp`.
3. A3: Wrong-kind boundary; invariant: refresh-as-access and access-as-refresh both 401.
4. A4: Access-expired/refresh-valid REST path; invariant: protected REST 401 followed by refresh rotates cookies and retry succeeds.
5. A5: Refresh single-flight; invariant: concurrent protected REST 401s produce exactly one refresh.
6. A6: Refresh-expired path; invariant: refresh 401 emits one `homecam:session-expired` and requires re-login.
7. A7: WS access-expired/refresh-valid reproducer; invariant: current code signs out on 1008 plus `/me` 401 while refresh would succeed. Hypothesis killer.
8. A8: Desired WS self-heal contract; invariant: 1008 triggers refresh attempt before anon, remains authed if refresh succeeds.
9. A9: WS true expiry; invariant: 1008 plus failed refresh emits `homecam:session-expired`.
10. A10: Scratch uvicorn + Playwright login/expiry proof; invariant: real browser cookies expire/rotate as server contract says.
11. A11: Playwright background/resume; invariant: after access TTL in hidden/idle state, resume does not sign out while refresh is valid.
12. A12: Secret rotation proof; invariant: changing `JWT_SECRET_PATH` contents makes both REST refresh and WS self-heal fail into session-expired.
