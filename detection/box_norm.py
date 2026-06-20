"""Normalize a jetson-inference detection bbox to fractional [0,1] frame coords.

iter-95 added a server-side `Box` model_validator that rejects payloads
where `x + w > 1 + eps`. The previous inline construction in
`detect.py` clamped each fractional coord *independently* to [0,1],
which is correct per-coord but leaves a bug at the sum level: if
jetson-inference returns `Right` slightly past frame width (a
sub-pixel network output at the edge), `x + w` can land at
`1 + sub-pixel` and the server's epsilon barely covers it.

This helper closes the loop. Clamping in pixel space *before* the
division gives:
  - 0 <= x, y, w, h <= 1
  - x + w <= 1 and y + h <= 1 (exact, no epsilon needed)

Defense-in-depth: server-side validator catches malformed/malicious
payloads; this helper guarantees the legitimate worker never has to
rely on the validator's tolerance.

Pure stdlib. Python-3.6 compatible (per the CLAUDE.md sharp edge —
this module is imported by detect.py which runs on JetPack 4.x's 3.6).
"""
import logging

log = logging.getLogger(__name__)


def normalize_box(left, top, right, bottom, frame_w, frame_h, label, score):
    """Build the dict event payload sub-document for one bbox.

    Args are jetson-inference's `d.Left` / `d.Top` / `d.Right` /
    `d.Bottom` in pixel coords plus the frame `width` / `height`.
    `label` and `score` are pass-throughs for the resulting dict.

    Returns a dict matching the server's `Box` schema:
        {"x", "y", "w", "h", "label", "score"}

    Raises ValueError if `frame_w` or `frame_h` is non-positive.
    """
    if frame_w <= 0 or frame_h <= 0:
        # Non-positive frame dims would divide-by-zero / invert the
        # normalization below; the ValueError propagates up into the
        # inference loop and kills detection. Log at ERROR (pipeline-
        # dead class) with the offending dims so the cause is visible
        # before the crash — the loop has no other failure record here.
        log.error(
            "normalize_box: non-positive frame dimensions "
            "(frame_w=%s, frame_h=%s) - inference loop will crash",
            frame_w, frame_h,
        )
        raise ValueError("frame dimensions must be positive")
    # Clamp in pixel space first — guarantees x + w <= 1 exactly,
    # without relying on the server validator's sub-pixel epsilon.
    fw = float(frame_w)
    fh = float(frame_h)
    left = max(0.0, min(fw, float(left)))
    right = max(left, min(fw, float(right)))
    top = max(0.0, min(fh, float(top)))
    bottom = max(top, min(fh, float(bottom)))
    return {
        "x": left / fw,
        "y": top / fh,
        "w": (right - left) / fw,
        "h": (bottom - top) / fh,
        "label": label,
        "score": float(score),
    }
