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

import re
from pathlib import Path

import pytest
import yaml


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_MEDIAMTX_YML = _REPO_ROOT / "deploy" / "mediamtx.yml"

# MediaMTX expands $RTSP_PORT at runtime; the config commits 8554 as the
# rtspAddress, so the published source URL the rungs must read from is:
_CAM_SOURCE_URL = "rtsp://localhost:8554/cam"


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
    command = _normalize(paths["cam"]["runOnInit"])
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
    command = _normalize(paths["cam"]["runOnInit"])
    # assert — watchdog present, with a finite (non-zero = enabled) timeout,
    # and downstream of the encoder/parser (not on the NVMM sensor caps).
    assert "watchdog timeout=5000" in command, "publish pipeline must have a stall watchdog"
    assert command.index("h264parse") < command.index("watchdog"), (
        "watchdog must sit after h264parse (post-encoder regular memory)"
    )
