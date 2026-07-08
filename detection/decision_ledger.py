"""Capped JSONL decision ledger for the detection worker.

Pure Python 3.6 stdlib. The worker uses this for transition-level
observability and sampled flight-recorder rows. Writes are best-effort:
logging must never crash or stall inference, so OSError/EPIPE are swallowed
and counted.
"""
import json
import os
import time

import applog


class DecisionLedger(object):
    """Append one JSON object per line with single-file capped rotation.

    Rotation is a single ``.1`` rollover: when ``path`` is at or above
    ``max_bytes`` before an append, ``path`` is renamed to ``path + ".1"``
    and a fresh file is opened for the next row.
    """

    def __init__(self, path, max_bytes=10 * 1024 * 1024, clock=None):
        self.path = path
        self.max_bytes = max_bytes
        self.clock = clock if clock is not None else time.time
        self.errors = 0
        self._warned = False

    def append(self, tag, fields):
        if not self.path:
            return False
        try:
            row = {"ts": self.clock(), "tag": tag}
            if isinstance(fields, dict):
                row.update(fields)
            line = json.dumps(row, sort_keys=True, separators=(",", ":"))
            self._rotate_if_needed()
            parent = os.path.dirname(os.path.abspath(self.path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(self.path, "a") as f:
                f.write(line)
                f.write("\n")
            return True
        except OSError as e:
            self._count_error(e)
        except (TypeError, ValueError) as e:
            self._count_error(e)
        return False

    def _rotate_if_needed(self):
        if self.max_bytes is None or self.max_bytes <= 0:
            return
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return
        if size < self.max_bytes:
            return
        rollover = self.path + ".1"
        try:
            if os.path.exists(rollover):
                os.unlink(rollover)
            os.rename(self.path, rollover)
        except OSError as e:
            self._count_error(e)

    def _count_error(self, err):
        self.errors += 1
        if not self._warned:
            applog.emit(
                "ledger",
                "decision ledger write failed for {}: {}: {}".format(
                    self.path, type(err).__name__, err,
                ),
            )
            self._warned = True
