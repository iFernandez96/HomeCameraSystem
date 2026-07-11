#!/usr/bin/env python3
"""Optional privacy-aware acoustic-event watcher for the ``/listen`` feed.

The process asks ffmpeg for one-second, mono, 16 kHz PCM windows, immediately
reduces each window to scalar features in :mod:`audio_events`, and discards the
bytes.  Raw microphone audio is never written, included in a request, or
logged.  The service is intentionally separate from ``detect.py`` so a missing
microphone or ffmpeg failure cannot affect the vision worker.

This is a conservative heuristic fallback.  It should remain disabled until a
microphone is intentionally configured and the operator enables audio events.

Python 3.6 compatible.
"""
import json
import logging
import os
import select
import subprocess
import time
import urllib.request
from urllib.parse import urlparse

import camera_ident
from audio_events import AUDIO_LABELS, AudioEventGate, classify_pcm16le
from signal_retry import SignalRetryQueue, build_signal_payload, post_signal


log = logging.getLogger("audio_watch")
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
_WINDOW_S = 1.0
_SAMPLE_RATE = 16000
_WINDOW_BYTES = int(_SAMPLE_RATE * _WINDOW_S) * 2


def _env_bool(name, default=False):
    value = os.getenv(name)
    if value is None:
        return bool(default)
    return value not in ("0", "false", "False", "no", "NO", "off", "OFF", "")


def _require_loopback(url, field):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or host not in _LOOPBACK_HOSTS:
        raise ValueError("{} must be an HTTP loopback URL".format(field))
    return url


class AudioRuntimeConfig(object):
    def __init__(self):
        self.enabled = False
        self.labels = []
        self.operating_mode = "home"

    def active(self):
        return (
            self.enabled
            and self.operating_mode != "privacy"
            and bool(self.labels)
        )


def apply_audio_config(runtime, data):
    """Apply only the fields the watcher needs; reject unsafe coercions."""
    if not isinstance(data, dict):
        raise ValueError("config response must be an object")
    warnings = []
    if "audio_event_enabled" in data:
        value = data["audio_event_enabled"]
        if isinstance(value, bool):
            runtime.enabled = value
        else:
            warnings.append("audio_event_enabled must be bool")
    if "audio_event_labels" in data:
        raw = data["audio_event_labels"]
        if isinstance(raw, list):
            runtime.labels = [
                value for value in AUDIO_LABELS
                if value in raw
            ]
        else:
            warnings.append("audio_event_labels must be list")
    if "operating_mode" in data:
        value = data["operating_mode"]
        if value in ("home", "away", "night", "privacy"):
            runtime.operating_mode = value
        else:
            warnings.append("operating_mode is unknown")
    return warnings


def should_reset_audio_state(previous, runtime):
    """True when pending alerts must be discarded for an operator change."""
    if previous is None:
        return False
    previous_enabled, previous_labels, previous_mode = previous
    if previous_enabled and not runtime.enabled:
        return True
    if tuple(runtime.labels) != tuple(previous_labels):
        return True
    if previous_mode != "privacy" and runtime.operating_mode == "privacy":
        return True
    return False


def fetch_config(url, runtime, timeout=2.0):
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    return apply_audio_config(runtime, data)


