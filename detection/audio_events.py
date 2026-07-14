"""Bounded, dependency-free audio event features and alert debounce.

The optional audio watcher decodes the camera microphone to mono 16 kHz PCM.
This module deliberately stores no audio and logs no samples.  It extracts a
small feature dict, applies conservative transparent heuristics, and requires
label-specific consecutive hits before returning an event.

The heuristic classifier is a safe fallback, not a substitute for a validated
acoustic model.  ``AudioEventGate`` accepts any ``{label: score}`` predictions,
so a future proven TFLite/ONNX adapter can replace only the classifier without
changing debounce, retries, or the server wire contract.

Python 3.6 compatible.
"""
import array
import math
import sys


SAMPLE_RATE = 16000
MAX_WINDOW_S = 2.0
MAX_SAMPLES = int(SAMPLE_RATE * MAX_WINDOW_S)
AUDIO_LABELS = (
    "audio_smoke_alarm",
    "audio_glass_break",
    "audio_scream",
    "audio_dog_bark",
)


def sanitize_audio_labels(values):
    if not isinstance(values, list):
        return []
    out = []
    for value in values:
        if value in AUDIO_LABELS and value not in out:
            out.append(value)
    return out


def pcm16le_samples(data, max_samples=MAX_SAMPLES):
    """Decode bounded signed-16 little-endian PCM into normalized floats."""
    if not isinstance(data, (bytes, bytearray)) or len(data) < 2:
        return []
    usable = min(len(data) - (len(data) % 2), int(max_samples) * 2)
    values = array.array("h")
    values.frombytes(bytes(data[:usable]))
    if sys.byteorder != "little":
        values.byteswap()
    return [value / 32768.0 for value in values]


def _goertzel_ratio(samples, sample_rate, frequency, total_energy):
    if not samples or total_energy <= 1e-12:
        return 0.0
    omega = 2.0 * math.pi * float(frequency) / float(sample_rate)
    coeff = 2.0 * math.cos(omega)
    s_prev = 0.0
    s_prev2 = 0.0
    for sample in samples:
        current = sample + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = current
    power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2
    return max(0.0, power / (total_energy * float(len(samples))))


def extract_audio_features(samples, sample_rate=SAMPLE_RATE):
    """Return bounded scalar features for one mono audio window."""
    if not samples:
        return {
            "rms": 0.0,
            "peak": 0.0,
            "crest": 0.0,
            "zcr": 0.0,
            "derivative_ratio": 0.0,
            "smoke_tone_ratio": 0.0,
        }
    values = [max(-1.0, min(1.0, float(value))) for value in samples[:MAX_SAMPLES]]
    count = len(values)
    energy = sum(value * value for value in values)
    rms = math.sqrt(energy / float(count)) if count else 0.0
    peak = max(abs(value) for value in values)
    crossings = 0
    derivative_energy = 0.0
    previous = values[0]
    for value in values[1:]:
        if (value >= 0) != (previous >= 0):
            crossings += 1
        delta = value - previous
        derivative_energy += delta * delta
        previous = value
    zcr = crossings / float(max(1, count - 1))
    derivative_rms = math.sqrt(
        derivative_energy / float(max(1, count - 1)),
    )
    tone_ratio = max(
        _goertzel_ratio(values, sample_rate, frequency, energy)
        for frequency in (2800.0, 3000.0, 3200.0)
    )
    return {
        "rms": rms,
        "peak": peak,
        "crest": peak / max(rms, 1e-9),
        "zcr": zcr,
        "derivative_ratio": derivative_rms / max(rms, 1e-9),
        "smoke_tone_ratio": tone_ratio,
    }


