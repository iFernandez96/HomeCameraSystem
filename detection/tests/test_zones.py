"""iter-191b (Feature #5): worker-side zone-mask helpers.

The detect.py event-emit gate calls `any_box_center_inside_any_zone`
to drop events whose detection-box centers all fall outside the
configured zones. Empty zones default = no gating = pre-iter-191
behaviour.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from zones import (  # noqa: E402
    any_box_center_inside_any_zone,
    box_center_inside_any_zone,
    point_in_polygon,
    sanitize_zones,
)


# --- point_in_polygon -------------------------------------------------------


def test_point_in_polygon_inside_triangle():
    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    assert point_in_polygon(0.5, 0.4, tri) is True


def test_point_in_polygon_outside_triangle():
    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    assert point_in_polygon(0.0, 0.9, tri) is False


def test_point_in_polygon_degenerate_returns_false():
    """<3 vertices can't enclose anything."""
    assert point_in_polygon(0.5, 0.5, [[0.0, 0.0], [1.0, 1.0]]) is False
    assert point_in_polygon(0.5, 0.5, []) is False


def test_point_in_polygon_handles_concave_shape():
    """L-shaped polygon — point inside the inset must be False."""
    l_shape = [
        [0.0, 0.0],
        [1.0, 0.0],
        [1.0, 0.4],
        [0.4, 0.4],
        [0.4, 1.0],
        [0.0, 1.0],
    ]
    # Inside the L bottom arm.
    assert point_in_polygon(0.2, 0.2, l_shape) is True
    # Outside the L (in the inset corner).
    assert point_in_polygon(0.8, 0.8, l_shape) is False


# --- box_center_inside_any_zone --------------------------------------------


def test_empty_zones_means_no_gating():
    """Empty zones short-circuits to True — pre-iter-191 default."""
    box = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
    assert box_center_inside_any_zone(box, []) is True


def test_box_center_inside_one_zone():
    """Box centered at (0.2, 0.2) is inside the bottom-left quarter zone."""
    box = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}  # center=(0.2, 0.2)
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    assert box_center_inside_any_zone(box, [bottom_left]) is True


def test_box_center_outside_all_zones():
    box = {"x": 0.6, "y": 0.6, "w": 0.1, "h": 0.1}  # center=(0.65, 0.65)
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    assert box_center_inside_any_zone(box, [bottom_left]) is False


def test_box_center_matches_second_zone_when_first_misses():
    """any-zone-match — only one zone needs to contain the center."""
    box = {"x": 0.6, "y": 0.6, "w": 0.1, "h": 0.1}  # center=(0.65, 0.65)
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    top_right = [[0.5, 0.5], [1.0, 0.5], [1.0, 1.0], [0.5, 1.0]]
    assert box_center_inside_any_zone(box, [bottom_left, top_right]) is True


# --- any_box_center_inside_any_zone ----------------------------------------


