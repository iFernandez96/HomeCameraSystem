"""Low-duty recv-only WHEP probe for the Jetson host.

The scheduler is pure Python and dependency-free.  The production runner loads
GStreamer introspection lazily so importing the detection worker and running its
unit tests do not require host-only ``gi`` modules.

Must stay Python 3.6 compatible (JetPack 4.x host Python).
"""
import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


log = logging.getLogger(__name__)


DEFAULT_RUNGS = (
    ("cam", 60.0),
    ("cam_lq", 300.0),
    ("cam_uq", 300.0),
)
DEFAULT_TIMEOUT_S = 8.0
DEFAULT_FAILURE_THRESHOLD = 3
H264_RTP_CAPS = (
    "application/x-rtp,media=video,encoding-name=H264,"
    "clock-rate=90000,payload=96"
)


class ProbeResult(object):
    def __init__(self, rung, result, reason, checked_at, ttff_ms=0.0,
                 signaling_ok=False, media_received=False, recoverable=False):
        self.rung = rung
        self.result = result
        self.reason = reason
        self.checked_at = float(checked_at)
        self.ttff_ms = float(ttff_ms)
        self.signaling_ok = bool(signaling_ok)
        self.media_received = bool(media_received)
        self.recoverable = bool(recoverable)

    @property
    def ok(self):
        return self.signaling_ok and self.media_received


class WhepProbeScheduler(object):
    """Serialize bounded probes and debounce one recovery per outage."""

    def __init__(self, runner, metrics, on_recovery, rungs=None,
                 timeout_s=DEFAULT_TIMEOUT_S,
                 failure_threshold=DEFAULT_FAILURE_THRESHOLD, now=None):
        self.runner = runner
        self.metrics = metrics
        self.on_recovery = on_recovery
        self.rungs = tuple(rungs or DEFAULT_RUNGS)
        self.timeout_s = float(timeout_s)
        self.failure_threshold = max(1, int(failure_threshold))
        self._now = now or time.time
        started = self._now()
        # Stagger the first adaptive probes while still checking every rung
        # promptly after boot.  Subsequent deadlines use their full cadence.
        self._next_due = dict(
            (name, started + (index * 10.0))
            for index, (name, _cadence) in enumerate(self.rungs)
        )
        self._cadence = dict(self.rungs)
        self._consecutive = dict((name, 0) for name, _cadence in self.rungs)
        self._recovery_requested = False
        self._run_lock = threading.Lock()

    def run_due_once(self, now=None):
        current = self._now() if now is None else float(now)
        due = [
            name for name, _cadence in self.rungs
            if current >= self._next_due[name]
        ]
        if not due or not self._run_lock.acquire(False):
            return None
        rung = due[0]
        try:
            result = self.runner.run(rung, self.timeout_s)
            self._record(result)
            finished = self._now() if now is None else current
            self._next_due[rung] = finished + self._cadence[rung]
            return result
        finally:
            self._run_lock.release()

    def _record(self, result):
        self.metrics.whep_probe_rung = result.rung
        self.metrics.whep_probe_result = result.result
        self.metrics.whep_probe_fail_reason = result.reason
        self.metrics.whep_probe_ttff_ms = result.ttff_ms if result.ok else 0.0
        if result.ok:
            self.metrics.whep_probe_last_ok_ts = result.checked_at
            self._consecutive[result.rung] = 0
        else:
            self._consecutive[result.rung] += 1
        self.metrics.whep_probe_consec_fails = max(self._consecutive.values())
        log.info(
            "whep_probe rung=%s result=%s reason=%s ttff_ms=%.1f consecutive=%d",
            result.rung,
            result.result,
            result.reason or "none",
            result.ttff_ms,
            self._consecutive[result.rung],
        )

        if all(value == 0 for value in self._consecutive.values()):
            self._recovery_requested = False
        if (
            not result.ok
            and result.recoverable
            and self._consecutive[result.rung] >= self.failure_threshold
            and not self._recovery_requested
        ):
            # The caller queues this result for the main detection loop.  The
            # caller invokes the existing persisted watchdog ladder; this
            # scheduler deliberately owns no recovery levels or cooldowns.
            self.on_recovery(result)
            self._recovery_requested = True

    def seconds_until_due(self, now=None):
        current = self._now() if now is None else float(now)
        return max(0.0, min(self._next_due.values()) - current)

    def recovery_needed(self):
        """Whether the debounced incident still requires its one ladder action."""
        return self._recovery_requested


