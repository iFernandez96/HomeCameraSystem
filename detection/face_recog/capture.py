"""iter-351/355a (user feature request): save the face crops the
classifier saw, organized by what it THOUGHT they were, so the
operator can sort + re-train without SSH-grepping JPEGs.

Layout (iter-355a adds sidecar JSON per crop):
    <capture_dir>/
        alice/                 ← what classifier called Alice
            1700000000000_evt-X.jpg
            1700000000000_evt-X.json   ← {predicted_name, confidence, event_id, ts_ms}
            1700000060000_evt-Y.jpg
            1700000060000_evt-Y.json
        bob/
        __unknown__/           ← faces the classifier matched to nothing

Workflow:
1. Operator reviews each name's directory periodically.
2. Misclassified files (e.g. a face the classifier called "alice" that's
   really "bob") are MOVED into the correct person's folder, OR into
   __unknown__/ if it's not a household member.
3. Curated examples (~10-20 per person) are copied back into
   `face_recog/known_faces/<NAME>/`.
4. Operator runs `python encode_known_faces.py` → updated encodings.pkl
5. `sudo systemctl restart homecam-detect` → worker reloads new model.

iter-355a sidecar JSON (1 per JPEG, same basename):
- Lets the iter-355b Tinder-card review UI show "73 % confident" on
  each crop instead of the binary "matched / unmatched".
- Carries event_id so the PWA can deep-link to the originating clip.
- Move/delete actions handle both files atomically.
- Backward-compat: missing sidecar → server treats as confidence=null,
  predicted_name=dirname.

Module is Python 3.6 compatible (CLAUDE.md sharp edge: detection/*.py
must stay 3.6-safe — no walrus, no PEP 604 unions, no f-strings with
`{x=}`, no list[int] generics). Uses os.* + pathlib.Path only.
"""
import json
import os
import re

# iter-351: cap each person-name directory at this many entries so a
# busy household doesn't fill the SD card with face JPEGs over time.
# At ~5 KB per face crop × 200 = ~1 MB per name, ~20 MB total at 20
# enrolled people. LRU sweep on mtime drops oldest when over cap.
DEFAULT_MAX_PER_DIR = 200

# iter-351: name sanitization. The recognizer's `name` comes from
# `encodings.pkl` keys (operator-controlled at training time). Defensive
# re-sanitization here closes the path-traversal door even if a future
# training script accepts arbitrary input. Anything not in the safe
# charset becomes `_`; empty result falls back to "__unknown__".
_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]")


def _sanitize_name(name):
    """Return a filesystem-safe directory name from `name`. Strings
    that contain only unsafe chars (or are empty) collapse to a sentinel.
    """
    if not name:
        return "__unknown__"
    safe = _SAFE_NAME_RE.sub("_", name).strip("_")
    return safe.lower() if safe else "__unknown__"


