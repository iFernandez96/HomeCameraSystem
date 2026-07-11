"""Visit lifecycle state machine for continuous (person-following) recording.

THE GOAL (docs/continuous_capture_plan.md, S0/S1): follow the same subject
through an event and record *continuously* until they leave; then a post-roll
grace timer runs; if they return before it expires, RESET it. One **visit =
one clip** — no overlapping per-event clips, so the daily-timelapse "teleport"
disappears at the source.

This module is the PURE state machine: it converts a per-frame "is this
subject present" stream into clip-lifecycle transitions (open / extend /
finalize). It has NO I/O, NO logging, NO hardware, NO clock — the caller
injects ``now`` on every call, so the whole thing is offline-testable
(tests/test_visit.py). The finalize layer (segment-range concat, keyframe
snapping, validation) lives elsewhere; here boundaries are NOMINAL.

State per emit key (``"label:camera"``): IDLE / PRESENT / POST_ROLL.
  * IDLE      — no live visit.
  * PRESENT   — subject seen this frame; the absence countdown is reset.
  * POST_ROLL — subject not seen recently; the grace countdown is running.
The PRESENT/POST_ROLL split is implicit in ``last_seen`` vs ``now`` against
the (caller-supplied) ``absence_finalize_s``; we keep one record per key.

Transitions (plain dicts, JSON-safe, Python 3.6-safe):
  {"kind":"open","key":k,"visit_id":sid,"root_visit_id":vid,
   "start_ts":t,"segment_index":n}
      t == first_detect_now - pre_roll_s (continuation opens carry no pre-roll;
      segment_index is 0 for a fresh visit, +1 per max-visit continuation).
      ``sid`` is the independently playable segment/event id; ``vid`` is the
      stable physical-visit story id shared by every capped continuation.
  {"kind":"extend","key":k,"visit_id":sid,"root_visit_id":vid,"end_ts":t}
  {"kind":"finalize","key":k,"visit_id":sid,"root_visit_id":vid,
   "start_ts":t0,"end_ts":t1,"segment_index":n}

Bias is toward EMITTING / keeping ONE window when unsure: a security camera
missing a real event is worse than an extra one, and IoU is ADVISORY for
continuity (any present detection within the open window keeps the single
window open) — never gating.

Python 3.6 compatible (runs on the JetPack 4.x host): no PEP-604 unions, no
walrus, no match, no PEP-585 generics. Mirrors detection/presence.py purity +
style and REUSES its ``bbox_iou``.
"""
import uuid

from presence import bbox_iou


# Per-key record keys (kept as a plain dict for snapshot/JSON-serializability):
#   state          : "IDLE" | "PRESENT" | "POST_ROLL"
#   visit_id       : current segment/event id (str) or None
#   root_visit_id  : physical-visit story id shared by capped continuations
#   box            : last (left, top, right, bottom) — advisory continuity
#   started_at     : wall-clock of the FIRST present frame of this visit
#   last_seen      : wall-clock of the most recent present frame (resets grace)
#   start_ts       : nominal window start (first_detect - pre_roll, or the
#                    previous window's end_ts for a continuation)
#   segment_index  : 0 for the first window, +1 per max-visit continuation


