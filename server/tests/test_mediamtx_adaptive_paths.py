"""Pin the cellular-adaptive transcode ladder in `deploy/mediamtx.yml`.

The PWA's adaptive-bitrate switcher pulls WHEP from `cam_lq` / `cam_uq`
when it detects a constrained (cellular) link. Those rungs are produced
by MediaMTX `runOnDemand` GStreamer pipelines that TRANSCODE the already-
published `rtsp://localhost:8554/cam` stream — they do NOT open a second
camera (single-owner libargus, see CLAUDE.md).

These are static config-shape tests. We do NOT launch MediaMTX or
GStreamer here — on-device transcode + tegrastats headroom validation is
operator-side. We only assert the YAML wires the rungs the way the client
and the design expect:

  1. Both `cam_lq` and `cam_uq` paths exist.
  2. Each rung's `runOnDemand` command reads from the published `cam`
     RTSP stream (so it's a transcode, not a second capture).
  3. Each rung's `runOnDemand` command writes back to ITS OWN target
     path (`cam_lq` / `cam_uq`), not some other rung.
  4. Each rung sets `runOnDemandCloseAfter` so an idle rung tears the
     transcode down and frees NVENC/NVDEC.
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

import pytest
import yaml


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_MEDIAMTX_YML = _REPO_ROOT / "deploy" / "mediamtx.yml"
_MEDIAMTX_SERVICE = _REPO_ROOT / "deploy" / "systemd" / "mediamtx.service"
_DETECT_SERVICE = _REPO_ROOT / "deploy" / "systemd" / "homecam-detect.service"

# MediaMTX expands $RTSP_PORT at runtime; the config commits 8554 as the
# rtspAddress, so the published source URL the rungs must read from is:
_CAM_SOURCE_URL = "rtsp://localhost:8554/cam"
_CAMERA_SCRIPT = _REPO_ROOT / "deploy" / "run-camera-pipeline.sh"


@pytest.fixture(scope="module")
def paths() -> dict:
    """Load the MediaMTX config's `paths:` mapping once per module."""
    # arrange
    with _MEDIAMTX_YML.open("r", encoding="utf-8") as fh:
        config = yaml.safe_load(fh)
    return config["paths"]


def _normalize(command: str) -> str:
    """Collapse whitespace and expand the $RTSP_PORT placeholder to the
    committed 8554 so substring assertions match regardless of YAML line
    folding."""
    expanded = command.replace("$RTSP_PORT", "8554")
    return re.sub(r"\s+", " ", expanded)


def _camera_publish_script(paths: dict) -> str:
    """Resolve the committed camera publisher referenced by ``runOnInit``.

    The camera pipeline is a script because it selects temporary focus mode at
    runtime.  Keep the config-to-script boundary pinned while inspecting the
    actual pipeline rather than assuming it remains inline YAML.
    """
    command = paths["cam"]["runOnInit"].strip()
    script = Path(command.split()[0])
    if script.is_absolute():
        try:
            script = _REPO_ROOT / script.relative_to("/home/israel/HomeCameraSystem")
        except ValueError:
            pytest.fail("cam runOnInit points outside the deployed project: {}".format(script))
    assert script.is_file(), "cam runOnInit script is missing: {}".format(script)
    return _normalize(script.read_text(encoding="utf-8"))


def _run_camera_script_with_privacy(
    tmp_path: Path,
    content: str | None,
    exposure_content: str | None = None,
    *,
    precision: bool = True,
) -> str:
    """Run the shell wrapper against a fake gst-launch and return its argv."""
    # arrange
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    gst = fake_bin / "gst-launch-1.0"
    gst.write_text(
        '#!/usr/bin/env bash\nprintf "GST_ARGS:%s\\n" "$*"\n',
        encoding="utf-8",
    )
    gst.chmod(0o755)
    privacy = tmp_path / "privacy.env"
    if content is not None:
        privacy.write_text(content, encoding="utf-8")
    exposure = tmp_path / "exposure.env"
    if exposure_content is not None:
        exposure.write_text(exposure_content, encoding="utf-8")
    focus_marker = tmp_path / "focus-mode-expires"
    if precision:
        focus_marker.write_text(str(int(time.time()) + 3600) + "\n", encoding="utf-8")
    env = os.environ.copy()
    env.update({
        "PATH": "{}:{}".format(fake_bin, env.get("PATH", "")),
        "HOMECAM_PRIVACY_CONFIG": str(privacy),
        "HOMECAM_EXPOSURE_CONFIG": str(exposure),
        "HOMECAM_FOCUS_MARKER": str(focus_marker),
    })

    # act
    result = subprocess.run(
        ["bash", str(_CAMERA_SCRIPT)],
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )
    return result.stdout + result.stderr


