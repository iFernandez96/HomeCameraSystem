"""Continuous-capture (person-following) wiring + crash recovery (plan S4).

This module is the OFFLINE-TESTABLE seam between the pure ``visit.py`` state
machine and the hardware-coupled ``detect.py`` loop. It owns:

  * FLAG + KNOB resolution (env + config-poll) — ``resolve_continuous_config``.
    Pure; unit-tested without the SDK.
  * The transition HANDLER (``VisitRunner.handle_transitions``) that maps the
    state machine's open/extend/finalize dicts onto event-POST /
    incremental-copy / background-finalize side effects — taking those side
    effects as INJECTED callables so the handler can be exercised with a fake
    VisitTracker + fakes for POST/finalize, no camera.
  * 3-STATE idempotent crash recovery (plan B4): ``.open_visits.json`` with an
    ``OPEN -> FINALIZING -> done`` lifecycle, atomic write + fsync of BOTH the
    file AND its directory on every open/extend, and ``recover_open_visits``
    that NEVER ``os.replace``-es over an already-valid ``<id>.mp4`` and
    finalizes only the survivors.
  * Orphan sweep (plan R8): boot-time reap of ``_visits/*`` scratch +
    ``*.mp4.tmp``, scoped to those ONLY — never ``_preroll/seg_*``.
  * Watchdog coupling (plan R5): ``finalize_open_visits_for_escalation``
    closes any open visit at ``last_seen`` and persists BEFORE a reboot.

HARD XOR with the legacy ``start_clip`` path lives in ``detect.py``: when the
flag is OFF this module's runner is never constructed and the loop behaves
exactly as before (the legacy recorder is the rollback).

Python 3.6 compatible (runs on the JetPack 4.x host): no PEP-604 unions, no
walrus, no match, no PEP-585 generics, no ``from __future__``.
"""
import json
import os
import shutil
import threading

import applog
import clip_state

from visit import VisitTracker


# Env knob names + defaults (plan S4 item 1).
ENV_FLAG = "DETECT_CONTINUOUS_CAPTURE"
ENV_MAX_VISIT_S = "DETECT_MAX_VISIT_S"
ENV_ABSENCE_FINALIZE_S = "DETECT_ABSENCE_FINALIZE_S"

DEFAULT_MAX_VISIT_S = 150.0
DEFAULT_ABSENCE_FINALIZE_S = 30.0

# --- worker disk floor (plan S4.5 / blocker B2) ---
#
# Before OPENING a new visit, and on every EXTEND, the worker checks free
# space at recordings_dir. Below WORKER_MIN_FREE_BYTES it REFUSES (doesn't open
# / stops extending → the visit finalizes what it already has) and logs.
#
# This floor MUST sit strictly ABOVE the server's SERVER_MIN_FREE_BYTES
# (server/app/services/recording_service.py, ~300 MB): the worker stops
# CREATING footage before the server is ever forced to start DELETING it.
# If the two were equal/inverted, the worker would keep opening visits that
# the server immediately evicts — a live-lock where the card thrashes and no
# visit ever completes. We keep ~150 MB of headroom above the server floor so
# there's room for in-flight finalize scratch + the next visit's segments
# between the two thresholds.
#
# Kept as a literal here (NOT imported from the server) because detection/ runs
# Python 3.6 on the Jetson host and has no path to the FastAPI package. The
# ordering invariant (WORKER_MIN_FREE_BYTES > SERVER_MIN_FREE_BYTES) is pinned
# by test_disk_floor_ordering.py, which imports BOTH constants.
WORKER_MIN_FREE_BYTES = 450 * 1024 * 1024  # ~450 MB (> server's ~300 MB)

# Per-visit lifecycle states persisted in .open_visits.json (plan B4).
STATE_OPEN = "OPEN"
STATE_FINALIZING = "FINALIZING"

# Bounded recovery retries (2026-07-07 replay-harness finding): a FINALIZING
# entry whose scratch is GONE (boot sweep raced it / disk loss) can never
# produce a clip — the old behavior retried it on EVERY boot forever
# ("leaving FINALIZING for a later retry" repeating across worker lives in
# the prod journal). One retry is still allowed (a transiently-unmounted
# card recovers), but after this many failed finalize attempts the entry is
# abandoned with a loud ERROR — the footage is unrecoverable by then.
RECOVERY_MAX_FINALIZE_ATTEMPTS = 3