class VisitTracker(object):
    """Turns a per-frame presence stream into open/extend/finalize transitions,
    one continuous window per emit key. See the module docstring for the
    behavior contract.

    All times are seconds in whatever clock the caller uses (the worker passes
    ``time.time()``), consistently — every public method takes ``now`` so the
    machine is pure + deterministic and unit-testable without the camera.

    ``absence_finalize_s`` and ``max_visit_s`` are CALL ARGS (not stored), so a
    live operator slider change takes effect on the very next tick.
    """

    def __init__(self, iou_threshold=0.3, max_keys=32, id_factory=None):
        # IoU at/above which an incoming box is "the same subject continuing".
        # 0.3 is permissive (a person crossing the frame at 5 fps overlaps its
        # previous box heavily); a teleport-sized jump (clearly different
        # subject arriving during the old one's grace tail) drops below and
        # finalizes-then-opens.
        self._iou_threshold = iou_threshold
        # Hard cap on tracked keys (operator-misconfig guard). label-vocab x
        # camera-count is small in practice (single camera, ~10 classes).
        self._max_keys = max_keys
        # Injected for deterministic tests; defaults to a fresh uuid4 hex.
        if id_factory is None:
            id_factory = lambda: uuid.uuid4().hex  # noqa: E731
        self._id_factory = id_factory
        # key -> record dict (see the field comment block above).
        self._visits = {}

    # -- public API ---------------------------------------------------------

    def observe(self, key, box, now, pre_roll_s, absence_finalize_s,
                max_visit_s):
        """Record a PRESENT detection for ``key`` at ``now`` and return the
        list of resulting transitions (0, 1, or 2). ``box`` is a 4-tuple/list
        (Left, Top, Right, Bottom) matching ``bbox_iou``. Mutates state.

        Order of operations matters:
          1. If an existing visit's grace deadline already passed, finalize it
             first (a present frame that arrived only AFTER the deadline starts
             a fresh visit, not an extend).
          2. If a clearly-different subject (IoU below threshold) arrives while
             an old visit is still open, finalize the old + open a new one.
          3. Otherwise open (from IDLE) or extend (continuation in-window),
             checking the non-resettable max-visit cap on the way.
        """
        out = []
        rec = self._visits.get(key)
        live = rec is not None and rec["state"] != "IDLE"

        if not live:
            self._prune(now)
            out.append(self._open(key, box, now, pre_roll_s, segment_index=0,
                                  start_ts=now - pre_roll_s))
            return out

        # User-semantics fix (2026-07-07, gpt-5.5 consult finding #2): the
        # IoU "same subject" test used to GATE continuation — a person
        # re-entering at a different spot within the grace window finalized
        # the visit and opened a new one, which is exactly the duplicate-
        # event spam this feature exists to kill, and it contradicted the
        # module's own "IoU is ADVISORY, never gating" contract. Presence
        # of ANY detection for this key inside the window now continues
        # the visit; identity tracking is not something the detector can
        # do anyway (no re-id model), so position must not split visits.

        # 1. Non-resettable max-visit cap (disk guard) takes precedence for a
        #    still-present continuation: this IS a present frame, so even if
        #    the inter-frame gap nominally exceeds the absence grace we split
        #    into adjacent continuation windows rather than declaring a
        #    separate visit. v2.start_ts == v1.end_ts EXACTLY at the nominal
        #    level, NO pre-roll re-added (keyframe snapping is finalize-layer).
        if (now - rec["started_at"]) >= max_visit_s:
            boundary = rec["started_at"] + max_visit_s
            seg = rec["segment_index"]
            root_visit_id = rec.get("root_visit_id") or rec["visit_id"]
            out.append(self._finalize(key, rec, boundary, now,
                                      clamp_to_now=False))
            out.append(self._open(key, box, now, pre_roll_s,
                                  segment_index=seg + 1, start_ts=boundary,
                                  root_visit_id=root_visit_id))
            return out

        # 2. A pre-existing visit whose absence deadline already elapsed must
        #    finalize before this (late) present frame is considered — the
        #    subject left and the grace ran out, so this is a NEW visit.
        deadline = rec["last_seen"] + absence_finalize_s
        if now > deadline:
            out.append(self._finalize(key, rec, deadline, now))
            self._prune(now)
            out.append(self._open(key, box, now, pre_roll_s, segment_index=0,
                                  start_ts=now - pre_roll_s))
            return out

        # 3. Ordinary continuation: any detection for this key in-window ->
        #    extend. This resets the absence countdown (last_seen = now).
        rec["box"] = box
        rec["last_seen"] = now
        rec["state"] = "PRESENT"
        out.append({
            "kind": "extend",
            "key": key,
            "visit_id": rec["visit_id"],
            "root_visit_id": rec.get("root_visit_id") or rec["visit_id"],
            "end_ts": now,
        })
        return out

    def tick(self, now, absence_finalize_s, max_visit_s):
        """Advance time for ALL keys without a present detection this frame and
        return finalize (and possibly continuation-open) transitions for any
        key whose absence deadline or max-visit cap has passed.

        Called every loop iteration INCLUDING idle frames (B5: at the loop top
        before any early-continue) — the all-empty-frame case is exactly what
        the absence deadline needs to fire.
        """
        out = []
        for key in list(self._visits.keys()):
            rec = self._visits.get(key)
            if rec is None or rec["state"] == "IDLE":
                continue
            # Max-visit cap can trip even while the subject keeps appearing, but
            # tick only sees absent frames; a present subject crossing the cap
            # is handled in observe(). Here only the absence deadline matters.
            deadline = rec["last_seen"] + absence_finalize_s
            if now > deadline:
                out.append(self._finalize(key, rec, deadline, now))
        return out

    def active_visit_id(self, key):
        """The current segment/event id for ``key``, or None."""
        rec = self._visits.get(key)
        if rec is None or rec["state"] == "IDLE":
            return None
        return rec["visit_id"]

    def active_root_visit_id(self, key):
        """The stable physical-visit story id for ``key``, or None.

        A max-duration cap creates a fresh event/clip id but deliberately keeps
        this root id, allowing the server to present every adjacent segment as
        one visit without sacrificing independently playable clips.
        """
        rec = self._visits.get(key)
        if rec is None or rec["state"] == "IDLE":
            return None
        return rec.get("root_visit_id") or rec["visit_id"]

    def forget(self, key):
        """Drop all state for ``key`` so the next detection on it opens a fresh
        visit. Used by the runtime layer to ROLL BACK an open the side-effect
        layer refused (e.g. the disk floor blocked the new visit): without this
        the tracker would keep PRESENT state and re-emit extends for a visit the
        runner never actually opened. No-op if the key is unknown."""
        self._visits.pop(key, None)

    def snapshot(self):
        """A plain JSON-serializable dict of all live per-key state (for the
        future crash-persist / recovery layer). Excludes IDLE records."""
        out = {}
        for key, rec in self._visits.items():
            if rec["state"] == "IDLE":
                continue
            out[key] = {
                "state": rec["state"],
                "visit_id": rec["visit_id"],
                "root_visit_id": rec.get("root_visit_id") or rec["visit_id"],
                "box": list(rec["box"]) if rec["box"] is not None else None,
                "started_at": rec["started_at"],
                "last_seen": rec["last_seen"],
                "start_ts": rec["start_ts"],
                "segment_index": rec["segment_index"],
            }
        return out

    # -- internals ----------------------------------------------------------

    def _open(self, key, box, now, pre_roll_s, segment_index, start_ts,
              root_visit_id=None):
        """Create a fresh (or continuation) visit record and return its open
        transition. ``start_ts`` is supplied by the caller: ``now - pre_roll_s``
        for a brand-new visit, or the previous window's ``end_ts`` (no pre-roll)
        for a max-visit continuation."""
        vid = self._id_factory()
        if root_visit_id is None:
            root_visit_id = vid
        self._visits[key] = {
            "state": "PRESENT",
            "visit_id": vid,
            "root_visit_id": root_visit_id,
            "box": box,
            "started_at": now,
            "last_seen": now,
            "start_ts": start_ts,
            "segment_index": segment_index,
        }
        return {
            "kind": "open",
            "key": key,
            "visit_id": vid,
            "root_visit_id": root_visit_id,
            "start_ts": start_ts,
            "segment_index": segment_index,
        }

    def _finalize(self, key, rec, end_ts, now, clamp_to_now=True):
        """Close ``rec``'s window at ``end_ts`` (clamped <= now by default so a
        wall-clock window never claims footage that doesn't exist yet) and reset
        the key to IDLE. Returns the finalize transition.

        The cap-split path passes ``clamp_to_now=False``: the boundary is
        started_at + max_visit which is <= now there anyway, and clamping it to
        ``now`` would break the exact v2.start_ts == v1.end_ts adjacency.
        """
        if clamp_to_now and end_ts > now:
            end_ts = now
        tr = {
            "kind": "finalize",
            "key": key,
            "visit_id": rec["visit_id"],
            "root_visit_id": rec.get("root_visit_id") or rec["visit_id"],
            "start_ts": rec["start_ts"],
            "end_ts": end_ts,
            "segment_index": rec["segment_index"],
        }
        # Reset to IDLE rather than delete so _prune size-accounting and a
        # later re-open behave uniformly; _prune drops stale IDLE records.
        rec["state"] = "IDLE"
        rec["visit_id"] = None
        rec["last_seen"] = now
        return tr

    def _prune(self, now):
        """Drop IDLE/finalized records and hard-cap the live dict size.

        IDLE records (already finalized) are reclaimed eagerly. If the dict is
        still over the cap, evict the oldest by ``last_seen`` (an
        operator-misconfig backstop — bounds memory under a label explosion).
        """
        idle = [k for k, v in self._visits.items() if v["state"] == "IDLE"]
        for k in idle:
            del self._visits[k]
        # Leave room for the about-to-be-inserted record: prune is always
        # called from the new-visit path just BEFORE an insert, so cap the
        # surviving live set at max_keys - 1 to stay <= max_keys after.
        while len(self._visits) >= self._max_keys:
            oldest = min(
                self._visits,
                key=lambda k: self._visits[k]["last_seen"],
            )
            del self._visits[oldest]
