"""Camera identity for the detection worker (docs/multicam_contract.md).

The multicam contract threads a camera DIMENSION through all three
tiers; the worker's slice is: read ``DETECT_CAMERA_ID`` from the
environment ONCE at startup and stamp it into every
``/api/_internal/event`` payload as ``"camera_id"``.

Pure + stdlib-only so it unit-tests with the Jetson off (CLAUDE.md
engineering principle 2). Must stay Python 3.6 compatible — guarded by
``tests/test_py36_compat.py``.
"""
import logging
import os
import re

log = logging.getLogger(__name__)

# Contract default: a fresh single-camera deploy with no env set is the
# "front_door" camera on BOTH tiers (server DetectionPayload defaults to
# the same id).
DEFAULT_CAMERA_ID = "front_door"

# Mirrors the server-side registry id rule (multicam_contract.md:
# `id`: ^[a-z0-9_]{1,32}$).
_CAMERA_ID_PATTERN = "^[a-z0-9_]{1,32}$"
_CAMERA_ID_RE = re.compile(_CAMERA_ID_PATTERN)


def resolve_camera_id(raw):
    """Validate a raw env value into a camera id. NEVER raises.

    Absent/empty is silent (unset is the normal single-camera deploy)
    and yields the default. An invalid value logs a WARN naming the
    operation + reason and falls back to the default — a typo'd unit
    file must not brick the worker at boot.
    """
    if raw is None or raw == "":
        return DEFAULT_CAMERA_ID
    if _CAMERA_ID_RE.match(raw):
        return raw
    log.warning(
        "camera_id resolve: DETECT_CAMERA_ID %r rejected (must match %s); "
        "falling back to %r",
        raw, _CAMERA_ID_PATTERN, DEFAULT_CAMERA_ID,
    )
    return DEFAULT_CAMERA_ID


def camera_id_from_env(environ=None):
    """Read + validate ``DETECT_CAMERA_ID`` (call once at startup).

    ``environ`` is injectable for tests; defaults to ``os.environ``.
    """
    env = os.environ if environ is None else environ
    return resolve_camera_id(env.get("DETECT_CAMERA_ID"))
