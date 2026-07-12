from camera_quality import CameraQualityGuard


def _warm(guard, sharpness=20.0):
    for _ in range(6):
        assert guard.observe(sharpness, 2.0) in (None, "camera_quality_recovered")


def test_given_learned_sharp_scene_when_focus_collapses_then_blur_requires_sustained_samples():
    guard = CameraQualityGuard(consecutive=3, baseline_samples=6)
    _warm(guard)
    assert guard.observe(2.0, 2.0) is None
    assert guard.observe(2.0, 2.0) is None
    assert guard.observe(2.0, 2.0) == "camera_blurred"
    assert guard.state == CameraQualityGuard.BLURRED


def test_given_static_but_noisy_scene_when_observed_then_it_is_not_called_frozen():
    guard = CameraQualityGuard(consecutive=3)
    _warm(guard)
    for _ in range(10):
        assert guard.observe(20.0, 0.5) is None
    assert guard.state == CameraQualityGuard.CLEAR


def test_given_identical_frames_when_sustained_then_frozen_emits_once_and_recovers():
    guard = CameraQualityGuard(consecutive=3)
    _warm(guard)
    assert guard.observe(20.0, 0.0) is None
    assert guard.observe(20.0, 0.0) is None
    assert guard.observe(20.0, 0.0) == "camera_frozen"
    assert guard.observe(20.0, 0.0) is None
    assert guard.observe(20.0, 1.0) == "camera_quality_recovered"


def test_given_blur_before_baseline_when_observed_then_guard_does_not_guess():
    guard = CameraQualityGuard(consecutive=2, baseline_samples=6)
    for _ in range(5):
        assert guard.observe(0.1, 1.0) is None
    assert guard.state == CameraQualityGuard.CLEAR
