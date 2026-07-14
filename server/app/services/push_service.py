from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time as _time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from ..config import settings
from ..log import RateLimitedLog

log = logging.getLogger(__name__)

# Rate-limit the "no VAPID key, skipping push" line: it fires on every
# detection event when keys aren't loaded. INFO (so it's visible at the
# default level) but gated to once/5min so a busy day doesn't flood.
_no_key_skip_gate = RateLimitedLog(300.0)

# Security-camera events should survive brief phone/network offline windows.
_PUSH_TTL_S = 3600


def _endpoint_host(endpoint: object) -> str:
    """Extract just the HOST of a push endpoint for logging.

    PRIVACY/SECURITY (logging-plan §4): a push endpoint URL carries a
    per-device secret token in its PATH (e.g.
    ``https://fcm.googleapis.com/fcm/send/<SECRET>``). NEVER log the
    full endpoint. The host alone (``fcm.googleapis.com``,
    ``updates.push.services.mozilla.com``) is enough to tell which push
    gateway is failing without leaking the device secret.
    """
    try:
        host = urlparse(str(endpoint)).netloc
    except (ValueError, TypeError):
        return "?"
    return host or "?"


# Field length caps for persisted subscriptions. Mirrored on the
# route layer (`routes/push.py`) where iter-98 added `Field(max_length=...)`.
# Duplicating the bounds here lets `_load_subs` scrub legacy disk rows
# that pre-date iter-98 — without this, an oversized endpoint persisted
# under the old route schema would stay in `push_subs.json` forever.
# Routes can't import service to share a constant (would be a cycle);
# service can't import route at module top either. Inlining the bounds
# is the cheapest fix.
_LOAD_ENDPOINT_MAX = 2048
_LOAD_P256DH_MAX = 200
_LOAD_AUTH_MAX = 100


def _is_valid_loaded_sub(sub: object) -> bool:
    """Shape + length check for a sub read off disk. Drops anything
    that would be 422-rejected by the route's `Subscription` model.

    iter-205 (Feature #4 slice 1): tolerates the new optional
    `user_id` (str) and `filters` (dict-of-lists) fields. Legacy
    pre-iter-205 subs lack both; defaults are filled by
    `_normalize_loaded_sub` after this validator passes."""
    if not isinstance(sub, dict):
        return False
    endpoint = sub.get("endpoint")
    if not isinstance(endpoint, str) or not endpoint or len(endpoint) > _LOAD_ENDPOINT_MAX:
        return False
    keys = sub.get("keys")
    if not isinstance(keys, dict):
        return False
    p = keys.get("p256dh")
    a = keys.get("auth")
    if not isinstance(p, str) or not p or len(p) > _LOAD_P256DH_MAX:
        return False
    if not isinstance(a, str) or not a or len(a) > _LOAD_AUTH_MAX:
        return False
    # iter-205: when present, user_id must be a non-empty string;
    # filters must be a dict (further field-level validation in
    # `_normalize_loaded_sub`). Tolerant: bad values get wiped to
    # defaults rather than failing the whole sub — operator's
    # editing mistake shouldn't drop their endpoint.
    user_id = sub.get("user_id")
    if user_id is not None and not (isinstance(user_id, str) and user_id):
        return False
    filters = sub.get("filters")
    if filters is not None and not isinstance(filters, dict):
        return False
    return True


# iter-209 (Feature #4 slice 4): HH:MM regex for schedule_window
# disk-load normalization. Mirrors the route's `_HHMM_PATTERN` and
# `services/detection_config.py::HHMM_PATTERN` — the SAME wire
# pattern across all three call sites; see CLAUDE.md "wire-boundary
# alignment" rule.
_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _event_in_schedule_window(window: dict | None, ts: float) -> bool:
    """iter-209: True when the event timestamp falls inside the
    [start, end) HH:MM-HH:MM window (server local time). Wraps
    across midnight when start > end (e.g. 22:00→07:00 covers
    22-24 + 0-7). Returns True when the window is missing/invalid
    so a malformed sub.filters.schedule_window doesn't silently
    suppress all push delivery — fail open, not closed.

    Symmetric with `services/detection_config.py::in_schedule_off_window`
    but takes a timestamp + dict-shape window (rather than two HH:MM
    strings + hour/minute ints) so it can be called once per event
    on every matching sub without re-parsing.
    """
    if not isinstance(window, dict):
        return True
    start = window.get("start")
    end = window.get("end")
    if not isinstance(start, str) or not isinstance(end, str):
        return True
    if not _HHMM_RE.match(start) or not _HHMM_RE.match(end):
        return True
    sh, sm = (int(p) for p in start.split(":"))
    eh, em = (int(p) for p in end.split(":"))
    s_min = sh * 60 + sm
    e_min = eh * 60 + em
    if s_min == e_min:
        # Zero-length window — don't gate (matches detection's
        # "no schedule" semantics; documented on the route model).
        return True
    lt = _time.localtime(ts)
    cur = lt.tm_hour * 60 + lt.tm_min
    if s_min < e_min:
        return s_min <= cur < e_min
    # Wraparound (e.g. 22:00 → 07:00).
    return cur >= s_min or cur < e_min