def test_Given_no_precision_session_When_camera_starts_Then_one_bounded_encode_feeds_both_paths(tmp_path):
    output = _run_camera_script_with_privacy(
        tmp_path,
        "PRIVACY_RECTS=''\n",
        precision=False,
    )

    assert "stable 1080p30 sensor -> one 720p30 encode" in output
    assert "nvarguscamerasrc sensor-mode=1" in output
    assert "width=1920,height=1080,framerate=30/1" in output
    assert output.count("nvv4l2h264enc") == 1
    assert "tee name=encoded" in output
    assert "rtsp://localhost:8554/cam " in output
    assert "rtsp://localhost:8554/cam_uhq" in output


@pytest.mark.parametrize("rung", ["cam_lq", "cam_uq"])
def test_Given_mediamtx_config_When_loaded_Then_adaptive_rung_path_exists(paths, rung):
    # arrange / act
    rung_cfg = paths.get(rung)
    # assert
    assert rung_cfg is not None, "missing adaptive rung path: {}".format(rung)


@pytest.mark.parametrize("rung", ["cam_lq", "cam_uq"])
def test_Given_adaptive_rung_When_inspected_Then_transcodes_published_cam_source(
    paths, rung
):
    # arrange
    command = _normalize(paths[rung]["runOnDemand"])
    # act / assert — reads from the PUBLISHED cam stream (transcode, not capture)
    assert (
        "rtspsrc location={}".format(_CAM_SOURCE_URL) in command
    ), "{} must read from the published {} stream".format(rung, _CAM_SOURCE_URL)
    # and there is no second camera capture in the rung pipeline
    assert "nvarguscamerasrc" not in command, "{} must not open the camera".format(rung)


@pytest.mark.parametrize("rung", ["cam_lq", "cam_uq"])
def test_Given_adaptive_rung_When_inspected_Then_writes_back_to_its_own_path(
    paths, rung
):
    # arrange
    command = _normalize(paths[rung]["runOnDemand"])
    target = "rtsp://localhost:8554/{}".format(rung)
    # act / assert
    assert (
        "rtspclientsink protocols=tcp location={}".format(target) in command
    ), "{} must publish back to {}".format(rung, target)


@pytest.mark.parametrize("rung", ["cam_lq", "cam_uq"])
def test_Given_adaptive_rung_When_inspected_Then_closes_after_idle(paths, rung):
    # arrange / act
    close_after = paths[rung].get("runOnDemandCloseAfter")
    # assert — idle rung must tear down to free NVENC/NVDEC
    assert close_after, "{} must set runOnDemandCloseAfter".format(rung)


@pytest.mark.parametrize("rung", ["cam_lq", "cam_uq"])
def test_Given_adaptive_rung_When_inspected_Then_software_encodes_for_webrtc(
    paths, rung
):
    """The low rungs MUST use software `x264enc tune=zerolatency`, NOT the
    hardware `nvv4l2h264enc`.

    The Tegra hardware encoder emits NON-MONOTONIC output PTS when fed by
    NVDEC in a transcode (verified on-device 2026-06-17). The bitstream has
    no B-frames, but gortsplib's DTS extractor in MediaMTX reads the
    backwards-jumping timestamps as frame reordering and kills every WebRTC
    reader with "WebRTC doesn't support H264 streams with B-frames" — the
    phone shows a black tile then an error. `x264enc tune=zerolatency`
    produces monotonic, B-frame-free, WebRTC-safe output. Do NOT
    "consolidate" these rungs back to nvv4l2h264enc to save CPU."""
    # arrange
    command = _normalize(paths[rung]["runOnDemand"])
    # act / assert
    assert "x264enc" in command, "{} must software-encode with x264enc".format(rung)
    assert (
        "tune=zerolatency" in command
    ), "{} x264enc must use tune=zerolatency (no B-frames)".format(rung)
    assert (
        "nvv4l2h264enc" not in command
    ), "{} must NOT use nvv4l2h264enc (scrambles PTS -> WebRTC B-frame reject)".format(
        rung
    )


