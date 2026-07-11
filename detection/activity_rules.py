"""Pure spatial-rule decisions for the Jetson detection worker.

The live worker owns frame capture and HTTP.  This module owns the bounded,
deterministic state machines behind three optional smart-rule kinds:

* ``line_crossing`` -- finite-segment crossing with an oriented direction;
* ``loitering`` -- one alert after one tracked object remains in a polygon;
* ``package`` -- a conservative *possible porch-object* appeared/removed
  lifecycle from a small illumination-normalized scene sample.

No camera SDK, HTTP client, model, or clock is imported here.  Callers inject
``now`` and already-normalized detection boxes.  Package persistence is kept in
the small ``PackageStateStore`` adapter at the bottom; all decision logic stays
independently unit-testable.

Python 3.6 compatible: this file runs on JetPack 4.x.
"""
import json
import math
import os
import re

from zones import point_in_polygon


MAX_RULES = 16
MAX_RULE_LABELS = 16
MAX_TRACKS = 32
LINE_DEADBAND = 0.015
LINE_REFRACTORY_S = 2.0
TRACK_MAX_GAP_S = 4.0
TRACK_MAX_CENTER_DISTANCE = 0.28
PACKAGE_GRID_SIZE = 24
PACKAGE_MIN_SAMPLE_COUNT = 32
PACKAGE_MIN_STDDEV = 3.0

_RULE_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_CAMERA_ID_RE = re.compile(r"^[a-z0-9_]{1,32}$")
_VALID_KINDS = ("line_crossing", "loitering", "package")
_VALID_DIRECTIONS = ("any", "forward", "reverse")


def _finite_float(value, default):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(out):
        return default
    return out


def _clean_points(values, exact=None):
    if not isinstance(values, list):
        return None
    if exact is not None:
        if len(values) != exact:
            return None
    elif not (3 <= len(values) <= 32):
        return None
    points = []
    for value in values:
        if not isinstance(value, list) or len(value) != 2:
            return None
        x = _finite_float(value[0], None)
        y = _finite_float(value[1], None)
        if x is None or y is None:
            return None
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            return None
        points.append([x, y])
    return points


def sanitize_rules(values, camera_id=None):
    """Return a bounded, canonical smart-rule list.

    The server validates the same shape before persisting it.  This defensive
    duplicate keeps a corrupt/downgraded config response from poisoning the
    Python-3.6 worker.  Invalid entries are dropped independently.
    """
    if not isinstance(values, list):
        return []
    cleaned = []
    seen = set()
    for raw in values:
        if not isinstance(raw, dict):
            continue
        rule_id = raw.get("id")
        if not isinstance(rule_id, str) or not _RULE_ID_RE.match(rule_id):
            continue
        if rule_id in seen:
            continue
        kind = raw.get("kind")
        if kind not in _VALID_KINDS:
            continue
        name = raw.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        name = name.strip()[:64]
        rule_camera = raw.get("camera_id")
        if not isinstance(rule_camera, str) or not _CAMERA_ID_RE.match(rule_camera):
            continue
        if camera_id is not None and rule_camera != camera_id:
            continue
        points = _clean_points(
            raw.get("points"), exact=(2 if kind == "line_crossing" else None),
        )
        if points is None:
            continue
        labels = raw.get("labels")
        if not isinstance(labels, list):
            labels = []
        label_out = []
        for label in labels:
            if not isinstance(label, str):
                continue
            value = label.strip().lower()
            if not value or len(value) > 64 or value in label_out:
                continue
            label_out.append(value)
            if len(label_out) >= MAX_RULE_LABELS:
                break
        if not label_out:
            label_out = ["person"]
        direction = raw.get("direction", "any")
        if direction not in _VALID_DIRECTIONS:
            direction = "any"
        dwell_s = _finite_float(raw.get("dwell_s"), 30.0)
        dwell_s = max(0.0, min(3600.0, dwell_s))
        threshold = _finite_float(raw.get("threshold"), 0.55)
        threshold = max(0.0, min(1.0, threshold))
        enabled = raw.get("enabled", True)
        if not isinstance(enabled, bool):
            enabled = bool(enabled)
        cleaned.append({
            "id": rule_id,
            "name": name,
            "kind": kind,
            "enabled": enabled,
            "camera_id": rule_camera,
            "points": points,
            "labels": label_out,
            "direction": direction,
            "dwell_s": dwell_s,
            "threshold": threshold,
        })
        seen.add(rule_id)
        if len(cleaned) >= MAX_RULES:
            break
    return cleaned