def _sub_matches_event(sub: dict, event: dict) -> bool:
    """Per-sub filter check for `send_matching` (iter-206, Feature #4
    slice 2). Returns True when this subscription should receive a
    push for this event.

    Semantics:
    - ``filters is None`` → match all events (legacy + iter-205
      default; preserves "every sub gets every push").
    - ``filters.cameras is None`` → match any camera. Empty list
      ``[]`` → match no event in that field.
    - ``filters.person_names is None`` → match any (or no) person.
      Empty list ``[]`` → match nothing. A list with names → event
      ``person_name`` must be in the list (None person_name on
      event won't match a non-empty list).
    - ``filters.schedule_window is None`` → no time-of-day gating
      (iter-209). When set, event timestamp's local clock must fall
      inside [start, end). See `_event_in_schedule_window`.

    All filter fields AND together — a sub with cameras=["cam1"]
    and person_names=["alice"] only fires on cam1 events that
    matched alice's face.
    """
    filters = sub.get("filters")
    if filters is None:
        return True
    cameras = filters.get("cameras")
    if cameras is not None:
        if event.get("camera_id") not in cameras:
            return False
    person_names = filters.get("person_names")
    if person_names is not None:
        if event.get("person_name") not in person_names:
            return False
    # iter-209: schedule_window AND-combined with the other fields.
    # Window uses event["ts"] (unix epoch seconds, server local
    # interpretation). Missing ts on event is unexpected (the bus
    # always stamps it) — fall back to "now" so we don't silently
    # drop a push because the event lacked a timestamp.
    schedule = filters.get("schedule_window")
    if schedule is not None:
        ts = event.get("ts")
        if not isinstance(ts, (int, float)):
            ts = _time.time()
        if not _event_in_schedule_window(schedule, ts):
            return False
    return True


def _normalize_loaded_sub(sub: dict) -> dict:
    """iter-205: ensure every sub has the iter-205 keys. Legacy
    subs (no user_id / no filters) get None defaults. In-place
    mutation; called after `_is_valid_loaded_sub` accepts the row."""
    sub.setdefault("user_id", None)
    sub.setdefault("filters", None)
    # If filters dict is present but malformed (e.g. legacy operator
    # editing), drop offending list entries silently. Slice 2's
    # `send_matching` will see well-formed lists or None.
    f = sub.get("filters")
    if isinstance(f, dict):
        for key in ("cameras", "person_names"):
            v = f.get(key)
            if v is None:
                continue
            if not isinstance(v, list):
                f[key] = None
                continue
            f[key] = [
                s for s in v
                if isinstance(s, str) and s and len(s) <= 64
            ][:16]
        # iter-209 (slice 4): schedule_window is {start: HH:MM, end:
        # HH:MM} or None. Drop malformed (wrong shape, bad regex) to
        # None rather than failing the whole sub — symmetric with the
        # cameras/person_names disk-load tolerance above.
        sw = f.get("schedule_window")
        if sw is not None:
            if (
                isinstance(sw, dict)
                and isinstance(sw.get("start"), str)
                and isinstance(sw.get("end"), str)
                and _HHMM_RE.match(sw["start"])
                and _HHMM_RE.match(sw["end"])
            ):
                f["schedule_window"] = {"start": sw["start"], "end": sw["end"]}
            else:
                f["schedule_window"] = None
        else:
            f.setdefault("schedule_window", None)
    return sub