def test_Given_hq_cam_path_When_inspected_Then_keeps_hardware_encoder(paths):
    """The always-on HQ `cam` path stays on hardware `nvv4l2h264enc`: it
    encodes live sensor frames (monotonic PTS, WebRTC-safe) and full-res
    software encode would be far too costly on the Nano."""
    # arrange / act
    command = _camera_publish_script(paths)
    # assert
    assert "nvv4l2h264enc" in command, "HQ cam path must keep the hardware encoder"
    assert "nvarguscamerasrc" in command, "HQ cam path is the single capture path"


def test_Given_hq_cam_path_When_inspected_Then_has_mid_stream_stall_watchdog(paths):
    """camera-recovery 2026-06-20: the publish pipeline carries a `watchdog`
    element so a mid-stream sensor/libargus stall errors the pipeline (→
    runOnInitRestart respawns) instead of silently producing no frames. It
    sits AFTER h264parse (post-encoder, regular memory) so it can't perturb
    the NVMM zero-copy path."""
    # arrange / act
    command = _camera_publish_script(paths)
    # assert — watchdog present, with a finite (non-zero = enabled) timeout,
    # and downstream of the encoder/parser (not on the NVMM sensor caps).
    assert "watchdog timeout=5000" in command, "publish pipeline must have a stall watchdog"
    assert command.index("h264parse") < command.index("watchdog"), (
        "watchdog must sit after h264parse (post-encoder regular memory)"
    )


def test_Given_hq_cam_path_When_inspected_Then_records_bounded_continuous_history(paths):
    """The investigation timeline records the already-encoded ``cam`` path.

    This must remain a path-level MediaMTX recorder (stream copy), not another
    GStreamer camera/decode/encode graph.  The two-hour bound is deliberately
    conservative for the Nano's current free-space runway.
    """
    # arrange
    cam = paths["cam"]

    # act / assert
    assert cam["record"] is True
    assert cam["recordFormat"] == "fmp4"
    assert cam["recordPath"] == "/srv/homecam-media/recordings/continuous/%path/%s"
    assert cam["recordPartDuration"] == "1s"
    assert cam["recordSegmentDuration"] == "5m"
    assert cam["recordDeleteAfter"] == "2h"
    assert paths["cam_uhq"].get("record", False) is False


@pytest.mark.parametrize(
    "privacy_content",
    [
        None,
        "PRIVACY_RECTS='1900,0,30,20'\n",
        "PRIVACY_RECTS='10,20,30,40'; echo unsafe\n",
    ],
)
def test_Given_missing_or_invalid_privacy_config_When_camera_starts_Then_masks_full_frame(
    tmp_path, privacy_content
):
    # arrange / act
    output = _run_camera_script_with_privacy(tmp_path, privacy_content)

    # assert
    assert "applying full-frame privacy mask without opening camera" in output
    assert "videotestsrc pattern=black is-live=true" in output
    assert "nvcompositor name=privacy" not in output
    assert "nvarguscamerasrc" not in output


def test_Given_explicit_empty_privacy_config_When_camera_starts_Then_unmasked_path_is_allowed(
    tmp_path,
):
    # arrange / act
    output = _run_camera_script_with_privacy(tmp_path, "PRIVACY_RECTS=''\n")

    # assert
    assert "nvcompositor name=privacy" not in output
    assert "nvarguscamerasrc sensor-mode=0" in output


def test_Given_legacy_exposure_file_When_4k_sensor_starts_Then_region_is_scaled(tmp_path):
    output = _run_camera_script_with_privacy(
        tmp_path,
        "PRIVACY_RECTS=''\n",
        (
            "AE_REGION='480 270 1440 810 1'\n"
            "AE_COMPENSATION='0.25'\n"
            "AE_LOCK='false'\n"
        ),
    )

    assert (
        "nvarguscamerasrc sensor-mode=0 exposurecompensation=0.25 "
        "aelock=false aeregion=960 540 2880 1620 1"
    ) in output


