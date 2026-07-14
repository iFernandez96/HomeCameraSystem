"""Metadata-only signal payloads with bounded stable-ID retries.

Used by the optional audio watcher and the vision worker's nonvisual GPIO /
tamper signals.  The queue stores JSON metadata only; callers must never put
audio, frames, credentials, or arbitrary request bodies into a signal.

Python 3.6 compatible.
"""
import json
import logging
import threading
import time
import urllib.error
import urllib.request
import uuid


log = logging.getLogger("signal_retry")


def build_signal_payload(source, label, camera_id, observed_at, score=1.0,
                         duration_s=0.0, event_id=None, correlation_id=None):
    signal_id = event_id or uuid.uuid4().hex
    correlation = correlation_id or "{}_{}_{}".format(
        source, label, signal_id,
    )
    return {
        "id": signal_id,
        "source": source,
        "label": label,
        "score": min(1.0, max(0.0, float(score))),
        "camera_id": camera_id,
        "observed_at": float(observed_at),
        "duration_s": min(60.0, max(0.0, float(duration_s))),
        "correlation_id": correlation,
    }


def post_signal(url, payload, timeout=2.0):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


class SignalRetryQueue(object):
    """Thread-safe bounded retry queue preserving the original payload."""
    def __init__(self, max_pending=8, max_age_s=300.0, max_attempts=8):
        self.max_pending = max(1, int(max_pending))
        self.max_age_s = max(1.0, float(max_age_s))
        self.max_attempts = max(1, int(max_attempts))
        self.pending = []
        self._lock = threading.Lock()

    def add(self, payload, now):
        with self._lock:
            if len(self.pending) >= self.max_pending:
                self.pending.pop(0)
            self.pending.append({
                "payload": dict(payload),
                "attempts": 0,
                "created_at": float(now),
                "next_at": float(now),
            })

    def clear(self):
        with self._lock:
            self.pending = []

    def flush_one(self, url, now, sender=post_signal):
        with self._lock:
            now_value = float(now)
            self.pending = [
                item for item in self.pending
                if (
                    now_value - item["created_at"] <= self.max_age_s
                    and item["attempts"] < self.max_attempts
                )
            ]
            item = None
            for candidate in self.pending:
                if now_value >= candidate["next_at"]:
                    item = candidate
                    break
            if item is None:
                return None
            payload = item["payload"]
        # Never hold the queue lock across network I/O: emitters run on the
        # frame/GPIO paths and must remain nonblocking while loopback is down.
        try:
            sender(url, payload)
        except Exception as error:
            permanent = (
                isinstance(error, urllib.error.HTTPError)
                and 400 <= int(error.code) < 500
                and int(error.code) not in (408, 425, 429)
            )
            with self._lock:
                index = next(
                    (i for i, value in enumerate(self.pending) if value is item),
                    None,
                )
                if index is None:
                    return False
                if permanent:
                    self.pending.pop(index)
                    return "dropped"
                item["attempts"] += 1
                if (
                    item["attempts"] >= self.max_attempts
                    or now_value - item["created_at"] >= self.max_age_s
                ):
                    self.pending.pop(index)
                    return "dropped"
                item["next_at"] = float(now) + min(
                    60.0, float(2 ** min(item["attempts"], 6)),
                )
            return False
        with self._lock:
            for index, value in enumerate(self.pending):
                if value is item:
                    self.pending.pop(index)
                    break
        return True


class SignalEmitter(object):
    """Daemon sender for the detection worker's sparse metadata signals."""
    def __init__(self, url, camera_id, sender=post_signal, max_pending=8,
                 interval_s=0.5):
        self.url = url
        self.camera_id = camera_id
        self.sender = sender
        self.queue = SignalRetryQueue(max_pending=max_pending)
        self.interval_s = max(0.1, float(interval_s))
        self._thread = None

    def start(self):
        if self._thread is not None:
            return self._thread
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="signal-retry",
        )
        self._thread.start()
        return self._thread

    def emit(self, source, label, now=None, score=1.0, duration_s=0.0,
             event_id=None, correlation_id=None):
        observed_at = time.time() if now is None else float(now)
        payload = build_signal_payload(
            source, label, self.camera_id, observed_at,
            score=score, duration_s=duration_s,
            event_id=event_id, correlation_id=correlation_id,
        )
        self.queue.add(payload, observed_at)
        return payload

    def clear(self):
        self.queue.clear()

    def _run(self):
        warned = False
        while True:
            result = self.queue.flush_one(
                self.url, time.time(), sender=self.sender,
            )
            if result is False and not warned:
                log.warning("signal delivery failed; retrying bounded metadata queue")
                warned = True
            elif result == "dropped":
                log.warning("signal metadata dropped after permanent/bounded failure")
                warned = False
            elif result is True:
                warned = False
            time.sleep(self.interval_s)