def classify_audio_features(features):
    """Return at most one conservative heuristic prediction.

    Priority prevents the same loud window from being reported as several
    events.  Scores are bounded confidence-like strengths, not calibrated
    probabilities.
    """
    rms = float(features.get("rms", 0.0))
    peak = float(features.get("peak", 0.0))
    crest = float(features.get("crest", 0.0))
    zcr = float(features.get("zcr", 0.0))
    derivative = float(features.get("derivative_ratio", 0.0))
    tone = float(features.get("smoke_tone_ratio", 0.0))

    # Residential smoke alarms commonly carry a strong, sustained upper-mid
    # tone.  Temporal confirmation is supplied by AudioEventGate (two windows).
    if rms >= 0.025 and tone >= 0.16 and 0.20 <= zcr <= 0.55:
        score = min(1.0, 0.45 + tone + min(0.25, rms * 2.0))
        return {"audio_smoke_alarm": score}

    # Glass-like transient: sharp peak, broadband/high derivative, and many
    # sign changes.  This deliberately prefers misses to constant false alarms.
    if peak >= 0.45 and crest >= 4.0 and zcr >= 0.10 and derivative >= 1.15:
        score = min(1.0, 0.4 + (crest - 4.0) * 0.05 + derivative * 0.15)
        return {"audio_glass_break": score}

    # A sustained loud, voiced/high-energy band.  Two consecutive windows are
    # required by the gate before this becomes an alert.
    if rms >= 0.14 and 0.06 <= zcr <= 0.38 and crest <= 4.2:
        score = min(1.0, 0.45 + rms * 2.0 + zcr * 0.4)
        return {"audio_scream": score}

    # Bark-like impulsive voiced energy.  The wide range accommodates different
    # microphones; consecutive-window gating is the primary false-positive bar.
    if rms >= 0.07 and 1.6 <= crest <= 8.0 and 0.015 <= zcr <= 0.25:
        if 0.35 <= derivative <= 1.65:
            score = min(1.0, 0.35 + rms * 2.0 + min(0.3, crest * 0.04))
            return {"audio_dog_bark": score}
    return {}


def classify_pcm16le(data, sample_rate=SAMPLE_RATE):
    return classify_audio_features(
        extract_audio_features(pcm16le_samples(data), sample_rate=sample_rate),
    )


class AudioEventGate(object):
    """Consecutive-hit debounce plus per-label refractory windows."""

    _REQUIRED_HITS = {
        "audio_smoke_alarm": 2,
        "audio_glass_break": 1,
        "audio_scream": 2,
        "audio_dog_bark": 2,
    }
    _REFRACTORY_S = {
        "audio_smoke_alarm": 30.0,
        "audio_glass_break": 15.0,
        "audio_scream": 15.0,
        "audio_dog_bark": 30.0,
    }

    def __init__(self, labels=None, minimum_score=0.5):
        selected = sanitize_audio_labels(labels)
        self.labels = selected
        self.minimum_score = float(minimum_score)
        self._hits = dict((label, 0) for label in AUDIO_LABELS)
        self._best = dict((label, 0.0) for label in AUDIO_LABELS)
        self._last_emit = dict((label, -1e30) for label in AUDIO_LABELS)
        self._started_at = dict((label, None) for label in AUDIO_LABELS)

    def set_labels(self, labels):
        selected = sanitize_audio_labels(labels)
        self.labels = selected
        disabled = set(AUDIO_LABELS) - set(selected)
        for label in disabled:
            self._hits[label] = 0
            self._best[label] = 0.0
            self._started_at[label] = None

    def observe(self, predictions, now, window_s=1.0):
        enabled = set(self.labels)
        accepted = []
        if isinstance(predictions, dict):
            for label, raw_score in predictions.items():
                if label not in enabled:
                    continue
                try:
                    score = float(raw_score)
                except (TypeError, ValueError):
                    continue
                if math.isfinite(score) and score >= self.minimum_score:
                    accepted.append((label, min(1.0, max(0.0, score))))
        accepted.sort(key=lambda pair: pair[1], reverse=True)
        chosen = accepted[0] if accepted else None
        for label in AUDIO_LABELS:
            if chosen is None or label != chosen[0]:
                self._hits[label] = 0
                self._best[label] = 0.0
                self._started_at[label] = None
        if chosen is None:
            return None
        label, score = chosen
        if self._hits[label] == 0:
            self._started_at[label] = now
        self._hits[label] += 1
        self._best[label] = max(self._best[label], score)
        required = self._REQUIRED_HITS[label]
        if self._hits[label] < required:
            return None
        self._hits[label] = 0
        if now - self._last_emit[label] < self._REFRACTORY_S[label]:
            return None
        self._last_emit[label] = now
        started = self._started_at[label]
        duration = max(float(window_s), now - started + float(window_s))
        event = {
            "label": label,
            "score": self._best[label],
            "duration_s": min(60.0, max(0.0, duration)),
            "correlation_id": "audio_{}_{}".format(label[6:], int(now * 1000)),
        }
        self._best[label] = 0.0
        self._started_at[label] = None
        return event