def test_Given_4k_exposure_file_When_sensor_starts_Then_region_is_not_rescaled(tmp_path):
    output = _run_camera_script_with_privacy(
        tmp_path,
        "PRIVACY_RECTS=''\n",
        (
            "AE_SENSOR_WIDTH='3840'\n"
            "AE_SENSOR_HEIGHT='2160'\n"
            "AE_REGION='960 540 2880 1620 1'\n"
            "AE_COMPENSATION='0.25'\n"
            "AE_LOCK='false'\n"
        ),
    )

    assert "aeregion=960 540 2880 1620 1" in output
    assert "aeregion=1920 1080 5760 3240 1" not in output


def test_Given_privacy_compositor_When_publishing_Then_encoder_input_is_nv12(tmp_path):
    """Normalize compositor output before either Jetson H.264 encoder branch.

    ``nvcompositor`` can negotiate RGBA output even when the sensor source is
    NV12.  The Nano encoder cannot consume that directly, so keep one NVMM
    conversion immediately before the fan-out tee.
    """
    # arrange / act
    output = _run_camera_script_with_privacy(
        tmp_path, "PRIVACY_RECTS='0,0,1919,1080'\n"
    )

    # assert
    compositor_output = (
        "nvcompositor name=privacy background=1 sink_0::zorder=0 "
        "sink_1::xpos=0 sink_1::ypos=0 sink_1::width=2559 "
        "sink_1::height=1440 sink_1::zorder=1 ! nvvidconv ! "
        "video/x-raw(memory:NVMM),format=NV12,width=2560,height=1440,"
        "framerate=30/1 ! tee name=camera"
    )
    assert compositor_output in output
    assert (
        "nvarguscamerasrc sensor-mode=0 exposurecompensation=0.0 aelock=false ! "
        "video/x-raw(memory:NVMM),width=3840,height=2160,framerate=30/1 ! "
        "queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 "
        "leaky=downstream ! nvvidconv ! "
        "video/x-raw(memory:NVMM),format=RGBA,width=2560,height=1440,"
        "framerate=30/1 ! privacy.sink_0"
    ) in output
    assert (
        "videotestsrc pattern=black is-live=true ! "
        "video/x-raw,width=2559,height=1440,framerate=30/1 ! nvvidconv ! "
        "video/x-raw(memory:NVMM),format=RGBA,width=2559,height=1440,"
        "framerate=30/1 ! privacy.sink_1"
    ) in output


def test_Given_continuous_recording_When_mediamtx_runs_Then_archive_files_are_private():
    # arrange / act
    unit = _MEDIAMTX_SERVICE.read_text(encoding="utf-8")

    # assert
    assert "UMask=0077" in unit


def test_Given_event_recording_When_detector_runs_Then_camera_files_are_private():
    # arrange / act
    unit = _DETECT_SERVICE.read_text(encoding="utf-8")

    # assert
    assert "UMask=0077" in unit


def test_Given_uhq_path_When_inspected_Then_stable_mode_is_default_and_precision_is_bounded(paths):
    # arrange / act
    command = _camera_publish_script(paths)

    # Each mutually exclusive graph has one libargus owner. Stable mode uses
    # one 720p encoder for both paths; an explicit focus marker selects the
    # time-bounded dual-encoder precision graph.
    assert paths["cam_uhq"]["source"] == "publisher"
    assert command.count("nvarguscamerasrc") == 2
    assert "HOMECAM_FOCUS_MARKER" in command
    assert "stable 1080p30 sensor -> one 720p30 encode" in command
    assert command.count("tee name=encoded") == 3
    # Precision mode retains mutually exclusive full-mask, partial-mask, and
    # unmasked graphs, each with one tee and two encoders.
    assert 'if [[ -n "$PRIVACY_RECTS" ]]' in command
    assert command.count("tee name=camera") == 3
    assert command.count("nvv4l2h264enc") == 9
    assert "sensor-mode=0" in command
    assert "width=3840,height=2160,framerate=30/1" in command
    assert "width=1280,height=720" in command
    assert "width=2560,height=1440" in command
    assert "max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream" in command
    assert "bitrate=8000000 vbv-size=8000000 peak-bitrate=9600000" in command
    assert "rtsp://localhost:${RTSP_PORT}/cam\"" in command
    assert "rtsp://localhost:${RTSP_PORT}/cam_uhq\"" in command