def _box_center(box):
    return (
        float(box["x"]) + float(box["w"]) * 0.5,
        float(box["y"]) + float(box["h"]) * 0.5,
    )


def _box_ltrb(box):
    x = float(box["x"])
    y = float(box["y"])
    return (x, y, x + float(box["w"]), y + float(box["h"]))


def _bbox_iou(a, b):
    ax0, ay0, ax1, ay1 = _box_ltrb(a)
    bx0, by0, bx1, by1 = _box_ltrb(b)
    ix0 = max(ax0, bx0)
    iy0 = max(ay0, by0)
    ix1 = min(ax1, bx1)
    iy1 = min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    aa = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    ba = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    union = aa + ba - inter
    return inter / union if union > 0 else 0.0


def _distance(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)


def _valid_box(box):
    if not isinstance(box, dict):
        return False
    try:
        x = float(box["x"])
        y = float(box["y"])
        w = float(box["w"])
        h = float(box["h"])
        score = float(box.get("score", 0.0))
    except (KeyError, TypeError, ValueError):
        return False
    values = (x, y, w, h, score)
    if not all(math.isfinite(value) for value in values):
        return False
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > 1.001 or y + h > 1.001:
        return False
    label = box.get("label")
    return isinstance(label, str) and bool(label.strip())


class BoundedObjectTracker(object):
    """Small greedy IoU/centroid tracker suitable for the 1-5 Hz worker.

    It is deliberately not a re-identification model.  IDs survive brief
    detector dropouts only, and all memory is capped.
    """

    def __init__(self, max_tracks=MAX_TRACKS, max_gap_s=TRACK_MAX_GAP_S,
                 max_center_distance=TRACK_MAX_CENTER_DISTANCE):
        self.max_tracks = int(max_tracks)
        self.max_gap_s = float(max_gap_s)
        self.max_center_distance = float(max_center_distance)
        self._tracks = {}
        self._next_id = 1

    def tick(self, now):
        expired = []
        for track_id, track in list(self._tracks.items()):
            if now - track["last_seen"] > self.max_gap_s:
                expired.append(track_id)
                del self._tracks[track_id]
        return expired

    def observe(self, boxes, now):
        self.tick(now)
        candidates = [dict(box) for box in boxes if _valid_box(box)]
        candidates.sort(key=lambda box: float(box.get("score", 0.0)), reverse=True)
        updated = []
        used = set()
        for box in candidates:
            label = str(box["label"]).lower()
            center = _box_center(box)
            best_id = None
            best_quality = None
            for track_id, track in self._tracks.items():
                if track_id in used or track["label"] != label:
                    continue
                gap = now - track["last_seen"]
                if gap < 0 or gap > self.max_gap_s:
                    continue
                iou = _bbox_iou(track["box"], box)
                dist = _distance(track["center"], center)
                if iou < 0.05 and dist > self.max_center_distance:
                    continue
                quality = iou * 2.0 + max(
                    0.0, 1.0 - dist / max(self.max_center_distance, 1e-6),
                )
                if best_quality is None or quality > best_quality:
                    best_quality = quality
                    best_id = track_id
            if best_id is None:
                best_id = "t{}".format(self._next_id)
                self._next_id += 1
                self._tracks[best_id] = {
                    "id": best_id,
                    "label": label,
                    "box": box,
                    "center": center,
                    "previous_center": None,
                    "first_seen": now,
                    "last_seen": now,
                    "score": float(box.get("score", 0.0)),
                }
            else:
                track = self._tracks[best_id]
                track["previous_center"] = track["center"]
                track["center"] = center
                track["box"] = box
                track["last_seen"] = now
                track["score"] = float(box.get("score", 0.0))
            used.add(best_id)
            updated.append(dict(self._tracks[best_id]))
        while len(self._tracks) > self.max_tracks:
            oldest = min(self._tracks, key=lambda key: self._tracks[key]["last_seen"])
            del self._tracks[oldest]
        return updated

    def active(self):
        return [dict(track) for track in self._tracks.values()]

    def active_ids(self):
        return set(self._tracks.keys())

    def clear(self):
        self._tracks = {}