class PushService:
    """Web Push delivery via VAPID + pywebpush.

    Subscriptions persist to a JSON file under the `homecam-secrets` Docker
    volume (`settings.push_subs_path`). Reloaded at startup; saved on
    add / remove / dead-sub-prune. Without this every container restart
    forgot every phone — users had to re-tap "Send test" to re-subscribe.
    """

    def __init__(self, persist_path: Path | None = None) -> None:
        self.persist_path = persist_path if persist_path is not None else settings.push_subs_path
        self.subs: list[dict[str, Any]] = []
        self.private_pem: bytes | None = None
        self.public_key_b64: str | None = None
        # iter-244e: pre-built Vapid object. pywebpush 2.3.0+ rejects
        # raw PEM strings for PKCS8 EC P-256 keys (the format
        # `gen_vapid` writes) with "ASN.1 parsing error: invalid
        # length", silently turning every `webpush()` call into a
        # ValueError. Constructing a `Vapid` instance ahead of time
        # and passing THAT to `vapid_private_key=` works. Stored as
        # an instance field so `load_keys` builds it once at startup
        # and `send_one` reuses it per fanout. Production-only:
        # `test_push_service.py` sets `private_pem = b"fake-pem"`
        # AND mocks `pywebpush.webpush`, so the fallback below
        # (passing `private_pem.decode()` when `_vapid_obj is None`)
        # keeps existing tests green without forcing every test to
        # also stub out the Vapid object.
        self._vapid_obj: Vapid | None = None
        self._load_subs()

    # --- persistence -----------------------------------------------------

    def _load_subs(self) -> None:
        if not self.persist_path.exists():
            return
        try:
            data = json.loads(self.persist_path.read_text())
            if isinstance(data, list):
                kept: list[dict[str, Any]] = [
                    _normalize_loaded_sub(s)
                    for s in data
                    if _is_valid_loaded_sub(s)
                ]
                dropped = len(data) - len(kept)
                if dropped:
                    log.warning(
                        "dropped %d malformed push subscription(s) on load from %s",
                        dropped, self.persist_path,
                    )
                self.subs = kept
                log.info("loaded %d push subscription(s) from %s", len(self.subs), self.persist_path)
            else:
                log.warning("push subs file %s is not a list; ignoring", self.persist_path)
        except (OSError, json.JSONDecodeError) as e:
            log.warning("failed to load push subs from %s: %s", self.persist_path, e)
            self.subs = []
            # On a JSON parse failure preserve the corrupt file as
            # `<path>.corrupt` BEFORE the next `_save_subs` overwrites
            # it with `[]` — otherwise a single bad write silently
            # destroys every device subscription with no forensic copy.
            # OSError (file vanished / unreadable) has nothing to
            # preserve, so only rename on a JSON decode failure.
            if isinstance(e, json.JSONDecodeError):
                corrupt = self.persist_path.with_suffix(
                    self.persist_path.suffix + ".corrupt"
                )
                try:
                    os.replace(str(self.persist_path), str(corrupt))
                    log.warning(
                        "preserved corrupt push subs as %s for forensics",
                        corrupt,
                    )
                except OSError as re_err:
                    log.warning(
                        "could not preserve corrupt push subs %s: %s",
                        self.persist_path,
                        re_err,
                    )

    def _save_subs(self) -> None:
        # iter-264 (security-auditor C2): pre-create the temp file
        # with mode 0o600 via os.open(..., O_CREAT, 0o600) so the
        # final path inherits the restrictive bits via os.replace.
        # Pre-iter-264 the sequence was tmp.write_text (umask 0o022 →
        # 0o644) → os.replace → chmod 0o600 — small but real window
        # where push_subs.json with every device endpoint is world-
        # readable. Mirrors iter-178 jwt_secret._generate_and_write.
        try:
            self.persist_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.persist_path.with_suffix(self.persist_path.suffix + ".tmp")
            payload = json.dumps(self.subs).encode("utf-8")
            fd = os.open(
                str(tmp),
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o600,
            )
            try:
                os.write(fd, payload)
            finally:
                os.close(fd)
            os.replace(tmp, self.persist_path)
        except OSError as e:
            log.warning("failed to save push subs to %s: %s", self.persist_path, e)
            # The `.tmp` may be half-written and left behind on a failed
            # write/replace — clean it up so it doesn't accumulate.
            try:
                tmp = self.persist_path.with_suffix(self.persist_path.suffix + ".tmp")
                if tmp.exists():
                    tmp.unlink()
            except OSError as cleanup_err:
                log.debug(
                    "could not clean up push subs temp %s: %s",
                    tmp,
                    cleanup_err,
                )

    # --- VAPID -----------------------------------------------------------

    def load_keys(self) -> None:
        # iter-170: tolerant load. Pre-iter-170 a corrupt or partially-
        # written VAPID PEM (e.g., volume race on first container boot,
        # or operator regenerated keys mid-run via `gen_vapid`) raised
        # `ValueError` / `UnsupportedAlgorithm` from `_read_public_key_b64`,
        # propagated through this method, and crashed the FastAPI module
        # import chain — the app never started, no `/api/status`, no SPA.
        # Now: missing files warn (existing path), unreadable bytes warn
        # and degrade to push-disabled, unparseable PEM warn and degrade.
        # Symmetric with the iter-99 `_safe_float` and iter-109
        # `_is_valid_loaded_sub` patterns: persisted-state errors should
        # never break startup. Push routes already gracefully no-op when
        # `private_pem is None` (see `send_all` line 153).
        priv = settings.vapid_private_key_path
        pub = settings.vapid_public_key_path
        if not (priv.exists() and pub.exists()):
            log.warning(
                "VAPID keys not found at %s / %s — run `python -m app.scripts.gen_vapid`",
                priv,
                pub,
            )
            return
        try:
            self.private_pem = priv.read_bytes()
            self.public_key_b64 = self._read_public_key_b64(pub)
            # iter-244e: build the Vapid object once. Vapid.from_pem
            # raises ValueError on malformed PEM, caught by the same
            # except below.
            self._vapid_obj = Vapid.from_pem(self.private_pem)
        except (OSError, ValueError, TypeError) as e:
            # `serialization.load_pem_public_key` raises `ValueError` on
            # malformed PEM and `UnsupportedAlgorithm` (a `ValueError`
            # subclass in `cryptography`) on the wrong key type. `OSError`
            # covers `read_bytes` failures (permission flip, mid-rotation
            # half-written file). Reset both fields so a partial load
            # doesn't half-enable push delivery.
            self.private_pem = None
            self.public_key_b64 = None
            self._vapid_obj = None
            log.warning(
                "VAPID keys at %s / %s could not be loaded (%s: %s) — "
                "push will be disabled until keys are valid",
                priv,
                pub,
                type(e).__name__,
                e,
            )
            return
        log.info("VAPID keys loaded")

    def _read_public_key_b64(self, path: Path) -> str:
        pem = path.read_bytes()
        pub_key = serialization.load_pem_public_key(pem)
        raw = pub_key.public_bytes(
            encoding=serialization.Encoding.X962,
            format=serialization.PublicFormat.UncompressedPoint,
        )
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    def add(self, sub: dict[str, Any]) -> None:
        if any(s["endpoint"] == sub["endpoint"] for s in self.subs):
            return
        self.subs.append(sub)
        self._save_subs()

    def remove(self, endpoint: str) -> bool:
        before = len(self.subs)
        self.subs = [s for s in self.subs if s["endpoint"] != endpoint]
        if len(self.subs) != before:
            self._save_subs()
            return True
        return False

    def get_user_filters(self, user_id: str) -> dict | None:
        """iter-207 (Feature #4 slice 3a): return the filters dict
        for the given user. All of a user's subs share filters
        (per-user, not per-device — see route doc), so we look up
        the first matching sub. Returns None when the user has no
        subs OR when their subs all have filters=None (legacy /
        unfiltered)."""
        for s in self.subs:
            if s.get("user_id") == user_id:
                return s.get("filters")
        return None

    def update_user_filters(self, user_id: str, filters: dict | None) -> int:
        """iter-207 (Feature #4 slice 3a): set the filters dict on
        every subscription owned by `user_id`. Returns the count of
        subs updated. Setting `filters=None` resets the user to
        "match all" (legacy behavior). Operator-side: a future iter
        could add per-device filters; for now per-user is the right
        granularity for a household deployment.

        Persists if any rows changed.
        """
        updated = 0
        for s in self.subs:
            if s.get("user_id") == user_id:
                s["filters"] = filters
                updated += 1
        if updated:
            self._save_subs()
        return updated

    async def _fanout_to(
        self,
        subs: list[dict[str, Any]],
        payload: dict[str, Any],
        *,
        persist_prunes: bool = True,
    ) -> int:
        """Common send mechanics shared by send_all and send_matching
        (iter-206 refactor). Sends `payload` to each sub in `subs`,
        prunes 404/410 dead subs from `self.subs`, returns the count
        successfully delivered. Transient errors (ConnectionError,
        SSL, etc.) leave subs in the registry."""
        if self.private_pem is None:
            # `load_keys()` already warned once on startup if keys were
            # missing — but a DEBUG line here is invisible at the INFO
            # default, so "push silently does nothing" looks healthy.
            # INFO, rate-limited to once/5min so a busy day doesn't
            # flood while still surfacing the misconfig.
            if _no_key_skip_gate.should_log():
                log.info(
                    "no VAPID key loaded; skipping push to %d subscriber(s) "
                    "(run `python -m app.scripts.gen_vapid`)",
                    len(subs),
                )
            return 0
        if not subs:
            return 0
        body = json.dumps(payload)
        importance = str(payload.get("importance") or "normal")
        urgency = {
            "critical": "high",
            "high": "high",
            "urgent": "high",
            "notable": "normal",
            "normal": "normal",
            "routine": "low",
            "low": "low",
        }.get(importance, "normal")
        # iter-244e: prefer the pre-built Vapid object when available
        # (production path, set by load_keys). Fall back to the raw
        # PEM string for tests that monkeypatch `private_pem` without
        # going through load_keys; pywebpush is mocked in those
        # tests, so the string-vs-Vapid distinction doesn't matter
        # there.
        vapid_key: Vapid | str = (
            self._vapid_obj
            if self._vapid_obj is not None
            else self.private_pem.decode()
        )

        # Track which transient-exception types we saw so we can
        # escalate ONCE when EVERY sub failed the same way (see below).
        transient_exc_types: list[str] = []

        def send_one(sub: dict[str, Any]) -> tuple[bool, int | None, str | None]:
            # Host-only — NEVER the full endpoint (carries device secret).
            host = _endpoint_host(sub.get("endpoint"))
            try:
                webpush(
                    subscription_info=sub,
                    data=body,
                    vapid_private_key=vapid_key,
                    vapid_claims={"sub": settings.vapid_subject},
                    ttl=_PUSH_TTL_S,
                    headers={"Urgency": urgency},
                )
                return True, None, None
            except WebPushException as e:
                code = e.response.status_code if e.response is not None else None
                # Classify the gateway response so the operator knows
                # whether this is "device went away" (prune, benign) vs
                # "our VAPID auth is wrong" (every push will fail until
                # fixed) vs "we're being rate-limited".
                if code in (404, 410):
                    log.info(
                        "push to %s: %s — subscription gone, will prune",
                        host,
                        code,
                    )
                elif code in (401, 403):
                    # VAPID misconfig is NOT per-device — it dooms every
                    # push. WARN loudly so it's not mistaken for a dead
                    # sub. (str(e) is the gateway's message, no secret.)
                    log.warning(
                        "push to %s: %s — VAPID auth rejected "
                        "(misconfigured keys / subject?); push will keep "
                        "failing until fixed: %s",
                        host,
                        code,
                        str(e)[:200],
                    )
                elif code == 429:
                    log.warning(
                        "push to %s: 429 — rate-limited by gateway: %s",
                        host,
                        str(e)[:200],
                    )
                else:
                    log.warning("push to %s: %s: %s", host, code, str(e)[:200])
                return False, code, None
            except Exception as e:
                # iter-165: any non-WebPushException (ConnectionError,
                # ssl.SSLError, OSError, a buggy pywebpush release raising
                # a TypeError, etc.) used to escape `send_one`, propagate
                # through the `asyncio.gather` below, and surface as
                # HTTP 500 on `POST /api/push/test` — violating the
                # documented `{"ok": True, "sent": N}` contract that
                # the client toast (iter-141) consumes. Catch here, log
                # with the exception type + endpoint host so a class of
                # failure is diagnosable, count as not-sent. Returning
                # code=None (not 404/410) means the sub stays in the
                # registry — transient errors must NOT prune
                # subscriptions, only explicit 404/410 should.
                exc_type = type(e).__name__
                log.warning(
                    "push to %s transient error (%s): %s",
                    host,
                    exc_type,
                    str(e)[:200],
                )
                return False, None, exc_type

        results = await asyncio.gather(
            *(asyncio.to_thread(send_one, s) for s in subs)
        )
        sent = 0
        dead: list[dict[str, Any]] = []
        for sub, (ok, code, exc_type) in zip(subs, results):
            if ok:
                sent += 1
            elif code in (404, 410):
                dead.append(sub)
            elif exc_type is not None:
                transient_exc_types.append(exc_type)
        # Escalate-once: a regression that looks "transient" forever —
        # e.g. a malformed PEM making every webpush raise the SAME
        # exception type — is otherwise indistinguishable from real
        # network blips. If we sent NOTHING and EVERY sub failed with
        # the SAME transient exc type, log an ERROR naming it so the
        # operator sees "this is systemic, not a blip".
        if (
            sent == 0
            and not dead
            and len(transient_exc_types) == len(subs)
            and len(subs) > 0
            and len(set(transient_exc_types)) == 1
        ):
            log.error(
                "push: ALL %d deliveries failed with the same transient "
                "error (%s) — this looks systemic (e.g. a VAPID/PEM "
                "regression), not a transient network blip",
                len(subs),
                transient_exc_types[0],
            )
        if dead and persist_prunes:
            for d in dead:
                # Mutating self.subs (not the local `subs` list) is
                # intentional — `dead` are real subscriptions to prune
                # from the registry regardless of which call surface
                # discovered them.
                if d in self.subs:
                    self.subs.remove(d)
            # Dead-sub prune AUDIT: subscriptions otherwise vanish with
            # no trace. INFO with the count + hosts so an operator can
            # explain "why did my phone stop getting notifications".
            log.info(
                "push: pruned %d dead subscription(s): %s",
                len(dead),
                ", ".join(_endpoint_host(d.get("endpoint")) for d in dead),
            )
            self._save_subs()
        elif dead:
            # The independent operational-alert receiver mounts the shared
            # subscription registry read-only. It must never race the primary
            # server's add/remove writes; the primary process will perform any
            # durable dead-endpoint cleanup on its next normal fanout.
            log.info(
                "push: observed %d dead subscription(s) from read-only sender",
                len(dead),
            )
        return sent

    async def send_all(self, payload: dict[str, Any]) -> int:
        """Fan out `payload` to every subscription. Used by the test-
        push button (`/api/push/test`). For event-driven push, use
        `send_matching` so per-user filters apply."""
        return await self._fanout_to(self.subs, payload)

    async def send_all_readonly(self, payload: dict[str, Any]) -> int:
        """Fan out without mutating the shared subscription registry.

        Used by the PR-206 receiver, which runs outside the FastAPI container
        so server restarts cannot suppress operational alerts.
        """
        return await self._fanout_to(
            list(self.subs),
            payload,
            persist_prunes=False,
        )

    async def send_matching(
        self,
        event: dict[str, Any],
        payload: dict[str, Any],
    ) -> int:
        """iter-206 (Feature #4 slice 2): fan out only to subs whose
        filters match `event`. Legacy subs (`filters=None`) match
        all events — preserves pre-iter-205 behavior. Subs with
        `filters` evaluate per-field (cameras AND person_names);
        empty list `[]` matches nothing in that field, distinct
        from `null` (match all)."""
        total = len(self.subs)
        matching = [
            s for s in self.subs if _sub_matches_event(s, event)
        ]
        sent = await self._fanout_to(matching, payload)
        pruned = max(0, total - len(self.subs))
        filtered = total - len(matching)
        failed = max(0, len(matching) - sent - pruned)
        log.info(
            "push fanout event=%s sent=%s filtered=%s failed=%s pruned=%s",
            event.get("id", "?"),
            sent,
            filtered,
            failed,
            pruned,
        )
        return sent

    async def send_to_user(self, user_id: str, payload: dict[str, Any]) -> int:
        """Fan out `payload` to every subscription owned by `user_id` (the
        username stamped at subscribe time, `routes/push.py`). Used for
        USER-DIRECTED notifications — e.g. "your timelapse is ready" to the
        person who requested the build — rather than the event broadcasts of
        `send_matching`/`send_all`. Bypasses per-event filters (this isn't a
        detection event). Returns the count delivered; 0 when the user has no
        registered devices (they still get the in-app poll result)."""
        if not user_id:
            return 0
        owned = [s for s in self.subs if s.get("user_id") == user_id]
        return await self._fanout_to(owned, payload)


push_service = PushService()
push_service.load_keys()