def save_face_capture(
    capture_dir,
    name,
    event_id,
    ts_ms,
    jpeg_bytes,
    max_per_dir=DEFAULT_MAX_PER_DIR,
    confidence=None,
    predicted_name=None,
):
    """Write `jpeg_bytes` to `<capture_dir>/<sanitized_name>/<ts_ms>_<event_id>.jpg`.
    iter-355a: also writes a sidecar `<filename>.json` with
    `{predicted_name, confidence, event_id, ts_ms}`.

    - `capture_dir` (str): root capture directory; created if missing.
    - `name` (str | None): what the classifier matched (or chose to file
      this crop under — the directory bucket); None / "" → __unknown__.
    - `event_id` (str): the iter-202 event id; appended to the filename
      so the operator can cross-reference with /api/events/{id}.
    - `ts_ms` (int): unix-epoch milliseconds; sortable filename prefix.
    - `jpeg_bytes` (bytes): pre-encoded JPEG bytes (caller does PIL/cv2 encode).
    - `max_per_dir` (int): LRU cap per person-name dir.
    - `confidence` (float | None, iter-355a): normalized 0..1 score
      from the matcher. None when the matcher was not loaded (dormant
      state) OR for bootstrap uploads. The Tinder-card review UI uses
      this to surface "73% confident" + sort by uncertainty.
    - `predicted_name` (str | None, iter-355a): what the classifier
      thought BEFORE the operator triaged. Distinct from the directory
      bucket (`name`) once the operator has moved a crop. Defaults to
      `name` when not specified, so the bucket-name appears as the
      prediction for organic captures.

    Returns the absolute path written (the JPEG, NOT the sidecar) or
    None on filesystem error. Designed to fail-quiet — the worker's
    hot path must not crash on a full disk or a permission error here.
    """
    if not jpeg_bytes:
        return None
    safe_name = _sanitize_name(name)
    target_dir = os.path.join(capture_dir, safe_name)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError:
        return None
    # Sanitize event_id too (defensive — should already be safe per
    # `recording_service._VALID_EVENT_ID` but recognizer doesn't import
    # that module).
    safe_event = _SAFE_NAME_RE.sub("_", event_id) if event_id else "x"
    base = "{}_{}".format(int(ts_ms), safe_event)
    target_path = os.path.join(target_dir, base + ".jpg")
    sidecar_path = os.path.join(target_dir, base + ".json")
    # iter-353a (security-auditor F2): face crops are biometric data of
    # household members. open() with default umask=022 yields 0o644
    # (world-readable). If a future change adds another process to the
    # container or the host, every face crop becomes readable without
    # capability check. os.open with explicit mode 0o600 atomically
    # restricts at create time. Same pattern as iter-183 users.db.
    try:
        fd = os.open(
            target_path,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, jpeg_bytes)
        finally:
            os.close(fd)
    except OSError:
        return None

    # iter-355a: write the sidecar JSON. Failure here is non-fatal —
    # the JPEG already wrote. Sidecar absent = server treats as
    # legacy capture (confidence=null, predicted_name=dirname).
    sidecar = {
        "predicted_name": (
            predicted_name if predicted_name is not None else (
                name if name else None
            )
        ),
        "confidence": confidence,
        "event_id": event_id,
        "ts_ms": int(ts_ms),
    }
    try:
        fd = os.open(
            sidecar_path,
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, json.dumps(sidecar, sort_keys=True).encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        # Best-effort sidecar; JPEG write succeeded.
        pass

    # LRU sweep: if over cap, drop oldest by mtime. Cheap because we
    # only stat when we actually exceed — the typical write doesn't
    # walk the directory. iter-355a: sweep also drops the matching
    # sidecar when it evicts a JPEG, so /tmp doesn't accumulate
    # orphaned `.json` files.
    try:
        _enforce_cap(target_dir, max_per_dir)
    except OSError:
        # Sweep failure is non-fatal; the write succeeded.
        pass
    return target_path


def _enforce_cap(directory, max_files):
    """LRU eviction by mtime. Drops oldest .jpg files until count <= max_files.
    iter-355a: also drops the matching `.json` sidecar so we don't
    accumulate orphaned metadata."""
    entries = []
    for entry in os.listdir(directory):
        if not entry.endswith(".jpg"):
            continue
        full = os.path.join(directory, entry)
        try:
            st = os.stat(full)
        except OSError:
            continue
        entries.append((st.st_mtime, full))
    if len(entries) <= max_files:
        return
    # Sort oldest-first; drop the excess.
    entries.sort()
    excess = len(entries) - max_files
    for _, path in entries[:excess]:
        try:
            os.remove(path)
        except OSError:
            pass
        # Match sidecar (filename without `.jpg`, suffix `.json`).
        sidecar = path[:-4] + ".json"
        try:
            os.remove(sidecar)
        except OSError:
            # Sidecar may not exist (legacy capture pre-iter-355a).
            pass
