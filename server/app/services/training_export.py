"""iter-356.6X (tiered-inference slice 2): export-time letterbox normalizer
for the training-data pipeline.

The detection worker writes face + person crops at their *native* bbox
dimensions under `settings.face_captures_dir` / `settings.person_captures_dir`,
each paired with a JSON sidecar (schema_version v1 or v2). Trainers want a
consistently-sized, aspect-preserved set; rather than rewriting every JPEG
on disk this module reads them on demand and streams a ZIP of letterboxed
PNGs + a `manifest.csv` describing the geometric transform applied to
each frame.

No on-disk JPEG mutation. Truncated / corrupt files are skipped, not
500'd. PIL is the only non-stdlib dep.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import zipfile
from pathlib import Path
from typing import Callable, Iterator, Optional, Tuple

from PIL import Image, UnidentifiedImageError

log = logging.getLogger(__name__)


# Manifest columns. Stable wire shape — clients (or downstream training
# scripts) parse this CSV; new columns must be appended, never inserted.
MANIFEST_COLUMNS = (
    "filename",
    "predicted_name",
    "confidence",
    "source_w",
    "source_h",
    "scale",
    "pad_x",
    "pad_y",
    "event_id",
    "ts_ms",
    "sw_rev",
)


def letterbox(
    img: Image.Image,
    size: int,
    fill: Tuple[int, int, int] = (114, 114, 114),
) -> Tuple[Image.Image, float, int, int]:
    """Resize `img` into a square `size`x`size` canvas, preserving aspect
    ratio and padding the unused area with `fill`.

    Returns ``(canvas, scale, pad_x, pad_y)`` so callers can record the
    exact transform in a manifest. Scale is the multiplier applied to BOTH
    source dimensions; pad_x / pad_y are the symmetric pixel insets on the
    left and top of the canvas (right/bottom may differ by 1px when the
    rounded image dims have opposite parity from `size`).

    Aspect ratio preserved within ±1px (rounding). Square inputs return
    pad_x == pad_y == 0. Tiny inputs are upscaled with bicubic resampling
    so the canvas is fully populated.
    """
    if img.mode != "RGB":
        img = img.convert("RGB")
    src_w, src_h = img.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError("non-positive image dimensions: {0}x{1}".format(src_w, src_h))
    scale = min(size / src_w, size / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    # Clamp to canvas (rounding can overshoot by 1px on rare inputs).
    new_w = min(new_w, size)
    new_h = min(new_h, size)
    resized = img.resize((new_w, new_h), Image.BICUBIC)
    canvas = Image.new("RGB", (size, size), fill)
    pad_x = (size - new_w) // 2
    pad_y = (size - new_h) // 2
    canvas.paste(resized, (pad_x, pad_y))
    return canvas, scale, pad_x, pad_y


def iter_capture_files(
    root: Path,
    kind: str,
    include_unknown: bool = True,
) -> Iterator[Tuple[Path, dict]]:
    """Walk `root` (a per-kind capture directory) yielding ``(jpeg_path,
    sidecar_dict)`` pairs.

    Layout matches detection/face_recog/capture.py:
        <root>/<name>/<ts_ms>_<event_id>.jpg
        <root>/<name>/<ts_ms>_<event_id>.json

    A JPEG without its `.json` sidecar, or with a sidecar that fails to
    parse, is skipped (logged at WARNING). The `__unknown__` bucket is
    included by default; pass `include_unknown=False` to skip it.

    `kind` is currently informational (face vs person); both share the
    same on-disk shape.
    """
    del kind  # reserved for future per-kind filtering
    if not root.is_dir():
        return
    for name_dir in sorted(root.iterdir()):
        if not name_dir.is_dir():
            continue
        if not include_unknown and name_dir.name == "__unknown__":
            continue
        for jpeg in sorted(name_dir.glob("*.jpg")):
            sidecar = jpeg.with_suffix(".json")
            if not sidecar.is_file():
                # Worker may be mid-write; skip silently to avoid log spam.
                continue
            try:
                with sidecar.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError, UnicodeDecodeError) as exc:
                log.warning("training-export: skipping %s — corrupt sidecar (%s)", jpeg, exc)
                continue
            if not isinstance(data, dict):
                log.warning("training-export: skipping %s — sidecar not a dict", jpeg)
                continue
            yield jpeg, data


def build_export_zip(
    root: Path,
    kind: str,
    size: int,
    name_filter: Optional[Callable[[str], bool]] = None,
    max_entries: int = 5000,
) -> Tuple[bytes, dict]:
    """Build the export ZIP in memory. Returns ``(zip_bytes, summary)``.

    `summary` carries `count`, `skipped`, and `truncated` (True if the
    walk hit `max_entries` and stopped). The route layer turns
    `truncated=True` into HTTP 413 — the helper itself never raises on
    overflow, it just stops collecting.

    `name_filter(name)` is called with the per-name bucket directory (e.g.
    "alice", "__unknown__") and may return False to exclude it. None means
    include all.
    """
    if size <= 0:
        raise ValueError("size must be positive, got {0}".format(size))

    buf = io.BytesIO()
    manifest_rows = []
    count = 0
    skipped = 0
    truncated = False

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for jpeg, sidecar in iter_capture_files(root, kind):
            bucket = jpeg.parent.name
            if name_filter is not None and not name_filter(bucket):
                continue
            if count >= max_entries:
                truncated = True
                break
            try:
                with Image.open(jpeg) as src:
                    src.load()
                    src_w, src_h = src.size
                    canvas, scale, pad_x, pad_y = letterbox(src, size)
            except (UnidentifiedImageError, OSError, ValueError) as exc:
                # ValueError: `letterbox()` raises it on a zero-dim
                # image (a 0-byte / 0xN crop the worker wrote mid-race).
                # Previously uncaught → it 500'd the ENTIRE export ZIP,
                # losing every other valid crop. Skip+log this one image
                # instead so the rest of the export still streams.
                log.warning("training-export: skipping %s — bad image (%s)", jpeg, exc)
                skipped += 1
                continue

            png_buf = io.BytesIO()
            canvas.save(png_buf, format="PNG")
            arcname = "{0}/{1}.png".format(bucket, jpeg.stem)
            zf.writestr(arcname, png_buf.getvalue())

            manifest_rows.append({
                "filename": arcname,
                "predicted_name": sidecar.get("predicted_name") or "",
                "confidence": sidecar.get("confidence", ""),
                "source_w": src_w,
                "source_h": src_h,
                "scale": "{0:.6f}".format(scale),
                "pad_x": pad_x,
                "pad_y": pad_y,
                "event_id": sidecar.get("event_id", ""),
                "ts_ms": sidecar.get("ts_ms", ""),
                "sw_rev": sidecar.get("sw_rev", ""),
            })
            count += 1

        # Write manifest LAST so it reflects the final entry set.
        csv_buf = io.StringIO()
        writer = csv.DictWriter(csv_buf, fieldnames=list(MANIFEST_COLUMNS))
        writer.writeheader()
        for row in manifest_rows:
            writer.writerow(row)
        zf.writestr("manifest.csv", csv_buf.getvalue())

    summary = {"count": count, "skipped": skipped, "truncated": truncated}
    return buf.getvalue(), summary
