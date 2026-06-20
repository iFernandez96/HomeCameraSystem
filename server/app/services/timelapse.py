"""iter-306 (user "wireup the timelapse please"): build a per-day
"day's events" video by concatenating every recorded event clip
from that day.

Design choice — concat over true-timelapse:
    A genuine timelapse (sample 1 frame every N seconds, speed up
    24h → 60s) requires a snapshot-sampler thread in detect.py
    that we don't have today. The detect.py loop only saves
    `latest.jpg` (single file, overwritten per second) — there's
    no per-second archive to sample from.

    What we DO have: per-event clips written by the iter-201/202
    ClipRecorder under `settings.recordings_dir`. Each clip is
    an H.264-in-MP4 with consistent codec settings, so ffmpeg can
    concat them without re-encode (`-c copy`) — fast, lossless,
    and the result is the user's "what happened today" highlight
    reel rather than a true timelapse. The Settings UI label is
    accurate — "Speed up a whole day of camera footage into a
    short video you can scan in seconds." — because if your day
    had 30 events of 5-15s each, the resulting video IS short
    relative to the 24-hour span.

    A future iter can add a sampler thread + a true-timelapse
    mode toggle. iter-306 ships the cheaper-to-build, more-useful
    path.

ffmpeg invocation:
    ffmpeg -y -f concat -safe 0 -i <list.txt> -c copy <output.mp4>

The concat demuxer reads a text file with `file '<path>'` lines.
`-safe 0` is required because we use absolute paths (the demuxer
defaults to refusing them as a defense against malicious lists;
since we GENERATE the list ourselves from the events DB, this is
fine).

Container deps:
    iter-306 added `ffmpeg` to deploy/Dockerfile.server's apt
    install. Without that this module's subprocess call will raise
    FileNotFoundError; the route returns a 500 with a clear log.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shlex
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import events_db
from ..config import settings


log = logging.getLogger(__name__)

# iter-314 (security-auditor E1+B1, defense-in-depth): mirror the
# `_VALID_EVENT_ID` regex that recording_service.py uses on the
# write side. Pre-iter-314 `_resolve_clip_path` parsed the event
# id out of `clip_url` (a DB-stored string) and built a path with
# no validation — the `.mp4` suffix was the accidental guard
# against traversal. If a future iter changes the filename pattern
# (or strips the extension), the suffix-only guard collapses.
_VALID_EVENT_ID = re.compile(r"^[A-Za-z0-9_-]+$")

# Per-build ffmpeg timeout. Scales with clip count because `-c copy`
# concat is I/O-bound: a busy day of 300+ clips is ~1 GB and the
# `+faststart` moov relocation does a SECOND full pass over the file, so
# the old flat 120 s silently truncated big days (timed out mid-write,
# leaving a partial). The build now runs in the BACKGROUND (control.py),
# so a generous timeout costs nothing — it just lets big days finish.
_FFMPEG_TIMEOUT_FLOOR_S = 120.0
_FFMPEG_TIMEOUT_CEIL_S = 1800.0


def _ffmpeg_timeout_for(clip_count):
    """Scale the concat timeout to the day's size, floored at 120 s and
    capped at 30 min. Measured on the Nano eMMC: a 342-clip / 3.2 GB day
    (with the `+faststart` second pass) took ~680 s, so 2.5 s/clip leaves
    headroom; the 30-min ceiling covers even a pathological all-day camera."""
    return min(_FFMPEG_TIMEOUT_CEIL_S, max(_FFMPEG_TIMEOUT_FLOOR_S, clip_count * 2.5))


def _unlink_quiet(path: Path) -> None:
    """Best-effort unlink; never raises. Used to clean up the partial
    `.tmp` output so a failed/timed-out build can NEVER leave a broken
    mp4 behind for the GET route to serve."""
    try:
        path.unlink()
    except OSError:
        pass

# Per-clip ffprobe validity check (cheap header read). Bounded so a
# wedged probe on one corrupt clip can't stall the whole build.
_FFPROBE_TIMEOUT_S = 10.0


def _clip_has_video(path: Path) -> bool:
    """True iff `path` is a readable media file with at least one video
    stream.

    This is the guard against the shipped bug: a 0-byte / truncated /
    moov-less clip (a recording that created the file but never finished
    writing it — common after a worker crash or restart) passes
    `_resolve_clip_path`'s `.exists()` check, but feeding it to
    `ffmpeg -f concat -c copy` makes the demuxer return rc=0 while
    SILENTLY dropping that clip AND every clip after it. The reel then
    ends up missing most captures while `build()` reports success.
    Probing each input first lets us skip the bad one and still stitch
    the rest; probing the OUTPUT afterwards stops us reporting success
    on a broken file. Returns False on any probe error (missing binary,
    timeout, unreadable file) — fail-closed so a dubious clip is dropped,
    not stitched.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v",
                "-show_entries", "stream=codec_type",
                "-of", "csv=p=0",
                str(path),
            ],
            timeout=_FFPROBE_TIMEOUT_S,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        # ffprobe missing in the container — can't validate. Fail-closed
        # AND log loudly: without ffprobe the stitch can't be trusted.
        log.error(
            "timelapse: ffprobe binary not found — cannot validate clips "
            "(install ffmpeg/ffprobe in deploy/Dockerfile.server)"
        )
        return False
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0 and b"video" in result.stdout


