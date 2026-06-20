"""Presence-based event coalescing for the detection worker.

THE PROBLEM (user-reported 2026-06-20): a single continuous presence — one
subject lingering in frame — used to re-fire a brand-new event + thumbnail +
clip every ``cooldown_s`` (~5 s) for as long as it stayed. A 30 s visit became
~6 events and ~6 heavily-overlapping clips: notification/list spam, ~6x clip
storage, and (stitched) the "people teleporting back in time" timelapse.

THE FIX: collapse those re-fires. While the same subject keeps appearing in
roughly the same place (IoU-matched) AND its clip is still recording, new
emits are SUPPRESSED. A new event fires only when:
  * a brand-new / relocated subject appears (no live presence for the key, or
    an IoU mismatch past the min-gap floor),
  * the subject left and returned (presence gap exceeded), or
  * a continuous presence OUTLASTS its clip — re-arm to the next segment, so a
    long linger is covered by back-to-back, non-overlapping clips (which the
    timelapse de-overlap then keeps whole) instead of ~one clip per cooldown.

Bias is toward EMITTING when uncertain: a security camera missing a real event
is worse than an extra one. Suppression only ever merges re-fires WITHIN one
continuous, IoU-matched, still-recording presence.

Python 3.6 compatible (runs on the JetPack 4.x host — no f-strings in hot
paths is moot here since this is pure logic, but no PEP-604 unions / walrus /
match either). No I/O, no logging — unit tested in tests/test_presence.py.
"""


def bbox_iou(a, b):
    """Intersection-over-union of two ``(left, top, right, bottom)`` boxes
    (any consistent coordinate space). Returns 0.0 on degenerate / disjoint
    input."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0 = max(ax0, bx0)
    iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1)
    iy1 = min(ay1, by1)
    iw = ix1 - ix0
    ih = iy1 - iy0
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


class PresenceTracker(object):
    """Tracks one live presence per emit key (``"label:camera"``) and decides
    whether an incoming detection should emit a new event or be coalesced into
    the live one. See module docstring for the behavior contract.

    All times are seconds in whatever clock the caller uses (the worker passes
    ``time.time()``), consistently. Pure + deterministic so the loop logic is
    unit-testable without the camera.
    """

    def __init__(self, iou_threshold=0.3, max_keys=32):
        # IoU at/above which the current box is "the same subject continuing".
        # 0.3 is deliberately permissive: a person walking across the frame at
        # 5 fps overlaps its previous box heavily (IoU > 0.5 typically), so a
        # genuine continuation matches; a teleport-sized jump (new subject /
        # relocation) drops below and re-emits.
        self._iou_threshold = iou_threshold
        # Hard cap on tracked keys (operator-misconfig guard, mirrors the old
        # last_emit_by_key cap). label-vocab x camera-count is small in
        # practice (single camera, ~10 wanted classes).
        self._max_keys = max_keys
        # key -> {"box", "last_seen", "clip_ends_at", "last_emit"}
        self._presence = {}

    def should_emit(self, key, box, now, clip_duration_s, presence_gap_s,
                    min_gap_s):
        """Return True if this detection should EMIT a new event, False if it
        should be coalesced into the live presence. Mutates internal state.

        ``box``            : (left, top, right, bottom) of the top detection.
        ``clip_duration_s``: ~length of the clip this event would record
                             (pre+post roll). Drives the re-arm so a long
                             linger segments into back-to-back clips.
        ``presence_gap_s`` : if the same key hasn't been seen for longer than
                             this, the subject is considered to have LEFT —
                             the next detection is a fresh visit.
        ``min_gap_s``      : floor between emits for one key (the old cooldown)
                             so distinct subjects can't ping-pong-spam.
        """
        p = self._presence.get(key)
        # Presence lapsed (subject gone longer than the gap) -> brand-new visit.
        if p is not None and (now - p["last_seen"]) > presence_gap_s:
            p = None
        if p is None:
            self._prune(now, presence_gap_s)
            self._presence[key] = {
                "box": box,
                "last_seen": now,
                "clip_ends_at": now + clip_duration_s,
                "last_emit": now,
            }
            return True
        same_subject = bbox_iou(box, p["box"]) >= self._iou_threshold
        p["last_seen"] = now
        p["box"] = box
        emit = False
        if not same_subject:
            # A different / relocated subject under the same (label, camera).
            # Emit a fresh event, but never faster than the floor.
            if (now - p["last_emit"]) >= min_gap_s:
                emit = True
        elif now >= p["clip_ends_at"]:
            # Same subject, but its clip has finished recording — start the
            # next segment so a long linger stays covered (and the segments
            # tile back-to-back without overlap).
            emit = True
        if emit:
            p["clip_ends_at"] = now + clip_duration_s
            p["last_emit"] = now
        return emit

    def _prune(self, now, presence_gap_s):
        """Drop lapsed presences and hard-cap the dict size."""
        stale = [
            k for k, v in self._presence.items()
            if (now - v["last_seen"]) > presence_gap_s
        ]
        for k in stale:
            del self._presence[k]
        if len(self._presence) > self._max_keys:
            oldest = min(
                self._presence,
                key=lambda k: self._presence[k]["last_seen"],
            )
            del self._presence[oldest]
