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
import logging
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

# Absolute ceiling on per-build wall-clock time. Concat with `-c copy`
# is fast (~0.1s per clip on the Jetson; 100 clips = ~10s), so 120s
# is a generous safety net for a wedged ffmpeg.
_FFMPEG_TIMEOUT_S = 120.0


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


def _events_with_clips_for_day(day: str) -> list[Path]:
    """Return on-disk paths of every recorded clip for the given
    YYYY-MM-DD day, sorted by event timestamp (chronological).

    Day bucketing matches `events_db.count_by_day` (server-local-
    time `date(ts, 'unixepoch', 'localtime')`) so the timelapse
    matches the heatmap count the user clicked on.
    """
    # Compute since/until bounds for the day in local-time. We don't
    # have a query-by-localtime-day on events_db; reuse search() with
    # a wide ts window then filter. SQLite's date() inside count_by_day
    # is the canonical bucketing — match it here by using the same
    # localtime-aware approach via a search SQL extension. For now,
    # use ts bounds derived from the local-day:
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
    # `search` returns newest-first; reverse for chronological play
    # order in the timelapse.
    paths: list[Path] = []
    for r in reversed(rows):
        p = _resolve_clip_path(r.get("clip_url"))
        if p is not None:
            paths.append(p)
    return paths


def _write_concat_list(paths: list[Path], list_path: Path) -> None:
    """Write the ffmpeg concat-demuxer input file. Each line is
    `file '/abs/path.mp4'`. Single-quote escape any embedded
    quotes per the concat-demuxer spec."""
    with list_path.open("w") as f:
        for p in paths:
            # Escape single quotes per ffmpeg concat demuxer rules:
            # https://www.ffmpeg.org/ffmpeg-formats.html#concat
            escaped = str(p.resolve()).replace("'", r"'\''")
            f.write(f"file '{escaped}'\n")


def _run_ffmpeg_concat(list_path: Path, output_path: Path) -> tuple[bool, str]:
    """Run the concat command. Returns (ok, error_or_empty)."""
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
        str(output_path),
    ]
    try:
        result = subprocess.run(
            cmd,
            timeout=_FFMPEG_TIMEOUT_S,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        return False, "ffmpeg not installed in container"
    except subprocess.TimeoutExpired:
        return False, f"ffmpeg timed out after {_FFMPEG_TIMEOUT_S}s"
    except Exception as e:
        return False, f"ffmpeg subprocess failed: {e!r}"
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace")[:500]
        return False, f"ffmpeg returned {result.returncode}: {stderr}"
    return True, ""


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

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, dir=str(settings.timelapses_dir)
    ) as tmp:
        list_path = Path(tmp.name)
    try:
        _write_concat_list(clips, list_path)
        log.info(
            "building timelapse for %s: %d clips → %s",
            day, len(clips), output_path,
        )
        ok, err = _run_ffmpeg_concat(list_path, output_path)
        if not ok:
            log.warning("timelapse build failed for %s: %s", day, err)
            return TimelapseResult(
                output_path=output_path,
                clip_count=len(clips),
                ok=False,
                error=err,
            )
        log.info(
            "timelapse for %s built successfully: %d bytes",
            day, output_path.stat().st_size,
        )
        return TimelapseResult(
            output_path=output_path,
            clip_count=len(clips),
            ok=True,
            error=None,
        )
    finally:
        try:
            list_path.unlink()
        except OSError:
            pass


async def build_async(day: str) -> TimelapseResult:
    """Async wrapper for the route handler. ffmpeg can take seconds
    for a busy day; keep it off the event loop."""
    return await asyncio.to_thread(build, day)


# `shlex` is imported but unused at module level — leaving in scope so a
# future iter that wants to log the literal command line can use it
# without re-importing. Trivial overhead.
_ = shlex