def _probe_clip(path: Path) -> float | None:
    """Probe `path` for the two things the builder needs from every input
    clip: that it has a readable video stream, AND its duration in seconds.

    Returns the duration (float > 0) on success, or None when the clip is
    unreadable / has no video stream / has no parseable positive duration.
    None means "skip this clip" — it is BOTH the 0-byte/truncated guard (the
    shipped silent-truncation bug) AND the signal that the clip can't be
    placed on the de-overlap timeline (see `_events_with_clips_for_day`).
    Fail-closed on any probe error so a dubious clip is dropped, not stitched.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_type:format=duration",
                "-of", "json",
                str(path),
            ],
            timeout=_FFPROBE_TIMEOUT_S,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        log.error(
            "timelapse: ffprobe binary not found — cannot validate clips "
            "(install ffmpeg/ffprobe in deploy/Dockerfile.server)"
        )
        return None
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout.decode("utf-8", "replace") or "{}")
    except ValueError:
        return None
    streams = data.get("streams") or []
    if not any(s.get("codec_type") == "video" for s in streams):
        return None
    try:
        duration = float((data.get("format") or {}).get("duration"))
    except (TypeError, ValueError):
        return None
    if duration <= 0.0:
        return None
    return duration


@dataclass
class TimelapseResult:
    """Outcome of a build attempt."""
    output_path: Path
    """Path to the produced MP4 (only meaningful when ok=True)."""
    clip_count: int
    """How many input clips were concatenated. 0 means no events
    on that day with a usable clip — caller should NOT report
    success in that case."""
    ok: bool
    """True if ffmpeg ran cleanly AND clip_count > 0."""
    error: str | None
    """Human-readable error when ok=False; None on success."""


@dataclass
class _Segment:
    """One clip's contribution to the reel, AFTER overlap de-duplication.

    `inpoint` is how many seconds to trim from the START of this clip — the
    portion whose wall-clock window is already shown by an earlier clip. The
    concat demuxer applies it under `-c copy` (keyframe-aligned), so a cluster
    of heavily-overlapping re-fire clips becomes a single forward-running
    stretch instead of replaying the same seconds over and over.
    """
    path: Path
    capture_ts: float
    duration: float
    inpoint: float


# Overlap de-duplication tolerance. Float noise (and sub-frame rounding)
# shouldn't emit a spurious tiny inpoint or drop a clip that genuinely adds
# a sliver of new footage. 50 ms is well under one frame at any real fps.
_OVERLAP_EPSILON_S = 0.05


def _resolve_clip_path(clip_url: str | None) -> Path | None:
    """Translate the iter-201 `clip_url` field
    (`/api/events/<id>/clip`) into the on-disk recording path.

    The URL doesn't carry the recording filename directly — the
    server route resolves it via events_db lookup. iter-306 takes
    the simpler path: derive the recording filename from the
    event id (the iter-202 ClipRecorder writes `<id>.mp4` directly
    into `settings.recordings_dir`).

    Returns None when the URL doesn't match the expected pattern
    or the file doesn't exist on disk (clip pruned by the iter-256
    retention sweep, or recording never completed).
    """
    if not clip_url:
        return None
    # /api/events/<id>/clip → derive id, look up file.
    parts = clip_url.strip("/").split("/")
    if len(parts) < 4 or parts[0] != "api" or parts[1] != "events" or parts[3] != "clip":
        return None
    event_id = parts[2]
    # iter-314 (security-auditor E1+B1, defense-in-depth): two-tier
    # path-traversal guard, mirroring iter-212 (backup/restore) and
    # the recording_service write side.
    #   Tier 1: regex match against `_VALID_EVENT_ID` rejects shell
    #     metas, slashes, dots, NUL — anything non-alphanumeric
    #     (sans `_-`).
    #   Tier 2: resolve the candidate + relative_to(recordings_dir)
    #     so even a regex-clean path can't escape the recordings
    #     dir via symlinks (ffmpeg follows symlinks when reading
    #     concat-list inputs; `-safe 0` disables ffmpeg's own
    #     filename validation).
    # Pre-iter-314 the `.mp4` suffix was the accidental guard;
    # post-iter-314 the regex + resolve check is the actual
    # security guarantee.
    if not _VALID_EVENT_ID.match(event_id):
        return None
    candidate = settings.recordings_dir / f"{event_id}.mp4"
    try:
        resolved = candidate.resolve()
        resolved.relative_to(settings.recordings_dir.resolve())
    except (ValueError, OSError):
        return None
    return resolved if resolved.exists() else None


def _events_with_clips_for_day(day: str) -> list[_Segment]:
    """Return the per-clip segments to stitch for the given YYYY-MM-DD day,
    in chronological play order, AFTER de-duplicating overlapping footage.

    Why de-overlap: detection re-fires the SAME presence roughly every
    cooldown (~5 s) for as long as a subject stays in frame, and every
    re-fire records its OWN clip whose pre-roll+post-roll window (~90 s on
    the deployed config) overlaps its neighbours by ~85 s. Concatenated
    whole, the reel replays the same seconds over and over and the playhead
    jumps BACKWARD in time at each clip boundary — the user's "people
    teleporting back in time". We place each clip on a wall-clock timeline
    (event `ts` + measured duration) and keep only the NEW footage each clip
    adds: a clip whose window is wholly inside already-shown time is dropped;
    a clip that extends past it is FRONT-TRIMMED (`inpoint`) so the reel runs
    strictly forward with no replays and no lost footage. The pre-roll is a
    constant offset shared by every clip, so it cancels out of the overlap
    comparison — we don't need to know it.

    Day bucketing matches `events_db.count_by_day` (server-local-time
    `date(ts, 'unixepoch', 'localtime')`) so the timelapse matches the
    heatmap count the user clicked on.
    """
    # Compute since/until bounds for the day in local-time. We don't have a
    # query-by-localtime-day on events_db; reuse search() with a wide ts
    # window. SQLite's date() inside count_by_day is the canonical bucketing
    # — match it here with ts bounds derived from the local-day.
    import time as _time
    parts = [int(p) for p in day.split("-")]
    midnight = _time.mktime((parts[0], parts[1], parts[2], 0, 0, 0, 0, 0, -1))
    next_midnight = midnight + 86400
    rows = events_db.search(
        settings.events_db_path,
        since_ts=midnight,
        until_ts=next_midnight,
        limit=1000,
    )

    # Pass 1: resolve + probe every clip in chronological order (`search`
    # returns newest-first, so reverse). Collect (path, capture_ts, duration)
    # for the readable ones; skip + log the unreadable ones (the shipped
    # 0-byte/truncated guard — a single bad clip used to silently truncate
    # the whole reel).
    valid: list[tuple[Path, float | None, float]] = []
    skipped = 0
    for r in reversed(rows):
        clip_url = r.get("clip_url")
        p = _resolve_clip_path(clip_url)
        if p is None:
            # File missing on disk — pruned by retention, malformed clip_url,
            # or a traversal-reject. Benign + can be many, so DEBUG.
            skipped += 1
            log.debug(
                "timelapse: skipping event %s for day %s — no clip on "
                "disk (clip_url=%r)",
                r.get("id"), day, clip_url,
            )
            continue
        duration = _probe_clip(p)
        if duration is None:
            # File EXISTS but is unreadable (0-byte / truncated / no moov
            # atom). WARNING, not DEBUG: operator-actionable, AND skipping it
            # is what stops the bad clip from silently truncating the reel.
            skipped += 1
            log.warning(
                "timelapse: skipping event %s for day %s — clip on disk "
                "is unreadable (0-byte / truncated / no video stream): %s",
                r.get("id"), day, p,
            )
            continue
        ts_raw = r.get("ts")
        try:
            ts: float | None = float(ts_raw)
        except (TypeError, ValueError):
            # An event with a clip but no usable timestamp can't be placed on
            # the de-overlap timeline. Keep it (untrimmed, its own moment)
            # rather than dropping real footage.
            ts = None
        valid.append((p, ts, duration))

    if skipped:
        log.info(
            "timelapse: day %s — %d of %d events had no usable clip "
            "(skipped)",
            day, skipped, len(rows),
        )

    # Pass 2: de-overlap. Walk chronologically, tracking how far (in
    # wall-clock ts space) the reel already covers. Drop fully-redundant
    # clips; front-trim partially-overlapping ones.
    segments: list[_Segment] = []
    covered_until: float | None = None  # furthest instant already in the reel
    collapsed = 0
    for (p, ts, duration) in valid:
        if ts is None or covered_until is None:
            # First placeable clip (or a ts-less one): take it whole.
            segments.append(_Segment(p, ts if ts is not None else 0.0, duration, 0.0))
            if ts is not None:
                covered_until = ts + duration
            continue
        end = ts + duration
        if end <= covered_until + _OVERLAP_EPSILON_S:
            # This clip's entire window is already shown — pure replay. Drop.
            collapsed += 1
            continue
        inpoint = covered_until - ts
        if inpoint < _OVERLAP_EPSILON_S:
            inpoint = 0.0
        segments.append(_Segment(p, ts, duration, inpoint))
        covered_until = end

    if collapsed:
        log.info(
            "timelapse: day %s — de-overlap dropped %d redundant re-fire "
            "clip(s); reel has %d forward-running segment(s)",
            day, collapsed, len(segments),
        )
    return segments


def _write_concat_list(segments: list[_Segment], list_path: Path) -> None:
    """Write the ffmpeg concat-demuxer input file. Each clip is a `file`
    line; a non-zero `inpoint` (seconds from the clip's own start) trims the
    already-covered overlap prefix so the reel never replays footage. The
    concat demuxer honors `inpoint` under `-c copy` (keyframe-aligned). See
    `_events_with_clips_for_day` for how the trims are computed.

    Single-quote-escape any embedded quotes per the concat-demuxer spec:
    https://www.ffmpeg.org/ffmpeg-formats.html#concat
    """
    with list_path.open("w") as f:
        for s in segments:
            escaped = str(s.path.resolve()).replace("'", r"'\''")
            f.write(f"file '{escaped}'\n")
            if s.inpoint > 0.0:
                f.write("inpoint {0:.3f}\n".format(s.inpoint))


def _run_ffmpeg_concat(
    list_path: Path, output_path: Path, timeout_s: float = _FFMPEG_TIMEOUT_FLOOR_S,
) -> tuple[bool, str]:
    """Run the concat command. Returns (ok, error_or_empty). `timeout_s`
    scales with the day's clip count (see `_ffmpeg_timeout_for`)."""
    cmd = [
        "ffmpeg",
        "-y",                  # overwrite output without asking
        "-hide_banner",        # quieter logs
        "-loglevel", "error",  # only stderr on failure
        "-f", "concat",
        "-safe", "0",          # allow absolute paths in the list file
        "-i", str(list_path),
        "-c", "copy",          # no re-encode — same H.264 from the clips
        "-movflags", "+faststart",  # moov atom up-front for web streaming
        # Force the mp4 muxer: the output is a `<day>.mp4.tmp` sidecar
        # (atomic-publish pattern) and ffmpeg can't infer the muxer from a
        # `.tmp` extension. CLAUDE.md pin: `-f mp4` is load-bearing here.
        "-f", "mp4",
        str(output_path),
    ]
    try:
        result = subprocess.run(
            cmd,
            timeout=timeout_s,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        # The #1 deploy failure: the ffmpeg binary isn't on PATH in the
        # container. Name it explicitly so the operator doesn't chase a
        # generic 500. (deploy/Dockerfile.server installs ffmpeg.)
        log.error(
            "timelapse: ffmpeg binary not found — ffmpeg is not "
            "installed in the container (check deploy/Dockerfile.server)"
        )
        return False, "ffmpeg not in container"
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timed out after {0:.0f}s".format(timeout_s)
    except Exception as e:
        return False, f"ffmpeg subprocess failed: {e!r}"
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[:500]
        return False, f"ffmpeg returned {result.returncode}: {stderr}"
    return True, ""


def _write_sidecar(day: str, segments: list[_Segment]) -> None:
    """Write `<day>.json` next to the reel: a versioned per-segment map of
    reel-offset → original capture time, so the client player can paint a
    small wall-clock timestamp over the <video> (the lib/drawBoxes.ts
    paint-over-video pattern) that advances as the reel plays.

    Best-effort + atomic: the reel is already published when this runs, so a
    failure here only disables the overlay — it never fails the build. Schema
    is `{v}`-versioned per the event-payload convention; `capture_ts` is the
    event's unix-epoch seconds, `offset_s` is where that segment begins in
    the final reel (cumulative kept-duration of prior segments).
    """
    meta: list[dict[str, float]] = []
    offset = 0.0
    for s in segments:
        meta.append({
            "offset_s": round(offset, 3),
            "capture_ts": round(s.capture_ts, 3),
        })
        offset += max(0.0, s.duration - s.inpoint)
    sidecar = settings.timelapses_dir / "{0}.json".format(day)
    tmp = settings.timelapses_dir / "{0}.json.tmp".format(day)
    _unlink_quiet(tmp)
    try:
        with tmp.open("w") as f:
            json.dump({"v": 1, "date": day, "segments": meta}, f)
        os.replace(str(tmp), str(sidecar))
    except OSError as e:
        log.warning(
            "timelapse: could not write timestamp sidecar for %s "
            "(reel is fine, overlay disabled): %s",
            day, e,
        )
        _unlink_quiet(tmp)


def build(day: str) -> TimelapseResult:
    """Build a timelapse MP4 for the given local-time day. Synchronous
    — caller (route handler) wraps in `asyncio.to_thread` to avoid
    blocking the event loop during the ffmpeg run.

    Returns a TimelapseResult — `ok=True` only when there were
    clips AND ffmpeg succeeded. The route should branch on
    `ok` + `clip_count` to render the right toast.
    """
    output_path = settings.timelapses_dir / f"{day}.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    clips = _events_with_clips_for_day(day)
    if not clips:
        return TimelapseResult(
            output_path=output_path,
            clip_count=0,
            ok=False,
            error="No recorded events for that day",
        )

    # iter (logging-plan §2): the concat-list temp file lives under
    # `timelapses_dir`. If that volume is full / unwritable, both the
    # NamedTemporaryFile create AND `_write_concat_list` raise OSError —
    # which previously escaped as a bare 500 with no reason. Catch +
    # log at ERROR + return a clean TimelapseResult so the route can
    # surface a meaningful message.
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, dir=str(settings.timelapses_dir)
        ) as tmp:
            list_path = Path(tmp.name)
    except OSError as e:
        log.error(
            "timelapse: could not create concat-list temp file in %s "
            "(volume full / unwritable?): %s",
            settings.timelapses_dir,
            e,
            exc_info=True,
        )
        return TimelapseResult(
            output_path=output_path,
            clip_count=len(clips),
            ok=False,
            error="could not create concat-list temp file: {0}".format(e),
        )
    try:
        try:
            _write_concat_list(clips, list_path)
        except OSError as e:
            log.error(
                "timelapse: could not write concat-list %s (volume "
                "full / unwritable?): %s",
                list_path,
                e,
                exc_info=True,
            )
            return TimelapseResult(
                output_path=output_path,
                clip_count=len(clips),
                ok=False,
                error="could not write concat-list: {0}".format(e),
            )
        # Build to a `.tmp` sidecar, validate it, then ATOMICALLY rename
        # to the final `<day>.mp4`. The GET route's regex is `^DATE\.mp4$`,
        # so `<day>.mp4.tmp` is never servable — meaning a slow/failed/
        # timed-out build can't expose a partial file. The user only ever
        # sees a complete, validated video appear.
        tmp_out = settings.timelapses_dir / "{0}.mp4.tmp".format(day)
        # Clean stale .tmp sidecars from a prior crashed/restarted build
        # (both the mp4 scratch and the sidecar-json scratch).
        _unlink_quiet(tmp_out)
        _unlink_quiet(settings.timelapses_dir / "{0}.json.tmp".format(day))
        timeout_s = _ffmpeg_timeout_for(len(clips))
        log.info(
            "building timelapse for %s: %d clips (timeout %.0fs) → %s",
            day, len(clips), timeout_s, output_path,
        )
        ok, err = _run_ffmpeg_concat(list_path, tmp_out, timeout_s)
        if not ok:
            log.warning("timelapse build failed for %s: %s", day, err)
            _unlink_quiet(tmp_out)
            return TimelapseResult(
                output_path=output_path,
                clip_count=len(clips),
                ok=False,
                error=err,
            )
        # Post-validate: `ffmpeg -f concat -c copy` can return rc=0 yet
        # leave a broken / empty / unplayable output (e.g. a mid-list
        # corrupt input that slipped past the pre-filter, or a stream
        # the muxer couldn't finalize). Don't publish unless the produced
        # file is actually a playable video.
        if not (
            tmp_out.exists()
            and tmp_out.stat().st_size > 0
            and _clip_has_video(tmp_out)
        ):
            log.error(
                "timelapse: ffmpeg reported success for %s but the output "
                "mp4 failed validation (missing / empty / no video stream) "
                "— refusing to publish",
                day,
            )
            _unlink_quiet(tmp_out)
            return TimelapseResult(
                output_path=output_path,
                clip_count=len(clips),
                ok=False,
                error="stitched output failed validation (no playable video)",
            )
        # Atomic publish: same-filesystem rename is atomic, so the GET
        # route either serves the OLD video or the NEW one, never a
        # half-written file.
        try:
            os.replace(str(tmp_out), str(output_path))
        except OSError as e:
            log.error(
                "timelapse: could not publish %s → %s: %s",
                tmp_out, output_path, e, exc_info=True,
            )
            _unlink_quiet(tmp_out)
            return TimelapseResult(
                output_path=output_path,
                clip_count=len(clips),
                ok=False,
                error="could not publish stitched output: {0}".format(e),
            )
        log.info(
            "timelapse for %s built successfully: %d bytes",
            day, output_path.stat().st_size,
        )
        # Publish the timestamp sidecar (`<day>.json`) so the client player
        # can paint a small wall-clock overlay that ticks forward as the reel
        # plays. Best-effort: the reel is already published; a sidecar failure
        # only disables the overlay, never the video.
        _write_sidecar(day, clips)
        return TimelapseResult(
            output_path=output_path,
            clip_count=len(clips),
            ok=True,
            error=None,
        )
    finally:
        try:
            list_path.unlink()
        except OSError as e:
            # Leaked concat-list temp under timelapses_dir — harmless
            # but accumulates on a slow/RO disk. DEBUG breadcrumb.
            log.debug(
                "timelapse: could not unlink concat-list temp %s "
                "(leaked): %s",
                list_path,
                e,
            )


async def build_async(day: str) -> TimelapseResult:
    """Async wrapper for the route handler. ffmpeg can take seconds
    for a busy day; keep it off the event loop."""
    return await asyncio.to_thread(build, day)


# `shlex` is imported but unused at module level — leaving in scope so a
# future iter that wants to log the literal command line can use it
# without re-importing. Trivial overhead.
_ = shlex