# On-disk artifacts the boot sweep is allowed to touch (plan R8). The
# scratch root is a child of recordings_dir; we NEVER touch _preroll/seg_*.
_VISITS_SUBDIR = "_visits"
_OPEN_VISITS_FILE = ".open_visits.json"


def _as_bool(raw):
    """Parse a truthy env string. ``None``/empty -> False."""
    if raw is None:
        return False
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def resolve_continuous_config(env=None, config=None):
    """Resolve the continuous-capture flag + knobs from env and the polled
    config dict, returning a plain dict::

        {"enabled": bool, "max_visit_s": float, "absence_finalize_s": float}

    Precedence: a value PRESENT in ``config`` (the live server config-poll)
    wins over the env var, which wins over the built-in default. This lets the
    operator flip the feature / drag the sliders without a worker restart while
    still honoring a boot-time env override when the server hasn't spoken yet.

    Pure (no I/O); ``env`` defaults to ``os.environ`` only when not injected so
    tests pass an explicit dict. Bad/uncastable values fall back to the default
    for that field (never raise) — a fat-fingered slider can't wedge the loop.
    """
    if env is None:
        env = os.environ
    if config is None:
        config = {}

    # enabled: config flag (if present) overrides env.
    if "continuous_capture" in config:
        enabled = bool(config.get("continuous_capture"))
    else:
        enabled = (
            True if env.get(ENV_FLAG) is None else _as_bool(env.get(ENV_FLAG))
        )

    max_visit_s = _resolve_float(
        config.get("max_visit_s"), env.get(ENV_MAX_VISIT_S),
        DEFAULT_MAX_VISIT_S,
    )
    absence_finalize_s = _resolve_float(
        config.get("absence_finalize_s"), env.get(ENV_ABSENCE_FINALIZE_S),
        DEFAULT_ABSENCE_FINALIZE_S,
    )
    return {
        "enabled": enabled,
        "max_visit_s": max_visit_s,
        "absence_finalize_s": absence_finalize_s,
    }


def _resolve_float(config_val, env_val, default):
    """config value > env value > default, each guarded against bad casts and
    non-positive results (a 0/negative window is meaningless)."""
    for candidate in (config_val, env_val):
        if candidate is None or candidate == "":
            continue
        try:
            v = float(candidate)
        except (TypeError, ValueError):
            continue
        if v > 0:
            return v
    return default


def scratch_dir_for(recordings_dir, visit_id):
    """Per-visit scratch dir: ``<recordings_dir>/_visits/<visit_id>``. The
    finalize layer concats the copied segments here into ``<visit_id>.mp4``."""
    return os.path.join(str(recordings_dir), _VISITS_SUBDIR, str(visit_id))


def _open_visits_path(recordings_dir):
    return os.path.join(str(recordings_dir), _OPEN_VISITS_FILE)


