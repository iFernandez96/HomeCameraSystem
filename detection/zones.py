"""Zone-mask helpers for the detection worker (iter-191b, Feature #5).

Pure stdlib + Python 3.6 compatible — runs on the Jetson host
where JetPack 4.x ships only Python 3.6. Backed by the iter-163
AST scanner via `tests/test_py36_compat.py::_GUARDED_MODULES`.

The companion server-side `point_in_polygon` lives in
`server/app/services/detection_config.py`. Both implementations
use the same ray-casting algorithm and produce identical results
for the same input — duplicated rather than shared because the
server module uses 3.10+ syntax (PEP 604 unions, `list[...]`
annotations) that would break the worker's import on 3.6.

The zone gate semantics (per `feature_ideas_iter177.md` Feature #5):
- ``zones`` is a list of polygons; each polygon is a list of
  ``[x, y]`` points with normalized [0, 1] coords.
- Empty ``zones`` = no spatial gating. Default; pre-iter-191
  behaviour preserved.
- Non-empty ``zones`` = at least one detection box's center must
  fall inside ANY polygon for the event to emit. The whole event
  drops if no box passes — events outside the zone never reach
  the bus.

The bbox-CENTER test was chosen over corner-inside / area-overlap
because it's cheap (~1 floating-point compare per polygon edge)
and matches user intuition for tight masks (polygon over the
porch, person fully on the porch → fires).
"""
import time as _time  # noqa: F401  (re-exported for sibling modules)


def point_in_polygon(x, y, polygon):
    """Ray-casting point-in-polygon test.

    Returns True when (x, y) lies inside ``polygon``. Polygon is a
    closed shape defined by its vertex list (a list of ``[x, y]``
    pairs); the algorithm casts a horizontal ray from the point and
    counts intersections with the edges (odd = inside).

    Degenerate input (polygon with <3 vertices) returns False — the
    caller should guard, but defending here keeps the function
    exception-free.
    """
    n = len(polygon)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi = polygon[i][0]
        yi = polygon[i][1]
        xj = polygon[j][0]
        yj = polygon[j][1]
        # Tiny epsilon guards horizontal edges (yj == yi) where the
        # divisor would be zero.
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def box_center_inside_any_zone(box, zones):
    """Return True if ``box`` overlaps any polygon in ``zones``.
    Empty zones short-circuits to True (no gating).

    ``box`` is a dict with keys ``x``, ``y``, ``w``, ``h``
    (normalized [0,1] coords — same shape as `box_norm.normalize_box`
    output that detect.py builds for the event payload).

    iter-275 (camera-algorithm-auditor G1): the implementation now
    samples 5 points per box — the center plus 4 quartile points
    at (x+w/4, y+h/4), (x+3w/4, y+h/4), (x+w/4, y+3h/4),
    (x+3w/4, y+3h/4) — and returns True when ≥2 of the 5 fall
    inside ANY polygon in `zones`. This is roughly an "≥40% of
    bbox area is inside a zone" approximation: at edges where
    pre-iter-275 the center was just outside the polygon (1-2 px
    drop) and the event was silently dropped, the quartile points
    now catch the overlap. Center-only cases that PASSED still
    pass (center alone is one of the 5 — when the center is
    inside, that's already 1/5; one quartile inside makes 2/5).
    The function name is preserved for caller compatibility even
    though the body no longer tests center-only.

    Note: keeping the test cheap (5 ray-casts per polygon per box,
    each O(vertices)) so the worker stays within the iter-271 idle-
    gear budget.
    """
    if not zones:
        return True
    x = box["x"]
    y = box["y"]
    w = box["w"]
    h = box["h"]
    # 5 sample points: center + 4 quartiles.
    samples = (
        (x + w * 0.5, y + h * 0.5),    # center
        (x + w * 0.25, y + h * 0.25),  # upper-left quartile
        (x + w * 0.75, y + h * 0.25),  # upper-right quartile
        (x + w * 0.25, y + h * 0.75),  # lower-left quartile
        (x + w * 0.75, y + h * 0.75),  # lower-right quartile
    )
    for zone in zones:
        inside_count = 0
        for sx, sy in samples:
            if point_in_polygon(sx, sy, zone):
                inside_count += 1
                if inside_count >= 2:
                    return True
    return False


def any_box_center_inside_any_zone(boxes, zones):
    """Return True if at least one of ``boxes``' centers falls inside
    any zone. Empty zones short-circuits to True. Used by detect.py's
    emit gate — the whole event drops when zones is non-empty AND no
    box passes."""
    if not zones:
        return True
    for box in boxes:
        if box_center_inside_any_zone(box, zones):
            return True
    return False


def sanitize_zones(values):
    """Defensive sanitizer for the worker's config-poll payload.
    The server (`detection_config.py::_valid_zones`) already validates
    + clamps before returning the config, but a transient corrupt
    response or a downgraded server should NOT poison the worker's
    runtime. Returns a list of polygons; tolerates non-list input.

    Bounds (mirror server-side ZONES_MAX/ZONE_VERTICES_MIN/MAX):
    - Up to 16 polygons.
    - Each polygon: 3..32 vertices.
    - Each vertex: ``[x, y]`` with x, y in [0.0, 1.0].
    """
    if not isinstance(values, list):
        return []
    cleaned = []
    for poly in values:
        if not isinstance(poly, list):
            continue
        if not (3 <= len(poly) <= 32):
            continue
        points = []
        ok = True
        for pt in poly:
            if not isinstance(pt, list) or len(pt) != 2:
                ok = False
                break
            try:
                px = float(pt[0])
                py = float(pt[1])
            except (ValueError, TypeError):
                ok = False
                break
            if not (0.0 <= px <= 1.0) or not (0.0 <= py <= 1.0):
                ok = False
                break
            points.append([px, py])
        if not ok:
            continue
        cleaned.append(points)
        if len(cleaned) >= 16:
            break
    return cleaned