def _signed_line_distance(point, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = math.sqrt(dx * dx + dy * dy)
    if length <= 1e-9:
        return 0.0
    return (dx * (point[1] - a[1]) - dy * (point[0] - a[0])) / length


def _orientation(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a, b, point, eps=1e-9):
    return (
        min(a[0], b[0]) - eps <= point[0] <= max(a[0], b[0]) + eps
        and min(a[1], b[1]) - eps <= point[1] <= max(a[1], b[1]) + eps
    )


def _segments_intersect(a, b, c, d):
    o1 = _orientation(a, b, c)
    o2 = _orientation(a, b, d)
    o3 = _orientation(c, d, a)
    o4 = _orientation(c, d, b)
    if ((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and (
            (o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0)):
        return True
    eps = 1e-9
    if abs(o1) <= eps and _on_segment(a, b, c):
        return True
    if abs(o2) <= eps and _on_segment(a, b, d):
        return True
    if abs(o3) <= eps and _on_segment(c, d, a):
        return True
    if abs(o4) <= eps and _on_segment(c, d, b):
        return True
    return False


def _direction_allowed(configured, old_side, new_side):
    if configured == "any":
        return True
    # The rule line is oriented points[0] -> points[1].  "forward" is the
    # negative side crossing onto the positive side; reverse is the opposite.
    if configured == "forward":
        return old_side < 0 and new_side > 0
    return old_side > 0 and new_side < 0


def _rule_fingerprint(rule):
    return json.dumps(
        {"camera_id": rule["camera_id"], "points": rule["points"]},
        sort_keys=True, separators=(",", ":"),
    )


def _normalized_sample(values):
    if values is None or len(values) < PACKAGE_MIN_SAMPLE_COUNT:
        return None
    mean = sum(values) / float(len(values))
    variance = sum((value - mean) ** 2 for value in values) / float(len(values))
    stddev = math.sqrt(max(0.0, variance))
    if stddev < PACKAGE_MIN_STDDEV:
        return None
    return [max(-4.0, min(4.0, (value - mean) / stddev)) for value in values]


def _sample_difference(a, b):
    if a is None or b is None or len(a) != len(b) or not a:
        return None
    return sum(abs(x - y) for x, y in zip(a, b)) / float(len(a))


def sample_package_polygon(rgb_image, polygon, grid_size=PACKAGE_GRID_SIZE):
    """Return a small illumination-normalized sample inside ``polygon``.

    ``rgb_image`` only needs numpy-like ``shape`` and ``image[y, x]`` access;
    importing numpy here is unnecessary.  Sampling a bounded grid means package
    rules add hundreds, not millions, of pixel reads per five-second scene tick.
    """
    try:
        height = int(rgb_image.shape[0])
        width = int(rgb_image.shape[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        return None
    if height <= 0 or width <= 0 or not polygon:
        return None
    min_x = max(0.0, min(point[0] for point in polygon))
    max_x = min(1.0, max(point[0] for point in polygon))
    min_y = max(0.0, min(point[1] for point in polygon))
    max_y = min(1.0, max(point[1] for point in polygon))
    if max_x <= min_x or max_y <= min_y:
        return None
    values = []
    size = max(4, min(64, int(grid_size)))
    for gy in range(size):
        ny = min_y + (gy + 0.5) * (max_y - min_y) / float(size)
        for gx in range(size):
            nx = min_x + (gx + 0.5) * (max_x - min_x) / float(size)
            if not point_in_polygon(nx, ny, polygon):
                continue
            px = max(0, min(width - 1, int(nx * width)))
            py = max(0, min(height - 1, int(ny * height)))
            try:
                pixel = rgb_image[py, px]
                red = float(pixel[0])
                green = float(pixel[1])
                blue = float(pixel[2])
            except (IndexError, KeyError, TypeError, ValueError):
                continue
            values.append(0.299 * red + 0.587 * green + 0.114 * blue)
    return _normalized_sample(values)


class PackageZoneState(object):
    """Hysteretic empty/occupied state relative to a calibrated empty scene."""

    def __init__(self, change_threshold=0.35, stable_s=10.0,
                 correlation_factory=None):
        self.change_threshold = float(change_threshold)
        self.stable_s = float(stable_s)
        self.correlation_factory = correlation_factory
        self.baseline = None
        self.state = "uncalibrated"
        self.correlation_id = None
        self._candidate = None
        self._candidate_since = None
        self._candidate_sample = None
        self._sequence = 0

    def configure(self, change_threshold, stable_s):
        self.change_threshold = max(0.05, min(3.0, float(change_threshold)))
        self.stable_s = max(2.0, min(300.0, float(stable_s)))

    def _new_correlation(self, rule_id, now):
        if self.correlation_factory is not None:
            return str(self.correlation_factory(rule_id, now))
        self._sequence += 1
        return "pkg_{}_{}_{}".format(rule_id, int(now * 1000), self._sequence)

    def _clear_candidate(self):
        self._candidate = None
        self._candidate_since = None
        self._candidate_sample = None

    def suspend(self):
        """Drop in-progress evidence without changing calibrated state."""
        self._clear_candidate()

    def observe(self, sample, now, blocked, rule_id):
        """Return ``(transition_or_none, persistent_state_changed)``."""
        if sample is None:
            self._clear_candidate()
            return (None, False)
        if blocked:
            self._clear_candidate()
            return (None, False)

        if self.baseline is None or len(self.baseline) != len(sample):
            if self._candidate != "calibrate":
                self._candidate = "calibrate"
                self._candidate_since = now
                self._candidate_sample = list(sample)
                return (None, False)
            drift = _sample_difference(sample, self._candidate_sample)
            if drift is None or drift > self.change_threshold * 0.5:
                self._candidate_since = now
                self._candidate_sample = list(sample)
                return (None, False)
            if now - self._candidate_since >= self.stable_s:
                self.baseline = list(sample)
                self.state = "empty"
                self.correlation_id = None
                self._clear_candidate()
                return (None, True)
            return (None, False)

        delta = _sample_difference(sample, self.baseline)
        if delta is None:
            self._clear_candidate()
            return (None, False)
        target = None
        if self.state == "empty" and delta >= self.change_threshold:
            target = "occupied"
        elif self.state == "occupied" and delta <= self.change_threshold * 0.55:
            target = "empty"
        if target is None:
            self._clear_candidate()
            return (None, False)

        if self._candidate != target:
            self._candidate = target
            self._candidate_since = now
            self._candidate_sample = list(sample)
            return (None, False)
        stability = _sample_difference(sample, self._candidate_sample)
        if stability is None or stability > self.change_threshold * 0.75:
            self._candidate_since = now
            self._candidate_sample = list(sample)
            return (None, False)
        if now - self._candidate_since < self.stable_s:
            return (None, False)

        self._clear_candidate()
        if target == "occupied":
            self.state = "occupied"
            self.correlation_id = self._new_correlation(rule_id, now)
            return ({
                "package_state": "delivered",
                "correlation_id": self.correlation_id,
                "difference": delta,
            }, True)
        old_correlation = self.correlation_id
        self.state = "empty"
        self.correlation_id = None
        return ({
            "package_state": "collected",
            "correlation_id": old_correlation or self._new_correlation(rule_id, now),
            "difference": delta,
        }, True)

    def snapshot(self, fingerprint):
        return {
            "fingerprint": fingerprint,
            "state": self.state,
            "baseline": self.baseline,
            "correlation_id": self.correlation_id,
            "sequence": self._sequence,
        }

    def restore(self, data, fingerprint):
        if not isinstance(data, dict) or data.get("fingerprint") != fingerprint:
            return False
        baseline = data.get("baseline")
        if not isinstance(baseline, list) or len(baseline) < PACKAGE_MIN_SAMPLE_COUNT:
            return False
        clean = []
        for value in baseline:
            number = _finite_float(value, None)
            if number is None:
                return False
            clean.append(number)
        state = data.get("state")
        if state not in ("empty", "occupied"):
            return False
        self.baseline = clean
        self.state = state
        correlation = data.get("correlation_id")
        self.correlation_id = correlation if isinstance(correlation, str) else None
        try:
            self._sequence = max(0, int(data.get("sequence", 0)))
        except (TypeError, ValueError):
            self._sequence = 0
        return True


class PackageStateStore(object):
    """Atomic, mode-0600 JSON persistence for calibrated package states."""

    def __init__(self, path):
        self.path = str(path) if path else None
        self.errors = 0

    def load(self):
        if not self.path:
            return {}
        try:
            with open(self.path, "r") as handle:
                data = json.load(handle)
            rules = data.get("rules") if isinstance(data, dict) else None
            return rules if isinstance(rules, dict) else {}
        except (OSError, IOError, TypeError, ValueError):
            return {}

    def save(self, camera_id, snapshots):
        if not self.path:
            return True
        tmp = self.path + ".tmp"
        try:
            parent = os.path.dirname(os.path.abspath(self.path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            encoded = json.dumps(
                {"v": 1, "camera_id": camera_id, "rules": snapshots},
                sort_keys=True, separators=(",", ":"),
            )
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                remaining = encoded.encode("utf-8")
                while remaining:
                    written = os.write(fd, remaining)
                    if written <= 0:
                        raise OSError("short write while saving package state")
                    remaining = remaining[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
            return True
        except OSError:
            self.errors += 1
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:
                pass
            return False


class ActivityRuleEngine(object):
    """Combine object association and per-rule transition state."""

    def __init__(self, camera_id, rules=None, package_change_threshold=0.35,
                 package_stable_s=10.0, package_state_path=None):
        self.camera_id = camera_id
        self.tracker = BoundedObjectTracker()
        self.package_change_threshold = float(package_change_threshold)
        self.package_stable_s = float(package_stable_s)
        self.rules = []
        self._line_state = {}
        self._loiter_state = {}
        self._package_state = {}
        self._package_fingerprints = {}
        self._package_dirty = False
        self._next_persist_retry_at = 0.0
        self._event_sequence = 0
        self.store = PackageStateStore(package_state_path)
        self._stored = self.store.load()
        self._restore_open = True
        self.set_rules(rules or [], authoritative=bool(rules))

    def set_rules(self, rules, package_change_threshold=None,
                  package_stable_s=None, authoritative=False):
        if package_change_threshold is not None:
            value = _finite_float(package_change_threshold, 0.35)
            self.package_change_threshold = max(0.05, min(3.0, value))
        if package_stable_s is not None:
            value = _finite_float(package_stable_s, 10.0)
            self.package_stable_s = max(2.0, min(300.0, value))
        canonical = sanitize_rules(rules, camera_id=self.camera_id)
        if canonical == self.rules:
            for state in self._package_state.values():
                state.configure(self.package_change_threshold, self.package_stable_s)
            if authoritative and self._restore_open:
                self._stored = {}
                self._restore_open = False
            return False
        self.rules = canonical
        valid_ids = set(rule["id"] for rule in canonical)
        self._line_state = {
            key: value for key, value in self._line_state.items()
            if key[0] in valid_ids
        }
        self._loiter_state = {
            key: value for key, value in self._loiter_state.items()
            if key[0] in valid_ids
        }
        old_package = self._package_state
        old_fingerprints = self._package_fingerprints
        self._package_state = {}
        self._package_fingerprints = {}
        for rule in canonical:
            if rule["kind"] != "package":
                continue
            fingerprint = _rule_fingerprint(rule)
            state = old_package.get(rule["id"])
            if state is None or old_fingerprints.get(rule["id"]) != fingerprint:
                state = PackageZoneState(
                    self.package_change_threshold, self.package_stable_s,
                )
                if self._restore_open:
                    state.restore(self._stored.get(rule["id"]), fingerprint)
            state.configure(self.package_change_threshold, self.package_stable_s)
            self._package_state[rule["id"]] = state
            self._package_fingerprints[rule["id"]] = fingerprint
        if (
            set(old_package.keys()) != set(self._package_state.keys())
            or any(
                old_fingerprints.get(rule_id) != fingerprint
                for rule_id, fingerprint in self._package_fingerprints.items()
            )
        ):
            self._package_dirty = True
            self._next_persist_retry_at = 0.0
        if authoritative and self._restore_open:
            self._stored = {}
            self._restore_open = False
        return True

    def tick(self, now):
        if self._package_dirty and now >= self._next_persist_retry_at:
            self._persist_package_states(now)
        expired = self.tracker.tick(now)
        if not expired:
            return
        expired_set = set(expired)
        self._line_state = {
            key: value for key, value in self._line_state.items()
            if key[1] not in expired_set
        }
        self._loiter_state = {
            key: value for key, value in self._loiter_state.items()
            if key[1] not in expired_set
        }

    def suspend(self):
        """Clear transient evidence across off/privacy boundaries."""
        self.tracker.clear()
        self._line_state = {}
        self._loiter_state = {}
        for state in self._package_state.values():
            state.suspend()

    def _correlation(self, rule_id, track_id, now):
        self._event_sequence += 1
        return "rule_{}_{}_{}_{}".format(
            rule_id, track_id, int(now * 1000), self._event_sequence,
        )

    def _event(self, rule, track, label, correlation_id, **extra):
        event = {
            "label": label,
            "score": float(track.get("score", 0.0)),
            "box": dict(track["box"]),
            "rule_id": rule["id"],
            "rule_name": rule["name"],
            "correlation_id": correlation_id,
        }
        event.update(extra)
        return event

    def observe_boxes(self, boxes, now):
        tracks = self.tracker.observe(boxes, now)
        events = []
        for track in tracks:
            for rule in self.rules:
                if not rule["enabled"] or rule["kind"] == "package":
                    continue
                if track["label"] not in rule["labels"]:
                    continue
                if track["score"] < rule["threshold"]:
                    continue
                if rule["kind"] == "line_crossing":
                    event = self._observe_line(rule, track, now)
                else:
                    event = self._observe_loiter(rule, track, now)
                if event is not None:
                    events.append(event)
        return events

    def _observe_line(self, rule, track, now):
        key = (rule["id"], track["id"])
        state = self._line_state.get(key)
        if state is None:
            state = {"side": None, "point": None, "last_event_at": -1e30}
            self._line_state[key] = state
        point = track["center"]
        signed = _signed_line_distance(point, rule["points"][0], rule["points"][1])
        if abs(signed) < LINE_DEADBAND:
            return None
        side = 1 if signed > 0 else -1
        old_side = state["side"]
        old_point = state["point"]
        event = None
        if (
            old_side is not None
            and old_side != side
            and old_point is not None
            and now - state["last_event_at"] >= LINE_REFRACTORY_S
            and _segments_intersect(
                old_point, point, rule["points"][0], rule["points"][1],
            )
            and _direction_allowed(rule["direction"], old_side, side)
        ):
            correlation = self._correlation(rule["id"], track["id"], now)
            event = self._event(
                rule, track, "line_crossing", correlation,
                crossing_direction=("forward" if old_side < side else "reverse"),
            )
            state["last_event_at"] = now
        state["side"] = side
        state["point"] = point
        return event

    def _observe_loiter(self, rule, track, now):
        key = (rule["id"], track["id"])
        inside = point_in_polygon(track["center"][0], track["center"][1], rule["points"])
        if not inside:
            self._loiter_state.pop(key, None)
            return None
        state = self._loiter_state.get(key)
        if state is None:
            state = {
                "entered_at": now,
                "fired": False,
                "correlation_id": self._correlation(rule["id"], track["id"], now),
            }
            self._loiter_state[key] = state
        if state["fired"] or now - state["entered_at"] < rule["dwell_s"]:
            return None
        state["fired"] = True
        return self._event(
            rule, track, "loitering", state["correlation_id"],
            dwell_s=max(0.0, now - state["entered_at"]),
        )

    def observe_package_frame(self, rgb_image, now):
        events = []
        active = self.tracker.active()
        persist = False
        for rule in self.rules:
            if not rule["enabled"] or rule["kind"] != "package":
                continue
            state = self._package_state.get(rule["id"])
            if state is None:
                continue
            blocked = False
            for track in active:
                if track["label"] not in rule["labels"]:
                    continue
                if track["score"] < rule["threshold"]:
                    continue
                center = track["center"]
                if point_in_polygon(center[0], center[1], rule["points"]):
                    blocked = True
                    break
            sample = sample_package_polygon(rgb_image, rule["points"])
            transition, changed = state.observe(sample, now, blocked, rule["id"])
            persist = persist or changed
            if transition is None:
                continue
            state_name = transition["package_state"]
            box = _polygon_box(rule["points"], state_name, transition["difference"])
            events.append({
                "label": "package_{}".format(state_name),
                "score": min(
                    1.0,
                    max(0.0, transition["difference"] / max(
                        self.package_change_threshold, 1e-6,
                    )),
                ),
                "box": box,
                "rule_id": rule["id"],
                "rule_name": rule["name"],
                "correlation_id": transition["correlation_id"],
                "package_state": state_name,
            })
        if persist:
            self._package_dirty = True
        if self._package_dirty and now >= self._next_persist_retry_at:
            self._persist_package_states(now)
        return events

    def _persist_package_states(self, now=None):
        by_id = dict((rule["id"], rule) for rule in self.rules)
        snapshots = {}
        for rule_id, state in self._package_state.items():
            rule = by_id.get(rule_id)
            if rule is None:
                continue
            snapshots[rule_id] = state.snapshot(_rule_fingerprint(rule))
        saved = self.store.save(self.camera_id, snapshots)
        if saved:
            self._package_dirty = False
            self._next_persist_retry_at = 0.0
        else:
            retry_from = 0.0 if now is None else float(now)
            self._next_persist_retry_at = retry_from + 5.0
        return saved


def _polygon_box(points, label, score):
    min_x = min(point[0] for point in points)
    max_x = max(point[0] for point in points)
    min_y = min(point[1] for point in points)
    max_y = max(point[1] for point in points)
    return {
        "x": min_x,
        "y": min_y,
        "w": max(1e-6, max_x - min_x),
        "h": max(1e-6, max_y - min_y),
        "label": "package_{}".format(label),
        "score": min(1.0, max(0.0, float(score))),
    }