def _fsync_dir(dir_path):
    """fsync a directory FD so a freshly-written/renamed dirent is durable.
    Best-effort: some filesystems reject directory fsync (vfat / network) with
    EINVAL/EBADF — swallow so persistence never crashes the loop."""
    try:
        fd = os.open(dir_path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def write_open_visits(recordings_dir, visits):
    """Atomically persist the open-visit table (plan B4) and fsync BOTH the
    file AND its directory. ``visits`` is ``{visit_id: record}`` where record
    carries at least ``state``/``start_ts``/``last_extend``/``key`` etc.

    Stronger than ``detect._save_watchdog_state`` (which does NOT fsync): a
    crash immediately after the rename must still find a complete, durable
    table so recovery is deterministic. tmp-write -> fsync(tmp) -> os.replace
    -> fsync(dir)."""
    path = _open_visits_path(recordings_dir)
    rec_dir = str(recordings_dir)
    try:
        os.makedirs(rec_dir, exist_ok=True)
    except OSError as e:
        applog.emit(
            "visit",
            "ERROR open-visits makedirs failed for {!r}: {}: {} — crash "
            "recovery degraded".format(rec_dir, type(e).__name__, e),
        )
        return False
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump({"v": 1, "visits": visits}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        _fsync_dir(rec_dir)
        return True
    except OSError as e:
        applog.emit(
            "visit",
            "ERROR open-visits persist failed ({!r}): {}: {} — crash "
            "recovery degraded".format(path, type(e).__name__, e),
        )
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False


def read_open_visits(recordings_dir):
    """Load the persisted open-visit table. Returns ``{visit_id: record}`` or
    ``{}`` on any error / absent file (fresh start)."""
    path = _open_visits_path(recordings_dir)
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if isinstance(data, dict) and isinstance(data.get("visits"), dict):
        return data["visits"]
    return {}


def _clip_is_valid(recordings_dir, visit_id, validate_clip):
    """True iff ``<recordings_dir>/<visit_id>.mp4`` exists AND ffprobe-
    validates. ``validate_clip(path) -> bool`` is injected (detect.py wires the
    recorder's ffprobe gate; tests pass a fake) so this stays offline-testable
    and never shells out in a unit test."""
    final_path = os.path.join(str(recordings_dir), "{}.mp4".format(visit_id))
    if not (os.path.exists(final_path) and os.path.getsize(final_path) > 0):
        return False
    try:
        return bool(validate_clip(final_path))
    except Exception:
        # A probe that raises is treated as "not valid" — fail toward
        # re-finalizing from scratch rather than trusting a maybe-broken file.
        return False


def recover_open_visits(recordings_dir, validate_clip, finalize_visit,
                        now, default_absence_finalize_s=DEFAULT_ABSENCE_FINALIZE_S):
    """3-state idempotent crash recovery (plan B4). For each non-done visit in
    ``.open_visits.json``:

      * If ``<id>.mp4`` already exists AND ``validate_clip`` passes -> the clip
        survived the crash. Mark DONE, drop the entry, DO NOT re-finalize and
        NEVER ``os.replace`` over the good file. (THE idempotency property.)
      * Otherwise transition the entry to FINALIZING (persisted BEFORE the
        concat so a re-crash mid-finalize re-enters here, finds either a valid
        clip -> skip, or no clip -> retry — never a double publish), then call
        ``finalize_visit(visit_id, scratch_dir, start_ts, end_ts)`` over
        ``[start_ts, min(last_extend, now)]`` — exactly the footage scratch
        can hold (bug-B3 fix: the grace tail after last_extend was never
        recorded pre-crash, so claiming it duration-refused honest clips).
        On success drop the entry.

    ``finalize_visit`` returns True on a published clip. Side-effect callables
    are injected so the whole routine is unit-testable with no ffmpeg. Returns
    a summary dict ``{"skipped": [...], "finalized": [...], "failed": [...]}``.
    """
    visits = read_open_visits(recordings_dir)
    summary = {"skipped": [], "finalized": [], "failed": [], "abandoned": []}
    if not visits:
        return summary

    # Iterate over a snapshot; we mutate `visits` as we resolve each entry.
    for visit_id in list(visits.keys()):
        rec = visits.get(visit_id) or {}
        # Idempotency gate: a valid output already on disk means a prior life
        # already published this clip. Never touch it again.
        if _clip_is_valid(recordings_dir, visit_id, validate_clip):
            applog.emit(
                "visit",
                "recovery: visit {} already has a valid clip — marking DONE "
                "(no re-finalize)".format(visit_id),
            )
            del visits[visit_id]
            write_open_visits(recordings_dir, visits)
            summary["skipped"].append(visit_id)
            continue

        # No valid output -> finalize from surviving scratch. Move to
        # FINALIZING + persist FIRST so a re-crash resumes correctly. The
        # attempt counter (bounded retry, 2026-07-07) is bumped in the same
        # persisted write so a crash mid-finalize still counts the attempt.
        rec["state"] = STATE_FINALIZING
        try:
            attempts = int(rec.get("finalize_attempts", 0) or 0) + 1
        except (TypeError, ValueError):
            attempts = 1
        rec["finalize_attempts"] = attempts
        visits[visit_id] = rec
        write_open_visits(recordings_dir, visits)

        start_ts = rec.get("start_ts")
        last_extend = rec.get("last_extend", rec.get("last_seen", start_ts))
        # Recovery window fix (2026-07-07, harness bug B3 — deliberate
        # change to the plan-B4 formula): the OLD window added the
        # absence grace (`last_extend + absence_finalize_s`), but scratch
        # only ever holds footage up to last_extend — the grace tail was
        # never recorded before the crash and the ring is gone by the
        # next boot. Claiming it made finalize's duration check REFUSE
        # the honest clip whenever recovery ran later than the tolerance
        # (guaranteed loss at absence=30, coin-flip at 10), burning the
        # bounded retries on footage that could never exist. Recover
        # exactly what was captured: end at last_extend.
        try:
            end_ts = min(float(last_extend), float(now))
        except (TypeError, ValueError):
            end_ts = now
        scratch = scratch_dir_for(recordings_dir, visit_id)
        ok = False
        try:
            ok = bool(finalize_visit(visit_id, scratch, start_ts, end_ts))
        except Exception as e:
            applog.emit(
                "visit",
                "ERROR recovery finalize raised for visit {}: {}: {}".format(
                    visit_id, type(e).__name__, e,
                ),
            )
        if ok:
            del visits[visit_id]
            write_open_visits(recordings_dir, visits)
            summary["finalized"].append(visit_id)
        elif attempts >= RECOVERY_MAX_FINALIZE_ATTEMPTS:
            # Bounded retry (2026-07-07): the entry has failed finalize on
            # this many separate recovery passes — its scratch is gone for
            # good (tonight's prod journal showed the same visit re-failing
            # boot after boot, forever). Abandon LOUDLY: drop the entry so
            # the next boot stops burning a finalize on it. The event row
            # keeps its honest 404 clip.
            applog.emit(
                "visit",
                "ERROR recovery: giving up on visit {} after {} failed "
                "finalize attempts (scratch lost?) — dropping entry; "
                "footage unrecoverable".format(visit_id, attempts),
            )
            del visits[visit_id]
            write_open_visits(recordings_dir, visits)
            summary["abandoned"].append(visit_id)
        else:
            # Leave the FINALIZING entry: a later boot re-attempts it (the
            # scratch may have been partially lost — we tolerate a short clip
            # next time rather than publishing garbage now). Bounded: after
            # RECOVERY_MAX_FINALIZE_ATTEMPTS total failures it is abandoned.
            applog.emit(
                "visit",
                "recovery: finalize of visit {} produced no clip — leaving "
                "FINALIZING for a later retry (attempt {}/{})".format(
                    visit_id, attempts, RECOVERY_MAX_FINALIZE_ATTEMPTS,
                ),
            )
            summary["failed"].append(visit_id)
    return summary


def sweep_orphans(recordings_dir):
    """Boot-time orphan reap (plan R8), scoped to continuous-capture artifacts
    ONLY: every dir under ``<recordings_dir>/_visits/`` whose visit_id is NOT
    in the live ``.open_visits.json``, plus stray ``*.mp4.tmp`` in
    recordings_dir. NEVER touches ``_preroll/seg_*`` (the live pre-roll ring).

    Returns the count of paths reclaimed. Best-effort; never raises."""
    rec_dir = str(recordings_dir)
    reclaimed = 0
    live = set(read_open_visits(recordings_dir).keys())

    # 1. Orphan scratch dirs under _visits/.
    visits_root = os.path.join(rec_dir, _VISITS_SUBDIR)
    try:
        names = os.listdir(visits_root)
    except OSError:
        names = []
    for name in names:
        if name in live:
            continue
        path = os.path.join(visits_root, name)
        if not os.path.isdir(path):
            continue
        try:
            shutil.rmtree(path, ignore_errors=True)
            if not os.path.exists(path):
                reclaimed += 1
        except OSError:
            pass

    # 2. Stray *.mp4.tmp directly in recordings_dir (a finalize that crashed
    #    mid-publish). Scoped to the .mp4.tmp suffix so we can't nuke clips.
    try:
        rec_names = os.listdir(rec_dir)
    except OSError:
        rec_names = []
    for name in rec_names:
        if not name.endswith(".mp4.tmp"):
            continue
        path = os.path.join(rec_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            reclaimed += 1
        except OSError:
            pass

    if reclaimed:
        applog.emit(
            "visit",
            "boot sweep reclaimed {} orphan continuous-capture artifact(s) "
            "(_visits scratch + *.mp4.tmp)".format(reclaimed),
        )
    return reclaimed


class VisitRunner(object):
    """Stateful glue that drives the pure ``VisitTracker`` from the loop and
    materializes its transitions into side effects, with crash-durable
    persistence. Constructed ONLY when the continuous-capture flag is ON (hard
    XOR with the legacy recorder in detect.py).

    Side effects are INJECTED so the whole class is offline-testable:

      * ``post_event(visit_id, key, start_ts)`` — POST the open event today
        (clip_url still points at ``/api/events/<id>/clip``; R4's no-clip-url-
        at-open is S6's job, not here). When observe() supplies cuda_img, the
        live detect.py adapter may save the first-frame thumb before posting.
      * ``copy_segments(visit_id, start_ts, until_ts, scratch_dir)`` — the
        incremental ``preroll.copy_new_segments`` call (B3).
      * ``finalize_visit(visit_id, scratch_dir, start_ts, end_ts)`` — the
        background ``recording.finalize_visit``; run in a daemon thread here
        (strong-ref set + de-dupe guard, like the legacy merge thread).

    The on-disk ``.open_visits.json`` record per live visit carries the fields
    recovery needs: ``state``, ``key``, ``start_ts``, ``last_extend``,
    ``segment_index``, ``absence_finalize_s``, ``last_seen``.
    """

    def __init__(self, recordings_dir, post_event, copy_segments,
                 finalize_visit, tracker=None, spawn=None,
                 free_space=None, min_free_bytes=WORKER_MIN_FREE_BYTES):
        self.recordings_dir = str(recordings_dir)
        self._post_event = post_event
        self._copy_segments = copy_segments
        self._finalize_visit = finalize_visit
        # Disk floor (plan S4.5 / B2). ``free_space(path) -> int free bytes`` is
        # injectable for offline tests; default wraps ``shutil.disk_usage`` so
        # the live worker reads the real card. ``min_free_bytes`` is the refuse
        # threshold; below it _on_open won't open and _on_extend stops copying.
        self._min_free_bytes = min_free_bytes
        if free_space is not None:
            self._free_space = free_space
        else:
            self._free_space = self._default_free_space
        self.tracker = tracker if tracker is not None else VisitTracker()
        # Persisted open-visit table {visit_id: record}. Seeded from disk so a
        # construction after recovery doesn't lose surviving entries (recovery
        # finalizes + drops them first, so this is usually {} or FINALIZING-
        # only leftovers — which we don't re-open).
        self._open = {}
        # Per-visit copy accumulators (the opaque (basename, mtime) set from
        # copy_new_segments). Not persisted — on crash recovery re-copies from
        # the surviving scratch instead.
        self._copy_state = {}
        # Strong refs to in-flight finalize threads (so the GC can't collect a
        # daemon thread) + a de-dupe guard so a visit is finalized once.
        self._finalize_threads = set()
        self._finalizing_ids = set()
        # Injected for tests: run the finalize synchronously instead of a
        # daemon thread. Default spawns a real daemon thread.
        self._spawn = spawn if spawn is not None else self._spawn_thread
        # The current frame's box list (set by observe()), read by the
        # synchronous _on_open for the open-event POST. None until first
        # observe / on tick-driven paths (which never open).
        self._pending_boxes = None
        self._pending_cuda_img = None
        # Observability counters (plan S6). Incremented at their main-thread
        # choke points and mirrored onto the metrics heartbeat by detect.py.
        #  - visits_finalized: visits handed to a (de-duped) finalize.
        #  - clips_dropped_disk_floor: opens refused by the disk floor (B2).
        self.visits_finalized = 0
        self.clips_dropped_disk_floor = 0

    # -- disk floor (plan S4.5 / B2) ------------------------------------------

    @staticmethod
    def _default_free_space(path):
        """Default free-space reader: free bytes at ``path`` via
        ``shutil.disk_usage``. Returns None if it can't be read (so callers
        treat an unreadable stat as "don't block" — a transient statvfs error
        must NOT silently stop all recording)."""
        try:
            return shutil.disk_usage(str(path)).free
        except OSError:
            return None

    def _disk_below_floor(self):
        """True iff free space at recordings_dir is KNOWN to be below the
        worker floor. An unreadable free-space stat returns False (bias toward
        recording — a missed event is worse than a transient stat hiccup)."""
        free = self._free_space(self.recordings_dir)
        if free is None:
            return False
        return free < self._min_free_bytes

    # -- per-frame entrypoints ------------------------------------------------

    def tick(self, now, absence_finalize_s, max_visit_s):
        """Loop-top tick (plan B5): advance ALL keys on an absent frame and
        handle resulting finalize transitions. MUST be called every iteration
        before any early-continue so the absence deadline fires on idle frames.
        """
        transitions = self.tracker.tick(now, absence_finalize_s, max_visit_s)
        self._handle(transitions, now)

    def observe(self, key, box, now, pre_roll_s, absence_finalize_s,
                max_visit_s, boxes=None, cuda_img=None):
        """Present-frame observe: feed the detection into the tracker and
        handle its open/extend/finalize transitions.

        ``box`` is the single (L,T,R,B) the tracker uses for IoU continuity;
        ``boxes`` is the frame's full server-valid normalized box list used
        for the open-event POST (the server requires >=1 box). Stashed so the
        synchronous ``_on_open`` below can read it without re-plumbing the
        transition dicts. ``cuda_img`` is the current detection frame; the
        live adapter uses it only on visit open to preserve legacy thumbnails.
        """
        self._pending_boxes = boxes
        self._pending_cuda_img = cuda_img
        transitions = self.tracker.observe(
            key, box, now, pre_roll_s, absence_finalize_s, max_visit_s,
        )
        self._handle(transitions, now)

    def handle_transitions(self, transitions, now):
        """Public handler seam (testable directly with a fake tracker's
        output): apply a list of transition dicts."""
        self._handle(transitions, now)

    # -- transition dispatch --------------------------------------------------

    def _handle(self, transitions, now):
        for tr in transitions:
            kind = tr.get("kind")
            if kind == "open":
                self._on_open(tr, now)
            elif kind == "extend":
                self._on_extend(tr, now)
            elif kind == "finalize":
                self._on_finalize(tr, now)

    def _on_open(self, tr, now):
        visit_id = tr["visit_id"]
        key = tr["key"]
        start_ts = tr["start_ts"]
        # Disk floor (plan S4.5 / B2): REFUSE to open a new visit when free
        # space is below the worker floor. Don't POST, don't record, and roll
        # the tracker back so it doesn't keep emitting extends for a visit we
        # never opened. The server evictor (floor ABOVE which this sits) gets a
        # chance to reclaim before we resume. Log-only (no metric — S6).
        if self._disk_below_floor():
            self.clips_dropped_disk_floor += 1
            free = self._free_space(self.recordings_dir)
            applog.emit(
                "visit",
                "disk floor: REFUSING to open visit {} (key {}) — free space "
                "{} bytes < worker floor {} bytes; clip skipped".format(
                    visit_id, key, free, self._min_free_bytes,
                ),
            )
            try:
                self.tracker.forget(key)
            except Exception:
                pass
            return
        rec = {
            "state": STATE_OPEN,
            "key": key,
            "visit_id": visit_id,
            "start_ts": start_ts,
            "last_extend": start_ts,
            "last_seen": now,
            "segment_index": tr.get("segment_index", 0),
            "absence_finalize_s": self._last_absence_s,
        }
        self._open[visit_id] = rec
        self._copy_state[visit_id] = None
        self._persist()
        clip_state.set_state(
            self.recordings_dir,
            visit_id,
            "recording",
            key=key,
            start_ts=start_ts,
            last_seen=now,
            last_extend=start_ts,
            segment_index=rec["segment_index"],
        )
        # POST the open event today (clip_url points at /api/events/<id>/clip;
        # the no-clip-url-at-open + clip-ready WS update is S6/R4, not here).
        # _pending_boxes is the frame's server-valid box list from observe()
        # (the server requires >=1 box); None on a tick-driven/test path.
        try:
            if self._pending_cuda_img is None:
                self._post_event(
                    visit_id, key, start_ts, self._pending_boxes,
                    rec["segment_index"],
                )
            else:
                self._post_event(
                    visit_id, key, start_ts, self._pending_boxes,
                    rec["segment_index"], cuda_img=self._pending_cuda_img,
                )
        except Exception as e:
            applog.emit(
                "visit",
                "ERROR open-event POST raised for visit {}: {}: {} (visit "
                "still records; clip lands at finalize)".format(
                    visit_id, type(e).__name__, e,
                ),
            )

    def _on_extend(self, tr, now):
        visit_id = tr["visit_id"]
        end_ts = tr["end_ts"]
        rec = self._open.get(visit_id)
        if rec is None:
            return
        rec["last_seen"] = now
        # Disk floor (plan S4.5 / B2): when free space is below the worker
        # floor, STOP COPYING new segments into scratch. We deliberately do NOT
        # advance ``last_extend`` (the recovery window bound) — it stays pinned
        # to the last MOMENT WE ACTUALLY COPIED, so any later finalize bounds
        # the clip to the footage that exists on disk rather than a window that
        # grew past it. The visit still finalizes normally on absence or at the
        # max-visit cap; it simply stops growing while the card is full.
        if self._disk_below_floor():
            free = self._free_space(self.recordings_dir)
            applog.emit(
                "visit",
                "disk floor: stopping copy-on-extend for visit {} — free "
                "space {} bytes < worker floor {} bytes; visit will finalize "
                "what it has".format(visit_id, free, self._min_free_bytes),
            )
            self._persist()
            clip_state.set_state(
                self.recordings_dir,
                visit_id,
                "recording",
                key=rec.get("key"),
                start_ts=rec.get("start_ts"),
                last_seen=now,
                last_extend=rec.get("last_extend"),
                disk_floor=True,
            )
            return
        rec["last_extend"] = end_ts
        # Incremental copy-on-extend (B3): copy completed ring segments into
        # the visit scratch BEFORE the ring can wrap them.
        scratch = scratch_dir_for(self.recordings_dir, visit_id)
        try:
            _new, accumulated = self._copy_segments(
                visit_id, rec["start_ts"], end_ts, scratch,
                self._copy_state.get(visit_id),
            )
            self._copy_state[visit_id] = accumulated
        except Exception as e:
            applog.emit(
                "visit",
                "ERROR copy-on-extend raised for visit {}: {}: {} (footage "
                "may be short)".format(visit_id, type(e).__name__, e),
            )
        self._persist()
        clip_state.set_state(
            self.recordings_dir,
            visit_id,
            "recording",
            key=rec.get("key"),
            start_ts=rec.get("start_ts"),
            last_seen=now,
            last_extend=end_ts,
        )

    def _on_finalize(self, tr, now):
        visit_id = tr["visit_id"]
        start_ts = tr["start_ts"]
        end_ts = tr["end_ts"]
        # Final catch-up copy (2026-07-07 replay-harness fix — tonight's prod
        # journal: "finalize: scratch_dir unreadable ... FileNotFoundError").
        # Two footage-loss holes shared one root cause: NOTHING copied ring
        # segments at finalize time. (a) A visit whose subject appeared on
        # exactly ONE frame never got an extend, so its scratch dir was never
        # created — finalize found nothing and the event's clip 404'd forever.
        # (b) The absence-grace tail after the LAST extend was never copied,
        # so the published clip ran ~absence_finalize_s shorter than its
        # nominal window — at the operator's 30s setting the duration check
        # (±10s) refused EVERY clip. The ring still holds this footage here
        # (tick fires with now >= end_ts and the grace tail is far shorter
        # than the ring window), so copy [start_ts, end_ts] before handing
        # off to the background finalize.
        self._catchup_copy(visit_id, start_ts, end_ts)
        self._open.pop(visit_id, None)
        self._copy_state.pop(visit_id, None)
        self._persist()
        self._spawn_finalize(visit_id, start_ts, end_ts)

    def _catchup_copy(self, visit_id, start_ts, end_ts):
        """One last incremental copy over the visit's FULL window, run
        synchronously on the finalize paths (absence/cap finalize AND the
        watchdog-escalation drain) before the concat thread takes over.
        Same disk-floor + error posture as ``_on_extend``: below the floor we
        skip (finalize what already exists), and a raise degrades to a short
        clip rather than crashing the loop."""
        if self._disk_below_floor():
            free = self._free_space(self.recordings_dir)
            applog.emit(
                "visit",
                "disk floor: skipping finalize catch-up copy for visit {} — "
                "free space {} bytes < worker floor {} bytes; finalizing "
                "what already copied".format(
                    visit_id, free, self._min_free_bytes,
                ),
            )
            return
        scratch = scratch_dir_for(self.recordings_dir, visit_id)
        try:
            _new, accumulated = self._copy_segments(
                visit_id, start_ts, end_ts, scratch,
                self._copy_state.get(visit_id),
            )
            self._copy_state[visit_id] = accumulated
        except Exception as e:
            applog.emit(
                "visit",
                "ERROR finalize catch-up copy raised for visit {}: {}: {} "
                "(clip may be short)".format(visit_id, type(e).__name__, e),
            )

    # -- finalize threading ---------------------------------------------------

    def _spawn_finalize(self, visit_id, start_ts, end_ts):
        """Spawn the background finalize (daemon thread by default), guarded so
        a visit is finalized at most once (de-dupe)."""
        if visit_id in self._finalizing_ids:
            return
        self._finalizing_ids.add(visit_id)
        # One increment per (de-duped) visit reaching finalize — the
        # single main-thread choke point for both the absence/cap path and
        # the watchdog-escalation path (plan S6 observability).
        self.visits_finalized += 1
        scratch = scratch_dir_for(self.recordings_dir, visit_id)
        clip_state.set_state(
            self.recordings_dir,
            visit_id,
            "finalizing",
            start_ts=start_ts,
            end_ts=end_ts,
            scratch_dir=scratch,
        )

        def _run():
            try:
                ok = bool(self._finalize_visit(visit_id, scratch, start_ts, end_ts))
                if not ok:
                    clip_state.set_state(
                        self.recordings_dir,
                        visit_id,
                        "failed",
                        start_ts=start_ts,
                        end_ts=end_ts,
                        reason="finalize_returned_false",
                    )
            except Exception as e:
                clip_state.set_state(
                    self.recordings_dir,
                    visit_id,
                    "failed",
                    start_ts=start_ts,
                    end_ts=end_ts,
                    reason="finalize_exception",
                    error_type=type(e).__name__,
                    error=str(e),
                )
                applog.emit(
                    "visit",
                    "ERROR finalize thread raised for visit {}: {}: {}".format(
                        visit_id, type(e).__name__, e,
                    ),
                )
            finally:
                self._finalizing_ids.discard(visit_id)

        self._spawn(_run, visit_id)

    def _spawn_thread(self, target, visit_id):
        t = threading.Thread(target=target, daemon=True,
                             name="finalize-" + str(visit_id))
        self._finalize_threads.add(t)
        # Reap dead refs opportunistically so the set doesn't grow unbounded.
        for dead in [x for x in self._finalize_threads if not x.is_alive()]:
            if dead is not t:
                self._finalize_threads.discard(dead)
        t.start()

    # -- watchdog coupling (R5) ----------------------------------------------

    def finalize_open_visits_for_escalation(self, now):
        """plan R5: the camera watchdog is about to restart mediamtx/nvargus or
        reboot. Finalize EVERY open visit immediately at its ``last_seen`` (a
        short VALID clip, not one spanning the wedge gap) and persist
        ``.open_visits.json`` BEFORE the reboot fires.

        Drains the tracker's live state too so a continuation opens fresh after
        recovery. Returns the list of finalized visit_ids."""
        finalized = []
        # Snapshot the tracker's live records to find last_seen per key.
        snap = self.tracker.snapshot()
        for key, vrec in snap.items():
            visit_id = vrec.get("visit_id")
            if visit_id is None:
                continue
            start_ts = vrec.get("start_ts")
            last_seen = vrec.get("last_seen", now)
            try:
                end_ts = min(float(last_seen), float(now))
            except (TypeError, ValueError):
                end_ts = now
            # Same catch-up copy as _on_finalize (a single-observe visit has
            # no scratch yet; the tail since the last extend isn't copied).
            # Bounded + best-effort, so it can't stall a pending reboot long.
            self._catchup_copy(visit_id, start_ts, end_ts)
            self._open.pop(visit_id, None)
            self._copy_state.pop(visit_id, None)
            self._spawn_finalize(visit_id, start_ts, end_ts)
            finalized.append(visit_id)
        # Reset the tracker so nothing is left mid-window (a continuation opens
        # on the next detection after recovery).
        self.tracker = VisitTracker(id_factory=self.tracker._id_factory)
        # Persist the now-drained table BEFORE the caller proceeds to reboot.
        self._persist()
        if finalized:
            applog.emit(
                "visit",
                "watchdog escalation: finalized {} open visit(s) at last_seen "
                "before recovery action: {}".format(
                    len(finalized), ",".join(str(v) for v in finalized),
                ),
            )
        return finalized

    # -- persistence ----------------------------------------------------------

    # Mirror the absence knob the last tick/observe used, so an open record
    # carries the value recovery should reuse. Updated by detect.py before each
    # observe via `set_absence_finalize_s`; defaults to the plan default.
    _last_absence_s = DEFAULT_ABSENCE_FINALIZE_S

    def set_absence_finalize_s(self, value):
        """Record the live absence knob so newly-opened visits persist it (used
        by recovery to bound the finalize window)."""
        try:
            v = float(value)
        except (TypeError, ValueError):
            return
        if v > 0:
            self._last_absence_s = v

    def _persist(self):
        write_open_visits(self.recordings_dir, self._open)