def test_any_box_passes_when_one_box_inside():
    """Multiple boxes; just one inside the zone is enough — event fires."""
    boxes = [
        {"x": 0.6, "y": 0.6, "w": 0.1, "h": 0.1},  # outside bottom-left
        {"x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1},  # inside bottom-left
    ]
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    assert any_box_center_inside_any_zone(boxes, [bottom_left]) is True


def test_no_box_inside_drops_event():
    """All boxes outside all zones — event MUST drop (return False)."""
    boxes = [
        {"x": 0.6, "y": 0.6, "w": 0.1, "h": 0.1},
        {"x": 0.7, "y": 0.7, "w": 0.1, "h": 0.1},
    ]
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    assert any_box_center_inside_any_zone(boxes, [bottom_left]) is False


def test_empty_zones_with_any_boxes_returns_true():
    """Empty zones + any boxes = no gating = True."""
    boxes = [{"x": 0.6, "y": 0.6, "w": 0.1, "h": 0.1}]
    assert any_box_center_inside_any_zone(boxes, []) is True


def test_empty_boxes_with_zones_returns_false():
    """No detections = nothing to gate = False (event would drop, but
    detect.py guards on `if not kept` upstream so this case is rare)."""
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    assert any_box_center_inside_any_zone([], [bottom_left]) is False


# --- iter-275 (camera-algorithm-auditor G1) quartile-sample tests ----------


def test_given_box_grazes_zone_edge_when_quartile_sampled_then_overlap_detected():
    # iter-275: pre-iter-275 a box centered just outside a zone but
    # with most of its bbox inside the zone was silently dropped
    # (center-only test). G1 fix samples 5 points (center + 4
    # quartiles); ≥2 inside fires.

    # arrange: zone covers x in [0, 0.5], y in [0, 0.5]. Box centered
    # at (0.55, 0.25) with width 0.4 height 0.2 — center is just
    # OUTSIDE the zone (0.55 > 0.5), but the upper-left quartile
    # (0.45, 0.2) and lower-left quartile (0.45, 0.3) ARE inside.
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    box = {"x": 0.35, "y": 0.15, "w": 0.4, "h": 0.2}

    # act
    result = box_center_inside_any_zone(box, [bottom_left])

    # assert: 2/5 quartile samples inside → overlap → True. Pre-iter-275
    # this returned False (center alone outside) and the event dropped.
    assert result is True


def test_given_box_with_only_center_inside_when_sampled_then_still_passes():
    # Backwards compat: a small box whose center IS inside the zone
    # should keep firing even when the quartiles are also inside.
    # Pre-iter-275 → True; iter-275 → True (center counts as 1 of 5,
    # quartiles all inside → 5/5).

    # arrange
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    box = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}  # center=(0.2, 0.2)

    # act + assert
    assert box_center_inside_any_zone(box, [bottom_left]) is True


def test_given_one_quartile_inside_only_when_sampled_then_no_overlap():
    # A bbox grazing the zone with ONLY one corner sample inside (the
    # center is well outside) → 1/5 < 2/5 threshold → False. Pre-iter-275
    # this also returned False (different reason: center alone outside).
    # The behavior matches because a single-corner overlap is too small
    # to count as "the detection is in the zone."

    # arrange: zone is the bottom-left quarter; box is in the top-right
    # corner with just its lower-left quartile poking into the zone.
    bottom_left = [[0.0, 0.0], [0.5, 0.0], [0.5, 0.5], [0.0, 0.5]]
    box = {"x": 0.45, "y": 0.45, "w": 0.4, "h": 0.4}
    # center = (0.65, 0.65) — outside
    # ul quartile = (0.55, 0.55) — outside
    # ur quartile = (0.75, 0.55) — outside
    # ll quartile = (0.55, 0.75) — outside
    # lr quartile = (0.75, 0.75) — outside
    # All 5 outside → 0/5 → False (no change in expected behavior).

    # act
    result = box_center_inside_any_zone(box, [bottom_left])

    # assert
    assert result is False


# --- sanitize_zones --------------------------------------------------------


def test_sanitize_zones_passes_valid_list():
    tri = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]]
    assert sanitize_zones([tri]) == [tri]


def test_sanitize_zones_drops_too_few_vertices():
    """A 2-point polygon is degenerate."""
    line = [[0.0, 0.0], [1.0, 1.0]]
    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    out = sanitize_zones([line, tri])
    assert len(out) == 1
    assert out[0] == tri


def test_sanitize_zones_drops_out_of_range_coords():
    bad = [[0.1, 0.1], [1.5, 0.5], [0.9, 0.9]]
    assert sanitize_zones([bad]) == []


def test_sanitize_zones_drops_non_pair_points():
    bad = [[0.1, 0.1], [0.5], [0.9, 0.9]]
    assert sanitize_zones([bad]) == []


def test_sanitize_zones_caps_at_16_polygons():
    """ZONES_MAX = 16 mirrored from server side."""
    tri = [[0.0, 0.0], [1.0, 0.0], [0.5, 1.0]]
    assert len(sanitize_zones([tri] * 25)) == 16


def test_sanitize_zones_tolerates_non_list_input():
    """A None / dict / int from a corrupt config payload won't raise."""
    assert sanitize_zones(None) == []
    assert sanitize_zones({}) == []
    assert sanitize_zones(42) == []
