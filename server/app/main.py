from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .auth.dependencies import get_current_user
from .config import settings
from .routes import _internal, auth, cameras, clips, control, events, face, healthz, metrics_prom, push, telemetry, training, training_admin
from .services.camera import camera_service
from .services.detection import detection_service
from .services.detection_config import detection_config
from .services.health import seconds_since_last_frame, worker_health
from .services.push_service import push_service

# Level from HOMECAM_LOG_LEVEL (default INFO) so an operator can flip to
# DEBUG during triage without a code change — every DEBUG breadcrumb added
# across the routes/services stays dormant-but-flippable. Plain text +
# %s lazy interpolation (never f-strings) so disabled levels skip formatting.
logging.basicConfig(
    level=os.environ.get("HOMECAM_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


class _SuppressNoisyAccess(logging.Filter):
    """Drop uvicorn access-log lines for the high-volume polling
    endpoints. The PWA hits `/api/status` every 5 s (with as many
    open sessions as users), the worker hits
    `/api/_internal/heartbeat` every 10 s, and the worker also polls
    `/api/detection/config` every 30 s — together they generate ~1k+
    routine log lines per hour and bury the actually interesting
    routes (events, detection/config PATCH, push subscribe).
    Dropping them at the access-log layer also cuts SD-card writes
    on the Jetson.

    Match against the formatted message containing the request line
    in quotes (`"GET /api/status HTTP/1.1"`) so we can't be tricked
    by a path-prefix request like `/api/status-fake`. Method-prefixed
    so PATCH /api/detection/config (the user editing settings) still
    surfaces in the journal — that's an interesting event.
    """

    _suppressed_lines = (
        '"GET /api/status ',
        '"POST /api/_internal/heartbeat ',
        '"GET /api/detection/config ',
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(needle in msg for needle in self._suppressed_lines)


logging.getLogger("uvicorn.access").addFilter(_SuppressNoisyAccess())
log = logging.getLogger("homecam")

START_TIME = time.time()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Each boot step is wrapped with a NAMED error before re-raising so
    # the journal says WHICH step aborted the boot (pre-this-iter a
    # failing step surfaced only as a bare traceback with no operation
    # context). Re-raise is deliberate: a half-initialised server (no
    # snapshots dir, no users.db, no events.db) must NOT come up
    # serving requests against missing state.
    try:
        settings.snapshots_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log.error(
            "lifespan: mkdir snapshots_dir failed at %s (volume "
            "unmounted / full / read-only) — aborting boot",
            settings.snapshots_dir, exc_info=True,
        )
        raise
    # iter-179: Auth Plan Phase 2 — first-boot admin seed. Runs BEFORE
    # camera/detection start so the users.db exists when Phase 3's
    # routes (iter-181) start consuming it. Idempotent: if users.db
    # already has rows, this is a no-op. Logs which path it took
    # (seeded / skipped-empty-env / skipped-existing-users / refused-
    # plaintext) so the journal is greppable.
    from .auth.bootstrap import seed_from_env_if_empty
    try:
        seed_from_env_if_empty(
            settings.users_db_path,
            settings.admin_user_seed,
            settings.admin_password_hash_seed,
        )
    except Exception:
        # bootstrap.seed_from_env_if_empty already ERROR-logs the
        # specific failing DB op; add the lifespan-step name so the
        # boot abort is greppable as a startup step.
        log.error(
            "lifespan: auth seed step failed (users_db_path=%s) — "
            "aborting boot", settings.users_db_path, exc_info=True,
        )
        raise
    # iter-217 (Feature #6 slice 2): SQLite events store. init_db is
    # idempotent (CREATE IF NOT EXISTS + WAL); safe to call on every
    # boot. Mirrors the iter-178 users_db.init_db pattern. Must run
    # BEFORE camera/detection start so the EventBus.publish() write-
    # through has a valid DB to insert into from the very first
    # detection event.
    from .services.events_db import init_db as _events_init_db
    try:
        _events_init_db(settings.events_db_path)
    except Exception:
        log.error(
            "lifespan: init events_db failed at %s (events store "
            "unusable) — aborting boot",
            settings.events_db_path, exc_info=True,
        )
        raise
    from .services.audit_db import init_db as _audit_init_db
    try:
        _audit_init_db(settings.audit_db_path)
    except Exception:
        log.error(
            "lifespan: init audit_db failed at %s (operator audit "
            "trail unusable) — aborting boot",
            settings.audit_db_path, exc_info=True,
        )
        raise
    # iter (S4.5 / blocker B2): retention catch-up. Runs the time-based
    # clip sweep AND the age-independent byte-budget evictor together (in
    # that order) on every boot so a card that filled while the server was
    # down — e.g. an "always present" detection that out-paced the
    # retention window — is reclaimed before the recorder resumes writing.
    # Non-fatal: a sweep/evict failure must NOT abort boot (the camera is
    # the load-bearing service; clips are best-effort storage).
    try:
        from .services.recording_service import sweep_and_evict
        _ret = sweep_and_evict()
        log.info(
            "lifespan: retention catch-up swept=%d evicted=%d freed=%d bytes",
            _ret["swept"], _ret["evicted"], _ret["freed_bytes"],
        )
    except Exception:
        log.warning(
            "lifespan: retention catch-up (sweep+evict) failed — continuing "
            "boot (clips are best-effort storage)", exc_info=True,
        )
    try:
        await camera_service.start()
    except Exception:
        log.error(
            "lifespan: camera_service.start() failed — aborting boot",
            exc_info=True,
        )
        raise
    try:
        await detection_service.start()
    except Exception:
        log.error(
            "lifespan: detection_service.start() failed — aborting boot",
            exc_info=True,
        )
        raise
    log.info(
        "server up; camera=%s detection=%s push_subs=%d",
        camera_service.health(),
        detection_service.active,
        len(push_service.subs),
    )
    try:
        yield
    finally:
        # THE single most important boot/shutdown diagnostic — pairs
        # with the "server up" line so a journal grep shows the full
        # lifecycle (and an UNCLEAN exit = "server up" with no matching
        # "shutting down").
        log.info("server shutting down")
        # Guard EACH stop independently so a crash in detection.stop()
        # can't skip camera.stop() (and leak the camera / libargus
        # socket) — and vice versa.
        try:
            await detection_service.stop()
        except Exception:
            log.error(
                "lifespan: detection_service.stop() failed during "
                "shutdown", exc_info=True,
            )
        try:
            await camera_service.stop()
        except Exception:
            log.error(
                "lifespan: camera_service.stop() failed during shutdown",
                exc_info=True,
            )


app = FastAPI(title="Home Camera System", lifespan=lifespan)

# GZip for clients that opt in via `Accept-Encoding`. Sized to skip
# tiny responses (status pings under ~1 KB add CPU overhead with
# negligible savings) but compresses long event lists (`/api/events`
# returns up to 1000 entries; JSON compresses ~80 %). Browsers always
# send the header; the worker's stdlib `urllib.request` does not, so
# the worker → server hot path stays uncompressed at no cost. Added
# first so the @app.middleware decorators below sit OUTSIDE the gzip
# layer (Starlette's add_middleware uses `insert(0, ...)`, so each
# subsequent registration becomes more outer). Net effect: the
# security-headers middleware adds X-* headers on top of the
# already-gzipped response, which is what we want.
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Body-size guard. Every legitimate request in this app fits in a
# few KB — detection events are ~500 bytes, heartbeats smaller, push
# subscriptions ~500 bytes, config patches tiny. A 1 MB cap is three
# orders of magnitude generous and stops a buggy or malicious worker
# from posting an oversized body that would tie up an asyncio worker
# (and on the Nano, eat into the 1.4 GB MemAvailable headroom).
MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024


def _client_ip(request: Request) -> str:
    """Best-effort client IP for log lines. `request.client` is None
    under some ASGI test transports, so tolerate that."""
    client = request.client
    return client.host if client else "?"


@app.middleware("http")
async def _enforce_max_body_size(request: Request, call_next):
    # iter-194 (iter-169 Minor S2 closure): Transfer-Encoding: chunked
    # bypasses the Content-Length check below — chunked requests don't
    # carry Content-Length, so the iter-75 middleware passed them
    # through unchecked. Reject chunked transfers outright with 411
    # Length Required. Legitimate clients always send Content-Length:
    # browser `fetch()` does so for string/FormData/JSON bodies; the
    # worker's urllib.request does so for any known-size body. The
    # PWA never streams a ReadableStream upload, and the worker's
    # heartbeat/event POSTs are dict→json bytes with known length.
    te = request.headers.get("transfer-encoding", "").lower()
    if "chunked" in te:
        log.warning(
            "body-cap: chunked transfer rejected (411) from %s on %s "
            "(transfer-encoding=%r)",
            _client_ip(request), request.url.path, te,
        )
        return PlainTextResponse(
            "chunked transfer encoding not accepted; send Content-Length",
            status_code=411,
        )
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            n = int(cl)
        except ValueError:
            # Unparseable Content-Length — passes through (treated as
            # missing) but log it: a broken/malicious client lying
            # about its body size is worth a WARN.
            log.warning(
                "body-cap: unparseable Content-Length %r from %s on %s "
                "(passing through)",
                cl, _client_ip(request), request.url.path,
            )
            n = -1
        if n > MAX_REQUEST_BODY_BYTES:
            log.warning(
                "body-cap: oversize body rejected (413) from %s on %s "
                "(content-length=%d > %d)",
                _client_ip(request), request.url.path, n,
                MAX_REQUEST_BODY_BYTES,
            )
            return PlainTextResponse(
                f"request body exceeds {MAX_REQUEST_BODY_BYTES} bytes",
                status_code=413,
            )
    return await call_next(request)


# Defense-in-depth headers for the PWA + API responses. The server
# is LAN-trusted but these are cheap, opt-in restrictions:
#   - `X-Content-Type-Options: nosniff` blocks MIME-type sniffing on
#     served snapshots / static files (can't be coerced to be
#     interpreted as a different content type).
#   - `X-Frame-Options: DENY` prevents the PWA from being embedded in
#     an iframe — a phishing site can't wrap the live feed and skim
#     credentials. (Today there are no creds; this is hygiene.)
#   - `Referrer-Policy: same-origin` keeps `Referer` headers from
#     leaking the PWA's URL structure to any external service the
#     client might reach (icons, push backends, etc).
# CSP is intentionally not set — the PWA inlines a service worker
# bootstrap and would need a tightly-scoped policy to avoid breaking
# WHEP / blob: video. Add later if/when we expose the server beyond
# the LAN.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    # iter-264 (security-auditor D2): the PWA never asks for camera /
    # mic / geolocation / payment / USB / etc. (it watches the Jetson's
    # camera over WHEP, not the device camera). Browser default policy
    # lets the same origin AND nested iframes request all of these;
    # an injected `<script src=…>` to a CDN, or a third-party iframe
    # later added to a help page, could pop the user's local camera
    # consent prompt. Lock everything down. X-Frame-Options: DENY
    # already blocks iframing the PWA, but Permissions-Policy is the
    # modern successor and additionally constrains anything the PWA's
    # own JS could request from a sandboxed origin.
    "Permissions-Policy": (
        "camera=(), microphone=(), geolocation=(), payment=(), "
        "usb=(), accelerometer=(), gyroscope=(), magnetometer=()"
    ),
}


@app.middleware("http")
async def _add_security_headers(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception:
        # An unhandled exception in a route propagates up to here as the
        # OUTERMOST app middleware. Without this catch the 500 is emitted
        # by Starlette's ServerErrorMiddleware but this layer never sees
        # it — and on some transports the traceback can be swallowed.
        # Log it (so no 500 is fully silent) then RE-RAISE unchanged:
        # the response shape, the ServerErrorMiddleware 500, and the
        # security-header tests all depend on this NOT becoming a
        # custom response here. (Do not return — re-raise.)
        log.error(
            "unhandled exception in %s %s — re-raising to 500",
            request.method, request.url.path, exc_info=True,
        )
        raise
    for k, v in _SECURITY_HEADERS.items():
        # setdefault behavior — don't overwrite a route that explicitly
        # set its own header (none today, but future-proof).
        if k not in response.headers:
            response.headers[k] = v
    # iter-264 (security-auditor D1): every /api/auth/* response must
    # carry Cache-Control: no-store. Setting it on the injected
    # `Response` object inside the route body works for the success
    # path but is dropped when FastAPI raises HTTPException (the 401
    # paths build a fresh JSONResponse from scratch). Apply at the
    # middleware tier so EVERY response — 200, 401, 422 — is
    # uncacheable. Login + logout + refresh + me + change_password +
    # admin reset all sit under this prefix.
    if request.url.path.startswith("/api/auth/"):
        response.headers["Cache-Control"] = "no-store"
    # iter-353a (security-auditor D1): face crops are biometric data
    # of household members. Without no-store, browsers (and any shared
    # proxy in a multi-person household) heuristically cache the JPEG
    # responses. A user who logs in on a shared device, loads the
    # /training gallery, then logs out leaves the crops in the disk
    # cache where the next session can read them without auth.
    # iter-356.7 (security D1 redux): widened from `/api/face/captures`
    # to `/api/face/` so /api/face/review_queue is also covered. The
    # review_queue response includes confidence + predicted_name for
    # every uncertain crop — same biometric-disclosure surface as the
    # crop bytes themselves.
    elif request.url.path.startswith("/api/face/"):
        response.headers["Cache-Control"] = "no-store"
    # iter-356.x (security audit D1): snapshots and timelapses are the
    # same data-sensitivity tier as face crops — captured frames of the
    # household. Without Cache-Control: no-store a Tailscale Serve proxy
    # or a shared browser can serve cached media to a session that no
    # longer carries the auth cookie.
    elif request.url.path.startswith("/api/snapshots/") or request.url.path.startswith(
        "/api/timelapses/"
    ):
        response.headers["Cache-Control"] = "no-store"
    return response


# /api/status is polled every 5 s per open tab. A probe failure here
# must NOT log per-poll (that defeats the SD-card-write reduction the
# _SuppressNoisyAccess filter exists for). Once-flag: log the first
# aggregation failure, then stay silent until it recovers (re-arm on
# the next success).
_status_probe_failed = False


@app.get("/api/status")
async def status(_user: str = Depends(get_current_user)) -> dict[str, object]:
    # iter-176: handler is `async def` for FastAPI ergonomics, but every
    # I/O call below is synchronous /sys + /proc reads (microseconds on
    # the Jetson's eMMC). Wrapping in `asyncio.to_thread` would add
    # threadpool context-switch overhead larger than the syscall itself
    # at the 5-s PWA poll cadence. Documented choice; if `_disk_free_gb`
    # ever moves to a slow filesystem (network mount, etc.) reconsider.
    # /proc/meminfo opens once and we destructure — calling _meminfo()
    # twice would parse the same ~50 lines twice on every PWA poll
    # (every 5 s per open tab). Cheap on its own but the PWA poll rate
    # multiplied across users adds up on the Jetson's slow eMMC.
    global _status_probe_failed
    try:
        return _build_status()
    except Exception:
        if not _status_probe_failed:
            _status_probe_failed = True
            log.error(
                "/api/status probe aggregation failed (logged once; "
                "suppressed until it recovers)", exc_info=True,
            )
        raise


def _build_status() -> dict[str, object]:
    global _status_probe_failed
    used_mb, total_mb = _meminfo()
    # iter-176: read worker liveness once, atomically. Pre-iter-176
    # `is_alive()`, `last_seen_s()`, and `metrics()` each read
    # `time.time()` independently — boundary-crossing the
    # `alive_window_s` threshold between calls produced internally
    # inconsistent responses (alive=True with last_seen_s>30, or
    # vice versa).
    worker_alive, worker_last_seen_s, worker_metrics = worker_health.snapshot()
    if _status_probe_failed:
        # Recovered — re-arm the once-flag so a later failure logs again.
        _status_probe_failed = False
        log.info("/api/status probe aggregation recovered")
    return {
        "ok": True,
        "uptime_s": time.time() - START_TIME,
        "camera": camera_service.health(),
        "detection_active": detection_service.active,
        "worker_alive": worker_alive,
        "worker_last_seen_s": worker_last_seen_s,
        "worker_metrics": worker_metrics,
        "cpu_temp_c": _cpu_temp(),
        "gpu_temp_c": _gpu_temp(),
        "cpu_freq_pct": _cpu_freq_pct(),
        "load_avg": _load_avg(),
        "memory_used_mb": used_mb,
        "memory_total_mb": total_mb,
        "disk_free_gb": _disk_free_gb("/"),
        # iter-246: top-level fps mirrors worker_metrics["fps"] when
        # available. Pre-iter-246 this read `camera_service.fps`, a
        # field that's initialised to 0.0 and never updated (the
        # snapshot service has no notion of frame rate — only
        # `latest.jpg` mtime / copy). User saw a permanent FPS=0 in
        # the Settings page despite the worker correctly heartbeating
        # `fps: 19.29`. Falls back to 0.0 when the worker hasn't
        # heartbeat'd yet (the field is not present on the metrics
        # snapshot until the first heartbeat lands).
        "fps": worker_metrics.get("fps", 0.0) if worker_metrics else 0.0,
        # Live count of registered Web Push subscriptions. Lets the
        # Settings UI show "N devices receive notifications" so the user
        # can verify their subscription went through without firing a
        # test push. iter-141 surfaced the count in the post-test toast;
        # this surfaces it ambiently.
        "push_subs_count": len(push_service.subs),
        # iter-302 (user "make sure all issues that broke the live
        # feed will never happen again"): seconds since the worker's
        # most recent successful Capture(). Distinct from
        # `worker_last_seen_s` (heartbeat freshness): the iter-300
        # outage had worker heartbeating fine for 14 hours while
        # the RTSP stream produced no frames. UI flips a "STREAM
        # STALE" pill when this exceeds ~60 s. None when no
        # last_frame_ts has arrived yet (worker booting / never
        # received a frame).
        "seconds_since_last_frame": seconds_since_last_frame(worker_metrics),
        # iter-313 (performance-auditor #3): inline two read-only
        # detection-config fields so the Live page no longer needs
        # a separate /api/detection/config GET on every nav. Pre-
        # iter-313 Live.tsx mounted a useEffect → 1 RTT per nav
        # purely to read these two values; post-iter-313 they ride
        # along with the existing 5 s status poll. Settings page
        # still hits the full /api/detection/config GET for editing.
        "camera_label": detection_config.get().camera_label,
        "audio_enabled": detection_config.get().audio_enabled,
    }


# iter-184 (Auth Plan Phase 5): HARD CUTOVER. Every protected REST
# router gets the auth dep at include-time. control.py + push.py
# are pure REST so router-wide gating is safe. events.py has a WS
# sibling (`/events/ws`) that must NOT be gated this iter (Phase 6 /
# iter-185 gates the WS via cookie inside the handshake), so its
# REST handler `list_events` carries the dep per-route instead.
_PROTECTED_DEPS = [Depends(get_current_user)]
app.include_router(control.router, prefix="/api", dependencies=_PROTECTED_DEPS)
app.include_router(events.router, prefix="/api")
# docs/multicam_contract.md: camera registry for the client. The auth
# gate also lives per-route inside cameras.py (mirrors events.py
# style); the router-wide dep here is belt-and-braces consistency with
# the other pure-REST routers.
app.include_router(cameras.router, prefix="/api", dependencies=_PROTECTED_DEPS)
app.include_router(push.router, prefix="/api", dependencies=_PROTECTED_DEPS)
# iter-201 (Feature #1 slice 1): per-event clip fetch. Auth-gated
# (any authenticated user); per-camera ACLs would land at iter-? if
# Feature #4 notification routing requires them. Until slice 2 ships
# the host-side recorder, every request 404s.
app.include_router(clips.router, prefix="/api", dependencies=_PROTECTED_DEPS)
# iter-351 (face-capture-for-retraining): per-route gating via
# require_role("owner") inside face.py, so no router-wide auth dep
# here. Keeps the route list close to the snapshots/timelapses pattern
# (regex-validated filename, 2-tier path-traversal defense).
settings.face_captures_dir.mkdir(parents=True, exist_ok=True)
# iter-356.62 slice 3 (privacy controls): owner-only purge + consent
# admin endpoints. Per-route gating via require_role("owner") inside
# training_admin.py (mirrors face.py).
#
# Mounted BEFORE `face.router` so the static path
# `/api/face/captures/{name}/consent` resolves to the consent handler
# rather than face.py's catch-all `/face/captures/{name}/{filename}`
# (which would treat "consent" as a filename and 404 via the
# _FILENAME_RE regex check). FastAPI route resolution is order-based.
settings.person_captures_dir.mkdir(parents=True, exist_ok=True)
app.include_router(training_admin.router, prefix="/api")
app.include_router(face.router, prefix="/api")
app.include_router(training.router, prefix="/api")
app.include_router(telemetry.router, prefix="/api")
# `/api/auth/*` gates itself (login is the way IN; me/refresh/logout
# read cookies directly). `/api/_internal/*` is loopback-trusted —
# Charter lock-in, NEVER gate.
app.include_router(auth.router, prefix="/api")
app.include_router(_internal.router, prefix="/api")
# iter-189 (Feature #11): Prometheus /metrics at root, NOT under
# /api/*. Scrapers don't speak browser cookies; operator-side
# fronting controls exposure. Registered BEFORE the SPA catch-all
# below so the route resolves first.
app.include_router(metrics_prom.router)
# iter-195 (iter-169 healthcheck-no-actor closure): /healthz at
# root, NOT under /api/*. Docker / K8s liveness probes don't
# speak browser cookies; iter-184 silently broke the previous
# `/api/status`-based healthcheck by gating /api/*. /healthz is
# unauthenticated by design — same operator-side-fronting tier as
# /metrics. Update `deploy/docker-compose.yml` healthcheck to
# point here.
app.include_router(healthz.router)


# Host-probe dark-detection. Each /sys + /proc probe returns None when
# the file is unreadable. On a Jetson that's usually permanent (probe
# unavailable on this platform) — but a probe that WAS returning a value
# and then transitions to None is a real degradation (a bind-mount
# dropped, a sysfs path moved, the disk filled so statvfs choked). Log
# ONCE on the value→None transition (and once on recovery) so the dark
# probe is visible without per-poll spam at the 5 s /api/status cadence.
# `_disk_free_gb` transitions at WARNING (a dark disk probe hides a
# disk-full that silently breaks the recorder); the rest at DEBUG.
_probe_dark: dict[str, bool] = {}


def _note_probe(name: str, value, warn: bool = False):
    """Log once when `name`'s probe transitions value→None (dark) or
    None→value (recovered). Returns `value` unchanged so callers can
    `return _note_probe('x', val)`."""
    was_dark = _probe_dark.get(name, False)
    is_dark = value is None
    if is_dark and not was_dark:
        _probe_dark[name] = True
        msg = "host probe %s went dark (returning None) — was previously readable"
        if warn:
            log.warning(msg, name)
        else:
            log.debug(msg, name)
    elif not is_dark and was_dark:
        _probe_dark[name] = False
        log.info("host probe %s recovered", name)
    return value


def _cpu_temp() -> float | None:
    for path in (
        "/sys/class/thermal/thermal_zone0/temp",
        "/sys/devices/virtual/thermal/thermal_zone0/temp",
    ):
        try:
            with open(path) as f:
                return _note_probe("cpu_temp", int(f.read().strip()) / 1000.0)
        except OSError:
            continue
    return _note_probe("cpu_temp", None)


def _gpu_temp() -> float | None:
    """GPU thermal zone reading in °C, or None when not available.

    On Tegra (Nano) the GPU has its own SOC thermal zone exposed
    alongside the CPU one; under heavy inference the GPU temp leads
    the thermal-throttle response, so it's a more direct signal than
    the global zone0 reading we already surface as `cpu_temp_c`. We
    look the zone up by `type` rather than a hardcoded index because
    zone numbering varies across kernels and SoCs.
    """
    return _note_probe("gpu_temp", _read_thermal_zone_by_name("GPU-therm"))


_THERMAL_BASE = "/sys/class/thermal"


def _read_thermal_zone_by_name(name: str, base: str = _THERMAL_BASE) -> float | None:
    # Limit scan to zone 0..15 — typical SoCs expose 4-8; capping the
    # loop avoids re-scanning if the kernel exposes more. The `base`
    # parameter exists so unit tests can drop in a tmp_path with a
    # controlled set of fake `thermal_zoneN/{type,temp}` files instead
    # of stubbing builtins.open.
    for i in range(16):
        type_path = f"{base}/thermal_zone{i}/type"
        try:
            with open(type_path) as f:
                if f.read().strip() != name:
                    continue
            with open(f"{base}/thermal_zone{i}/temp") as t:
                return int(t.read().strip()) / 1000.0
        except OSError:
            continue
    return None


_CPUFREQ_BASE = "/sys/devices/system/cpu/cpu0/cpufreq"


def _cpu_freq_pct(base: str = _CPUFREQ_BASE) -> float | None:
    """Throttle ceiling: `scaling_max_freq / cpuinfo_max_freq * 100`.

    100 % = the kernel will let the CPU run at its rated maximum.
    Below 100 % = a thermal trip, a `nvpmodel` cap, or a userspace
    governor has pulled the ceiling down. This is NOT the current
    frequency (which drops to ~5 % at idle under the schedutil/ondemand
    governor regardless of throttle); it's the policy headroom, which
    is what actually correlates with thermal throttling on the Nano.

    Returns None when cpufreq isn't readable (e.g. test runners on
    macOS, or cgroup-restricted containers). The Docker container on
    the Jetson DOES see /sys/devices/system/cpu under the default
    bind mount, so this works in production. The `base` parameter
    exists so unit tests can drop in a tmp_path with controlled
    `scaling_max_freq` / `cpuinfo_max_freq` files."""
    try:
        with open(f"{base}/scaling_max_freq") as f:
            scaled = int(f.read().strip())
        with open(f"{base}/cpuinfo_max_freq") as f:
            mx = int(f.read().strip())
    except (OSError, ValueError):
        return _note_probe("cpu_freq_pct", None)
    if mx <= 0:
        return _note_probe("cpu_freq_pct", None)
    return _note_probe("cpu_freq_pct", round((scaled / mx) * 100.0, 1))


_LOADAVG_PATH = "/proc/loadavg"


def _load_avg(path: str = _LOADAVG_PATH) -> list[float] | None:
    """Linux 1/5/15-min load average. None on platforms without
    /proc/loadavg (e.g. test runners on macOS) or when the file is
    unreadable / malformed.

    The `path` parameter exists so unit tests can drop in a tmp_path
    file rather than stubbing builtins.open."""
    try:
        with open(path) as f:
            parts = f.read().split()
        return _note_probe(
            "load_avg", [float(parts[0]), float(parts[1]), float(parts[2])]
        )
    except (OSError, ValueError, IndexError):
        return _note_probe("load_avg", None)


_MEMINFO_PATH = "/proc/meminfo"


def _meminfo(path: str = _MEMINFO_PATH) -> tuple[int | None, int | None]:
    """(used_mb, total_mb). Used = total - MemAvailable, which matches the
    "used" column most utilities show (excludes reclaimable cache).

    The `path` parameter exists so unit tests can drop in a tmp_path
    file rather than stubbing builtins.open."""
    try:
        info: dict[str, int] = {}
        with open(path) as f:
            for line in f:
                key, _, rest = line.partition(":")
                rest = rest.strip()
                # rest is like "1979128 kB"; strip the unit.
                value_kb = int(rest.split()[0])
                info[key] = value_kb
        total_kb = info.get("MemTotal")
        avail_kb = info.get("MemAvailable")
        if total_kb is None or avail_kb is None:
            _note_probe("meminfo", None)
            return (None, None)
        used_mb = (total_kb - avail_kb) // 1024
        total_mb = total_kb // 1024
        _note_probe("meminfo", total_mb)
        return (used_mb, total_mb)
    except (OSError, ValueError):
        _note_probe("meminfo", None)
        return (None, None)


def _disk_free_gb(path: str) -> float | None:
    """Free space on the filesystem hosting `path`, in GB."""
    try:
        st = os.statvfs(path)
        return _note_probe(
            "disk_free_gb",
            round(st.f_bavail * st.f_frsize / (1024**3), 1),
            warn=True,
        )
    except OSError:
        # WARN on transition-to-dark: a disk probe going dark hides a
        # disk-full condition that silently breaks the recorder.
        return _note_probe("disk_free_gb", None, warn=True)


# --- static mounts (registered after /api so they don't shadow it) ---

# iter-213/iter-187: snapshot directory holds three filename shapes:
#   latest.jpg            — current frame, overwritten by worker
#   snap_<ms>.jpg         — operator-triggered captures from /api/capture
#   thumb_<event_id>.jpg  — per-event thumbnails written by worker
#
# iter-318 (security-auditor D1, same class as iter-317): pre-iter-318
# this was an unauth StaticFiles mount at `/snapshots`. Any LAN device
# could brute-force snap_/thumb_ filenames + download.
#
# Why the new route lives under `/api/snapshots` (NOT just `/snapshots`):
# the iter-184 auth cookies are scoped to `path=/api`. A route at
# `/snapshots/{filename}` would never receive the cookie — every
# legitimate browser request would 401 because the cookie wouldn't
# traverse the path scope. Keeping the cookie scope narrow (also iter-
# 184 sharp edge) is load-bearing for refresh + CSRF posture, so the
# right move is to put the protected route INSIDE `/api/`.
#
# Pre-iter-318 events_db rows have `thumb_url = /snapshots/<file>.jpg`.
# A backwards-compat passthrough at `/snapshots/{filename}` redirects
# (HTTP 308) to the new `/api/snapshots/{filename}` URL, so the
# browser refetches WITH cookies. Old rows continue to display.
settings.snapshots_dir.mkdir(parents=True, exist_ok=True)


_SNAPSHOT_FILENAME_PATTERN = (
    r"^("
    r"latest"
    r"|snap_[0-9]+"
    r"|thumb_[A-Za-z0-9_-]+"
    r")\.jpg$"
)
import re as _re_snap
_SNAPSHOT_FILENAME_RE = _re_snap.compile(_SNAPSHOT_FILENAME_PATTERN)


@app.get("/api/snapshots/{filename}")
async def get_snapshot_file(
    filename: str,
    _user: str = Depends(get_current_user),
):
    """iter-318 (security-auditor D1): auth-gated snapshot file
    server. Replaces the unauth StaticFiles mount. Filename regex
    union covers the three legitimate shapes the worker + capture
    route produce; resolve+relative_to defends against any future
    loosening (matches the iter-212/iter-317 two-tier pattern).

    Returns FileResponse for range-request support (large CSI thumbs
    can be 100+ KB; the browser will range-fetch when relevant).
    """
    if not _SNAPSHOT_FILENAME_RE.match(filename):
        # Regex reject — benign (favicon probes, typos). DEBUG.
        log.debug(
            "snapshot 404: filename %r failed regex (not a valid shape)",
            filename,
        )
        raise HTTPException(status_code=404, detail="not found")
    target = settings.snapshots_dir / filename
    try:
        resolved = target.resolve()
        resolved.relative_to(settings.snapshots_dir.resolve())
    except (ValueError, OSError):
        # Path-traversal / unresolvable — SECURITY-relevant. WARN.
        log.warning(
            "snapshot 404: path-traversal/unresolvable for %r (escaped "
            "snapshots_dir)", filename,
        )
        raise HTTPException(status_code=404, detail="not found")
    if not resolved.is_file():
        # Regex-valid + in-dir but absent on disk — the worker hasn't
        # produced it (or it was swept). DEBUG; thumb-missing is the
        # iter-334 push-hero class so name the file.
        log.debug("snapshot 404: %r missing on disk", filename)
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path=str(resolved), media_type="image/jpeg")


# iter-334 (security-auditor D1 hotfix): thumb_*.jpg files MUST be
# servable WITHOUT auth so push notifications can render their hero
# image. Pre-iter-318 the entire /snapshots/ tree was unauthenticated
# (the security gap iter-318 closed). iter-318 308-redirected
# /snapshots/ → /api/snapshots/ (auth-gated), but the OS push daemon
# (Android Chrome notifications, Firefox push, etc.) cannot carry the
# auth cookie when fetching the notification's `image:` field — the
# redirect lands on 401 → image silently absent on EVERY notification.
# Bug present iter-318..333, surfaced by iter-333's broad security
# audit.
#
# Narrow fix: serve ONLY the thumb_<ts>.jpg pattern unauth (the
# push hero use-case). All other patterns (latest.jpg, snap_*.jpg)
# continue to 308-redirect to the auth-gated endpoint. Worker's
# DetectionPayload.thumb_url regex (`^/snapshots/thumb_[0-9]+\.jpg$`,
# server/app/routes/_internal.py) is the wire-side defense; this
# route just enforces the same regex on the URL path so a malicious
# client can't widen the unauth surface to other files.
_THUMB_FILENAME_RE = _re_snap.compile(r"^thumb_[0-9]+\.jpg$")


@app.get("/snapshots/{filename}")
async def snapshots_unauth_thumb_or_redirect(filename: str):
    """iter-334: hybrid handler.

    - `thumb_<ts>.jpg` files are served DIRECTLY without auth so push
      notifications can render their hero image. The OS push daemon
      can't carry cookies; this is the smallest carve-out that keeps
      the iter-188 push-image feature working.
    - Other matching patterns (latest.jpg, snap_*.jpg) → 308 redirect
      to /api/snapshots/ so the browser refetches WITH cookies.
    - Non-matching → 404, identical to the auth-gated route's
      response so this endpoint can't be used to enumerate which
      files exist on disk.
    """
    from fastapi.responses import RedirectResponse

    if not _SNAPSHOT_FILENAME_RE.match(filename):
        log.debug(
            "/snapshots 404: filename %r failed regex (not a valid shape)",
            filename,
        )
        raise HTTPException(status_code=404, detail="not found")

    # Push-image carve-out: thumb_*.jpg only.
    if _THUMB_FILENAME_RE.match(filename):
        target = settings.snapshots_dir / filename
        try:
            resolved = target.resolve()
            resolved.relative_to(settings.snapshots_dir.resolve())
        except (ValueError, OSError):
            log.warning(
                "/snapshots thumb 404: path-traversal/unresolvable for %r",
                filename,
            )
            raise HTTPException(status_code=404, detail="not found")
        if not resolved.is_file():
            # iter-334 push-hero class: a notification's image: field
            # points here and the thumb isn't on disk → silent missing
            # hero image. WARN so a regression is visible.
            log.warning(
                "/snapshots thumb 404: %r missing on disk (push hero image "
                "will be absent)", filename,
            )
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(path=str(resolved), media_type="image/jpeg")

    # Other valid patterns → redirect to auth-gated route.
    return RedirectResponse(
        url=f"/api/snapshots/{filename}",
        status_code=308,
    )

# iter-213 (Feature #8 slice 1): timelapse MP4 files live in
# settings.timelapses_dir. Filenames are strict `<YYYY-MM-DD>.mp4`.
# iter-317 (security-auditor D1): MOVED OFF the public /timelapses
# StaticFiles mount onto an auth-gated route below. Pre-iter-317 any
# device on the same Wi-Fi could `curl http://jetson:8000/timelapses/
# 2026-04-30.mp4` and download the day's events MP4 with no cookie.
# The new route requires the iter-184 auth cookie + path-traversal
# defense (regex date filter + resolve+relative_to). The dir still
# needs to exist on startup because the iter-306 builder writes MP4s
# here.
settings.timelapses_dir.mkdir(parents=True, exist_ok=True)


@app.get("/api/timelapses/{filename}")
async def get_timelapse_file(
    filename: str,
    _user: str = Depends(get_current_user),
):
    """iter-317 (security-auditor D1): auth-gated replacement for the
    pre-iter-317 `/timelapses` StaticFiles mount. Returns the MP4 via
    FileResponse, which supports HTTP range requests so the inline
    `<video>` element in the iter-304 TimelapsesSection can stream
    the file efficiently.

    Also serves the sibling `<YYYY-MM-DD>.json` timestamp sidecar (the
    de-overlap builder writes it next to the reel) so the client overlay
    can map reel-offset → capture time. Same auth + traversal defense.

    Filename validation: `<YYYY-MM-DD>.mp4` or `<YYYY-MM-DD>.json`, strict.
    Regex AND `Path.resolve().relative_to(timelapses_dir.resolve())` (the
    iter-212 two-tier defense pattern) to refuse any traversal even if a
    future iter loosens the regex.
    """
    import re as _re
    from fastapi.responses import FileResponse
    if not _re.fullmatch(
        r"^[0-9]{4}-[01][0-9]-[0-3][0-9]\.(mp4|json)$", filename
    ):
        log.debug(
            "timelapse 404: filename %r failed date regex", filename,
        )
        raise HTTPException(status_code=404, detail="not found")
    target = settings.timelapses_dir / filename
    try:
        resolved = target.resolve()
        resolved.relative_to(settings.timelapses_dir.resolve())
    except (ValueError, OSError):
        log.warning(
            "timelapse 404: path-traversal/unresolvable for %r", filename,
        )
        raise HTTPException(status_code=404, detail="not found")
    if not resolved.is_file():
        # Regex-valid date + in-dir but no file. For the MP4 this is an
        # operator-visible gap (WARN); for the optional JSON sidecar a miss
        # is benign (older reels have none — DEBUG, client degrades to no
        # overlay).
        if filename.endswith(".json"):
            log.debug("timelapse sidecar 404: %r not on disk", filename)
        else:
            log.warning(
                "timelapse 404: %r missing on disk (builder produced no MP4 "
                "for that day)", filename,
            )
        raise HTTPException(status_code=404, detail="not found")
    media_type = "application/json" if filename.endswith(".json") else "video/mp4"
    return FileResponse(
        path=str(resolved),
        media_type=media_type,
        filename=filename,
    )

if settings.client_dist.exists():
    assets_dir = settings.client_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    _CLIENT_ROOT = settings.client_dist.resolve()
    _INDEX = _CLIENT_ROOT / "index.html"

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        if full_path:
            try:
                target = (_CLIENT_ROOT / full_path).resolve()
                target.relative_to(_CLIENT_ROOT)
            except (ValueError, OSError):
                # Path traversal attempt or unresolvable path —
                # SECURITY-relevant (the SPA path-traversal guard). WARN
                # then fall through to index (response shape unchanged).
                log.warning(
                    "SPA path-traversal/unresolvable for %r — serving index",
                    full_path,
                )
                return FileResponse(_INDEX)
            if target.is_file():
                return FileResponse(target)
            # A non-asset path (client-side route) — normal SPA deep-link
            # fall-through to index. DEBUG only; this is the common case.
            log.debug(
                "SPA fall-through to index for %r (no file on disk)",
                full_path,
            )
        return FileResponse(_INDEX)
else:
    # SPA bundle not mounted: client_dist doesn't exist. Every non-API
    # GET will 404 (no catch-all route is registered). WARN at import
    # time so an operator who deployed the server without rsync-ing the
    # client build sees WHY the UI 404s — the server itself booted clean.
    log.warning(
        "SPA bundle not mounted: client_dist %s does not exist — the "
        "UI will 404 (deploy the client build via the rsync step in "
        "CLAUDE.md)", settings.client_dist,
    )
