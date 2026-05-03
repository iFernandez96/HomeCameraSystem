from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, Literal, TypedDict

log = logging.getLogger(__name__)


class BoxDict(TypedDict):
    """Detection bounding box. Coordinates are normalized [0..1] relative to
    the source frame so the client can render at any video size."""

    x: float
    y: float
    w: float
    h: float
    label: str
    score: float


class DetectionEventDict(TypedDict):
    """Wire shape for detection events on the WebSocket and in /api/events.

    Mirrors `client/src/lib/types.ts::DetectionEvent`. When you change one,
    update the other and the lib tests in `client/src/lib/api.test.ts`.
    """

    v: Literal[1]
    type: Literal["detection"]
    id: str
    ts: float
    camera_id: str
    label: str
    score: float
    boxes: list[BoxDict]
    thumb_url: str | None
    person_name: str | None
    # iter-204 (Feature #1 slice 4): URL of the per-event MP4 clip
    # (iter-201 storage + iter-202 host-side recorder). Null when
    # the recorder isn't deployed yet OR the event_id wasn't picked
    # for clipping (e.g. cap reached, ffmpeg missing). The client
    # `<ClipModal>` (iter-203) hard-codes the URL today; this field
    # lets the worker preemptively signal "clip exists / will exist"
    # so a future iter can skip the video-error fallback path on
    # events known to lack clips. iter-204 ships the schema with
    # null-default; the worker emit path (iter-205?) sets the value
    # once the recorder confirms file presence.
    clip_url: str | None


# Anything that flows over the bus / out the WebSocket. Today only
# DetectionEventDict — leave the alias in place so future event types
# (status snapshots, heartbeat broadcasts) just become a Union.
ServerEvent = DetectionEventDict


class SubscriberCapReached(Exception):
    """Raised by EventBus.subscribe when the per-bus subscriber cap
    (iter-263) is hit. The WS handler in routes/events.py catches
    this and closes the handshake with code 1013 (Try Again Later)
    so the iter-158 client reconnect logic backs off cleanly."""