def _spawn_decoder(ffmpeg, listen_url):
    # The RTSP URL may eventually contain credentials.  Do not log the command
    # or URL, and discard ffmpeg diagnostics so it cannot echo them to journal.
    return subprocess.Popen(
        [
            ffmpeg,
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-rtsp_transport", "tcp", "-i", listen_url,
            "-vn", "-ac", "1", "-ar", str(_SAMPLE_RATE),
            "-f", "s16le", "pipe:1",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def read_window(process, size=_WINDOW_BYTES, timeout_s=3.0):
    """Read a bounded PCM window without allowing a wedged ffmpeg to block."""
    if process.stdout is None:
        return None
    fd = process.stdout.fileno()
    deadline = time.monotonic() + float(timeout_s)
    chunks = []
    remaining = int(size)
    while remaining > 0:
        wait_s = deadline - time.monotonic()
        if wait_s <= 0:
            return None
        ready, _writable, _errors = select.select([fd], [], [], wait_s)
        if not ready:
            return None
        chunk = os.read(fd, min(remaining, 8192))
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def stop_decoder(process):
    if process is None:
        return
    try:
        process.terminate()
        process.wait(timeout=2.0)
    except Exception:
        try:
            process.kill()
            process.wait(timeout=2.0)
        except Exception:
            pass


def build_signal(event, camera_id, now):
    """Build the strict metadata-only `/signal` payload."""
    return build_signal_payload(
        "audio", event["label"], camera_id, now,
        score=event["score"], duration_s=event["duration_s"],
        correlation_id=event["correlation_id"],
    )


def run():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    listen_url = os.getenv("AUDIO_LISTEN_URL", "rtsp://127.0.0.1:8554/listen")
    signal_url = _require_loopback(
        os.getenv(
            "AUDIO_SIGNAL_URL",
            "http://127.0.0.1:8000/api/_internal/signal",
        ),
        "AUDIO_SIGNAL_URL",
    )
    config_url = _require_loopback(
        os.getenv(
            "AUDIO_CONFIG_URL",
            "http://127.0.0.1:8000/api/_internal/detection/config",
        ),
        "AUDIO_CONFIG_URL",
    )
    ffmpeg = os.getenv("AUDIO_FFMPEG", "ffmpeg")
    camera_id = camera_ident.camera_id_from_env()
    poll_s = max(1.0, float(os.getenv("AUDIO_CONFIG_POLL_S", "5")))
    runtime = AudioRuntimeConfig()
    gate = AudioEventGate([])
    retries = SignalRetryQueue()
    process = None
    next_poll = 0.0
    was_private = False
    config_warned = False
    decoder_warned = False
    previous_config_state = None
    log.info("audio watcher ready; capture remains off until config enables it")

    while True:
        now = time.time()
        if now >= next_poll:
            try:
                warnings = fetch_config(config_url, runtime)
                if warnings:
                    log.warning("audio config ignored invalid field(s): %s", ", ".join(warnings))
                if should_reset_audio_state(previous_config_state, runtime):
                    retries.clear()
                    gate = AudioEventGate(runtime.labels)
                else:
                    gate.set_labels(runtime.labels)
                previous_config_state = (
                    runtime.enabled,
                    tuple(runtime.labels),
                    runtime.operating_mode,
                )
                config_warned = False
            except Exception as error:
                if not config_warned:
                    log.warning(
                        "audio config poll failed; retaining last safe state: %s",
                        type(error).__name__,
                    )
                    config_warned = True
            next_poll = now + poll_s

        private = runtime.operating_mode == "privacy"
        if private and not was_private:
            # Privacy mode is a hard boundary.  Drop metadata that was pending
            # retry as well as stopping acquisition; there is no raw data in
            # the queue, but this avoids a delayed pre-privacy notification.
            retries.clear()
            gate = AudioEventGate(runtime.labels)
        was_private = private

        if not runtime.active():
            stop_decoder(process)
            process = None
            time.sleep(min(1.0, max(0.1, next_poll - time.time())))
            continue

        retries.flush_one(signal_url, now)
        if process is None or process.poll() is not None:
            stop_decoder(process)
            try:
                process = _spawn_decoder(ffmpeg, listen_url)
                decoder_warned = False
            except Exception as error:
                if not decoder_warned:
                    log.warning("audio decoder unavailable: %s", type(error).__name__)
                    decoder_warned = True
                time.sleep(2.0)
                continue

        pcm = read_window(process)
        if pcm is None:
            if not decoder_warned:
                log.warning("audio decoder produced no bounded PCM window; restarting")
                decoder_warned = True
            stop_decoder(process)
            process = None
            continue

        # `classify_pcm16le` reduces the bounded byte string immediately.  The
        # loop holds no reference to it after this iteration and never logs it.
        predictions = classify_pcm16le(pcm)
        event = gate.observe(predictions, now, window_s=_WINDOW_S)
        del pcm
        if event is not None:
            payload = build_signal(event, camera_id, now)
            retries.add(payload, now)
            result = retries.flush_one(signal_url, now)
            if result is True:
                log.info("audio event metadata sent label=%s", event["label"])


if __name__ == "__main__":
    run()