def start_scheduler(scheduler, sleep=None):
    sleeper = sleep or time.sleep

    def loop():
        while True:
            scheduler.run_due_once()
            sleeper(max(0.25, min(5.0, scheduler.seconds_until_due())))

    thread = threading.Thread(target=loop, name="whep-probe", daemon=True)
    thread.start()
    return thread


class GstWhepRunner(object):
    """One recv-only GStreamer WebRTC session, closed on first RTP buffer."""

    def __init__(self, whep_base, grant_url, worker_secret, now=None,
                 monotonic=None):
        self.whep_base = whep_base.rstrip("/")
        self.grant_url = grant_url
        self.worker_secret = worker_secret
        self._now = now or time.time
        self._monotonic = monotonic or time.monotonic

    def run(self, rung, timeout_s):
        checked_at = self._now()
        started = self._monotonic()
        try:
            token = self._grant(rung, min(3.0, timeout_s))
        except Exception as exc:
            return ProbeResult(
                rung, "probe_unavailable", _safe_reason("grant", exc),
                checked_at, recoverable=False,
            )
        try:
            remaining = max(0.1, float(timeout_s) - (self._monotonic() - started))
            session = _GstWhepSession(
                "{}/{}/whep".format(self.whep_base, rung),
                token,
                remaining,
                self._monotonic,
            )
            return session.run(rung, checked_at)
        except Exception as exc:
            return ProbeResult(
                rung, "probe_unavailable", _safe_reason("backend", exc),
                checked_at, recoverable=False,
            )

    def _grant(self, rung, timeout_s):
        body = json.dumps({"path": rung}).encode("utf-8")
        request = urllib.request.Request(
            self.grant_url,
            data=body,
            headers={
                "Authorization": "Bearer " + self.worker_secret,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            payload = json.loads(response.read(4096).decode("utf-8"))
        token = payload.get("token") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token:
            raise ValueError("grant response missing token")
        return token


def _safe_reason(stage, exc):
    if isinstance(exc, urllib.error.HTTPError):
        return "{}_http_{}".format(stage, int(exc.code))[:64]
    if isinstance(exc, urllib.error.URLError):
        return "{}_unreachable".format(stage)
    return "{}_{}".format(stage, type(exc).__name__.lower())[:64]


class _GstWhepSession(object):
    """Lazy GI adapter.  Kept private so tests use fake runners."""

    def __init__(self, url, token, timeout_s, monotonic):
        import gi
        gi.require_version("Gst", "1.0")
        gi.require_version("GstSdp", "1.0")
        gi.require_version("GstWebRTC", "1.0")
        from gi.repository import GLib, Gst, GstSdp, GstWebRTC

        Gst.init(None)
        self.GLib = GLib
        self.Gst = Gst
        self.GstSdp = GstSdp
        self.GstWebRTC = GstWebRTC
        self.url = url
        self.token = token
        self.timeout_s = float(timeout_s)
        self.monotonic = monotonic
        self.started = 0.0
        self.loop = GLib.MainLoop()
        self.pipeline = Gst.Pipeline.new("homecam-whep-probe")
        self.webrtc = Gst.ElementFactory.make("webrtcbin", "probe")
        if self.webrtc is None:
            raise RuntimeError("webrtcbin unavailable")
        self.pipeline.add(self.webrtc)
        self.bus = self.pipeline.get_bus()
        self.bus.add_signal_watch()
        self.bus.connect("message::error", self._on_bus_error)
        self.webrtc.connect("on-negotiation-needed", self._on_negotiate)
        self.webrtc.connect("notify::ice-gathering-state", self._on_ice_state)
        self.webrtc.connect("notify::ice-connection-state", self._on_ice_connection)
        self.webrtc.connect("pad-added", self._on_pad_added)
        # GStreamer 1.14 does not assign a valid dynamic payload type when the
        # recv caps omit `payload`; it can serialize a random 32-bit value into
        # `a=rtpmap`, which MediaMTX correctly rejects as outside 0..127.
        caps = Gst.Caps.from_string(H264_RTP_CAPS)
        self.webrtc.emit(
            "add-transceiver",
            GstWebRTC.WebRTCRTPTransceiverDirection.RECVONLY,
            caps,
        )
        self.done = False
        self.signaling_ok = False
        self.result = None
        self.resource_url = None
        self._post_started = False

    def run(self, rung, checked_at):
        self.started = self.monotonic()
        self.GLib.timeout_add(int(self.timeout_s * 1000), self._on_timeout)
        self.pipeline.set_state(self.Gst.State.PLAYING)
        try:
            self.loop.run()
        finally:
            self.pipeline.set_state(self.Gst.State.NULL)
            self.bus.remove_signal_watch()
            self._delete_resource()
        if self.result is not None:
            return ProbeResult(
                rung,
                self.result.result,
                self.result.reason,
                checked_at,
                ttff_ms=self.result.ttff_ms,
                signaling_ok=self.result.signaling_ok,
                media_received=self.result.media_received,
                recoverable=self.result.recoverable,
            )
        return ProbeResult(
            rung, "no_media", "timeout_no_rtp", checked_at,
            signaling_ok=self.signaling_ok, recoverable=True,
        )

    def _on_negotiate(self, _element):
        promise = self.Gst.Promise.new_with_change_func(self._on_offer, None)
        self.webrtc.emit("create-offer", None, promise)

    def _on_offer(self, promise, _unused):
        reply = promise.get_reply()
        offer = reply.get_value("offer") if reply is not None else None
        if offer is None:
            self._finish_failure("signaling_failure", "offer_failed", False)
            return
        self.webrtc.emit(
            "set-local-description", offer, self.Gst.Promise.new()
        )
        self._maybe_post_offer()

    def _on_ice_state(self, _element, _param):
        self._maybe_post_offer()

    def _on_ice_connection(self, element, _param):
        state = element.get_property("ice-connection-state")
        name = getattr(state, "value_nick", str(state))
        log.info("whep_probe ice_connection_state=%s", name)
        if state == self.GstWebRTC.WebRTCICEConnectionState.FAILED:
            self._finish_failure("transport_failure", "ice_failed", True)

    def _maybe_post_offer(self):
        if self._post_started:
            return
        description = self.webrtc.get_property("local-description")
        state = self.webrtc.get_property("ice-gathering-state")
        if description is None:
            return
        if state != self.GstWebRTC.WebRTCICEGatheringState.COMPLETE:
            return
        self._post_started = True
        sdp_text = description.sdp.as_text()
        thread = threading.Thread(
            target=self._post_offer,
            args=(sdp_text,),
            name="whep-probe-signal",
            daemon=True,
        )
        thread.start()

    def _post_offer(self, sdp_text):
        request = urllib.request.Request(
            self.url,
            data=sdp_text.encode("utf-8"),
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/sdp",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                answer = response.read(256 * 1024).decode("utf-8")
                self.resource_url = response.headers.get("Location")
        except urllib.error.HTTPError as exc:
            self.GLib.idle_add(
                self._finish_failure,
                "signaling_failure",
                "whep_http_{}".format(int(exc.code)),
                True,
            )
            return
        except Exception as exc:
            self.GLib.idle_add(
                self._finish_failure,
                "signaling_failure",
                _safe_reason("whep", exc),
                True,
            )
            return
        self.GLib.idle_add(self._apply_answer, answer)

    def _apply_answer(self, answer):
        _result, message = self.GstSdp.SDPMessage.new()
        parsed = self.GstSdp.sdp_message_parse_buffer(
            answer.encode("utf-8"), message
        )
        if parsed != self.GstSdp.SDPResult.OK:
            return self._finish_failure(
                "signaling_failure", "invalid_answer", True
            )
        description = self.GstWebRTC.WebRTCSessionDescription.new(
            self.GstWebRTC.WebRTCSDPType.ANSWER, message
        )
        promise = self.Gst.Promise.new_with_change_func(
            self._on_remote_description_set, None
        )
        self.webrtc.emit("set-remote-description", description, promise)
        return False

    def _on_remote_description_set(self, promise, _unused):
        reply = promise.get_reply()
        if reply is not None and reply.has_field("error"):
            self.GLib.idle_add(
                self._finish_failure,
                "signaling_failure",
                "remote_description_rejected",
                True,
            )
            return
        self.GLib.idle_add(self._remote_description_ready)

    def _remote_description_ready(self):
        self.signaling_ok = True
        state = self.webrtc.get_property("ice-connection-state")
        log.info(
            "whep_probe remote_description=applied ice_connection_state=%s",
            getattr(state, "value_nick", str(state)),
        )
        return False

    def _on_bus_error(self, _bus, message):
        error, _debug = message.parse_error()
        log.warning(
            "whep_probe gstreamer_error=%s", type(error).__name__
        )
        self._finish_failure("transport_failure", "gstreamer_error", True)

    def _on_pad_added(self, _element, pad):
        if pad.get_direction() != self.Gst.PadDirection.SRC:
            return
        pad.add_probe(self.Gst.PadProbeType.BUFFER, self._on_rtp_buffer)
        queue = self.Gst.ElementFactory.make("queue", None)
        sink = self.Gst.ElementFactory.make("fakesink", None)
        if queue is None or sink is None:
            self._finish_failure("probe_unavailable", "fakesink_unavailable", False)
            return
        sink.set_property("sync", False)
        self.pipeline.add(queue)
        self.pipeline.add(sink)
        queue.link(sink)
        queue.sync_state_with_parent()
        sink.sync_state_with_parent()
        pad.link(queue.get_static_pad("sink"))

    def _on_rtp_buffer(self, _pad, _info):
        if self.done:
            return self.Gst.PadProbeReturn.REMOVE
        ttff_ms = max(0.0, (self.monotonic() - self.started) * 1000.0)
        self.result = ProbeResult(
            "", "success", "", time.time(), ttff_ms=ttff_ms,
            signaling_ok=True, media_received=True, recoverable=False,
        )
        self.GLib.idle_add(self._finish_success)
        return self.Gst.PadProbeReturn.REMOVE

    def _finish_success(self):
        self.done = True
        self.loop.quit()
        return False

    def _finish_failure(self, result, reason, recoverable):
        if self.done:
            return False
        self.done = True
        self.result = ProbeResult(
            "", result, reason, time.time(), signaling_ok=self.signaling_ok,
            recoverable=recoverable,
        )
        self.loop.quit()
        return False

    def _on_timeout(self):
        if self.done:
            return False
        result = "no_media" if self.signaling_ok else "signaling_failure"
        reason = "timeout_no_rtp" if self.signaling_ok else "signaling_timeout"
        return self._finish_failure(result, reason, True)

    def _delete_resource(self):
        if not self.resource_url:
            return
        try:
            resource_url = urllib.parse.urljoin(self.url, self.resource_url)
            request = urllib.request.Request(
                resource_url,
                headers={"Authorization": "Bearer " + self.token},
                method="DELETE",
            )
            urllib.request.urlopen(request, timeout=2.0).close()
        except Exception:
            pass