class EventBus:
    """Live pub/sub for detection events.

    A single process holds N WebSocket subscribers, each with its own
    asyncio.Queue. Persistent history lives in SQLite via `events_db`
    (iter-216 schema, iter-217 write-through, iter-218 reads). The
    bus itself is now stateless beyond the live subscriber list — no
    in-memory history deque.
    """

    # iter-263 (security-auditor F1): cap on simultaneous WS
    # subscribers. An authed family/viewer could otherwise open
    # hundreds of WS connections, each allocating a 64-event buffer,
    # and OOM-loop the server past the iter-167 512 MB cap. 32 is
    # generous for a 2-user household with multiple devices but
    # keeps memory bounded.
    MAX_SUBSCRIBERS = 32

    def __init__(self) -> None:
        self._subs: list[asyncio.Queue[ServerEvent]] = []
        # Throttle "subscriber queue full" warnings so a chronically
        # stalled WebSocket doesn't flood the journal — every backed-up
        # publish would fire one without this. We log on first overflow
        # then suppress until a successful put resets the flag.
        self._sub_overflow_warned: dict[int, bool] = {}

    def subscribe(self) -> asyncio.Queue[ServerEvent]:
        # iter-263: hard cap to defend against authed-DoS. Caller
        # MUST handle SubscriberCapReached and close the WS with
        # code 1013 (Try Again Later) — see events.py:events_ws.
        if len(self._subs) >= self.MAX_SUBSCRIBERS:
            raise SubscriberCapReached(
                f"event bus at capacity ({len(self._subs)}/{self.MAX_SUBSCRIBERS})"
            )
        q: asyncio.Queue[ServerEvent] = asyncio.Queue(maxsize=64)
        self._subs.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[ServerEvent]) -> None:
        try:
            self._subs.remove(q)
        except ValueError:
            pass
        self._sub_overflow_warned.pop(id(q), None)

    async def publish(self, event: ServerEvent) -> None:
        # iter-217 (Feature #6 slice 2): write-through to SQLite is
        # the ONLY persistence path now (iter-218 dropped the in-
        # memory deque). Wrapped in try/except so a SQLite hiccup
        # (locked DB, disk full) doesn't break the WS fanout —
        # individual events are then lost from history but live
        # subscribers still see them.
        self._persist_event(event)
        for q in list(self._subs):
            try:
                q.put_nowait(event)
                # Successful put — reset the "warned" flag so a future
                # stall is observed afresh in the journal.
                self._sub_overflow_warned.pop(id(q), None)
            except asyncio.QueueFull:
                if not self._sub_overflow_warned.get(id(q)):
                    log.warning(
                        "event dropped: subscriber queue full (qsize=%d). "
                        "A stalled WebSocket consumer is the usual cause; "
                        "history still persists to SQLite, the WS will "
                        "catch up on next successful send.",
                        q.qsize(),
                    )
                    self._sub_overflow_warned[id(q)] = True

    def _persist_event(self, event: ServerEvent) -> None:
        """iter-217: SQLite write-through. Failures are non-fatal —
        a hiccup on the events.db (disk full, locked, missing dir)
        must NOT break the live WS fanout. Logs once per process
        on the first failure so the journal flags the problem
        without flooding under sustained errors. The `_persist_warned`
        flag resets on successful insert so a transient blip
        re-arms the warning.
        """
        try:
            # Lazy import: events_db imports DetectionEventDict from
            # THIS module — module-level import would loop.
            from .events_db import insert_event
            from ..config import settings

            insert_event(settings.events_db_path, event)
            self._persist_warned = False
        except Exception:
            if not getattr(self, "_persist_warned", False):
                log.warning(
                    "event-store write failed; WS fanout still working, "
                    "but /api/events listing + slice-4 search will miss "
                    "this event. Investigate events.db permissions / "
                    "disk space.",
                    exc_info=True,
                )
                self._persist_warned = True

    def recent(self, limit: int = 100) -> list[ServerEvent]:
        """iter-218 (Feature #6 slice 3): read from SQLite instead
        of the dropped in-memory deque. Same wire shape (newest-
        first list of DetectionEventDict, bounded by `limit`).
        Lazy import dodges the events_db ↔ event_bus circular dep
        the same way `_persist_event` does. Returns an empty list
        on SQLite failure rather than raising — symmetric with the
        write-side fail-open. The /api/events route's wire shape
        is preserved.
        """
        try:
            from .events_db import recent as _db_recent
            from ..config import settings

            return _db_recent(settings.events_db_path, limit=limit)
        except Exception:
            log.warning(
                "events_db.recent() failed; returning empty list. "
                "Investigate events.db permissions / corruption.",
                exc_info=True,
            )
            return []

    def reset(self) -> None:
        """iter-218: vestigial after the deque drop. Kept as a no-op
        for API stability — `tests/conftest.py::_reset_event_bus`
        autouse fixture still calls it. Per-test events_db isolation
        is handled by `_isolate_events_db` (autouse, redirects
        `settings.events_db_path` to a fresh tmp_path). If a future
        iter wants to truncate events_db here, call
        `events_db.reset(settings.events_db_path)` — but for now,
        the per-test tmp file IS the cleanup."""
        return None


event_bus = EventBus()


def make_detection_event(
    label: str,
    score: float,
    boxes: list[dict[str, Any]],
    camera_id: str = "cam1",
    thumb_url: str | None = None,
    person_name: str | None = None,
    clip_url: str | None = None,
    event_id: str | None = None,
) -> DetectionEventDict:
    """Construct a fresh DetectionEventDict.

    `boxes` accepts plain dicts because Pydantic models on the route layer
    have already validated them. We don't re-validate against BoxDict here
    — TypedDicts are runtime-erased anyway, this is a type-checker hint.

    iter-204 (Feature #1 slice 4): `clip_url` is the optional per-event
    MP4 clip URL. Today defaults to None until the iter-247 recorder
    populates it after ffmpeg confirms the file landed.

    iter-247 (Feature #1 slice 2b): accept an optional worker-supplied
    `event_id`. The worker generates a uuid before emit so it can pre-
    create `recordings/<id>.mp4` AND post the event in one shot. When
    None (legacy / non-recording call paths like the simulator), fall
    back to a server-generated uuid — preserves the pre-iter-247
    behaviour for the 99% of callers that don't care.
    """
    return {
        "v": 1,
        "type": "detection",
        "id": event_id if event_id else uuid.uuid4().hex,
        "ts": time.time(),
        "camera_id": camera_id,
        "label": label,
        "score": score,
        "boxes": boxes,  # type: ignore[typeddict-item]
        "thumb_url": thumb_url,
        "person_name": person_name,
        "clip_url": clip_url,
    }
