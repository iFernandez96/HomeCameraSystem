import os
from types import SimpleNamespace

import recording_canary


def _success_runner(args, **_kwargs):
    if "-f" in args and "mp4" in args:
        output = args[-1]
        with open(output, "wb") as handle:
            handle.write(b"video" * 1024)
    return SimpleNamespace(returncode=0, stdout=b"PASSED", stderr=b"")


def test_given_healthy_rtsp_and_storage_when_canary_runs_then_decode_is_verified_and_temp_removed(tmp_path):
    # arrange
    posted = []

    # act
    code = recording_canary.run_canary(
        str(tmp_path),
        "rtsp://127.0.0.1/cam",
        "http://127.0.0.1/result",
        runner=_success_runner,
        post_result=lambda _url, body: posted.append(body) or True,
        clock=lambda: 1234.0,
    )

    # assert
    assert code == 0
    assert posted[0]["status"] == "ok"
    assert posted[0]["reason"] == "playable"
    assert posted[0]["sample_bytes"] >= 1024
    assert not list(tmp_path.glob(".recording-canary-*"))


def test_given_capture_failure_when_canary_runs_then_plain_reason_posts_and_artifacts_are_removed(tmp_path):
    # arrange
    posted = []

    def runner(args, **_kwargs):
        if "mp4" in args:
            with open(args[-1], "wb") as handle:
                handle.write(b"partial")
            return SimpleNamespace(returncode=1, stdout=b"", stderr=b"secret rtsp detail")
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    # act
    code = recording_canary.run_canary(
        str(tmp_path), "rtsp://secret/cam", "http://result",
        runner=runner,
        post_result=lambda _url, body: posted.append(body) or True,
    )

    # assert
    assert code == 1
    assert posted[0]["stage"] == "capture"
    assert posted[0]["reason"] == "capture_failed"
    assert "secret" not in str(posted[0])
    assert not list(tmp_path.glob(".recording-canary-*"))


def test_given_decode_failure_when_canary_runs_then_it_never_reports_playable(tmp_path):
    # arrange
    posted = []

    def runner(args, **_kwargs):
        if "mp4" in args:
            with open(args[-1], "wb") as handle:
                handle.write(b"video" * 1024)
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        return SimpleNamespace(returncode=1, stdout=b"", stderr=b"broken")

    # act
    code = recording_canary.run_canary(
        str(tmp_path), "rtsp://cam", "http://result",
        runner=runner,
        post_result=lambda _url, body: posted.append(body) or True,
    )

    # assert
    assert code == 1
    assert posted[0]["reason"] == "decode_failed"
    assert not list(tmp_path.glob(".recording-canary-*"))


def test_given_old_owned_temps_and_unrelated_files_when_cleaned_then_only_canary_artifacts_are_removed(tmp_path):
    # arrange
    owned = tmp_path / ".recording-canary-old.mp4.tmp"
    probe = tmp_path / ".recording-canary-write-old.tmp"
    event = tmp_path / "real-event.mp4.tmp"
    clip = tmp_path / "real-event.mp4"
    for path in (owned, probe, event, clip):
        path.write_bytes(b"x")

    # act
    assert recording_canary.cleanup_owned_temps(str(tmp_path)) is True

    # assert
    assert not owned.exists()
    assert not probe.exists()
    assert event.exists()
    assert clip.exists()


def test_given_result_endpoint_down_when_sample_is_playable_then_unit_fails_honestly(tmp_path):
    # act
    code = recording_canary.run_canary(
        str(tmp_path), "rtsp://cam", "http://result",
        runner=_success_runner,
        post_result=lambda _url, _body: False,
    )

    # assert
    assert code == 2
    assert not list(tmp_path.glob(".recording-canary-*"))

