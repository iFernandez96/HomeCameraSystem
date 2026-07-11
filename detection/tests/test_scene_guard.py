from scene_guard import SceneGuard


def test_three_dark_samples_emit_one_covered_alert_until_recovery():
    guard = SceneGuard(consecutive=3)
    assert guard.observe(3, 8, 1) is None
    assert guard.observe(3, 8, 1) is None
    assert guard.observe(3, 8, 1) == "camera_covered"
    assert guard.observe(3, 8, 1) is None
    assert guard.observe(80, 20, 2) is None
    assert guard.observe(3, 8, 1) is None
    assert guard.observe(3, 8, 1) is None
    assert guard.observe(3, 8, 1) == "camera_covered"


def test_large_persistent_scene_difference_emits_moved_alert():
    guard = SceneGuard(consecutive=2, moved_difference=40)
    assert guard.observe(90, 30, 50) is None
    assert guard.observe(92, 31, 48) == "camera_moved"


def test_normal_scene_never_alerts():
    guard = SceneGuard(consecutive=2)
    for _ in range(10):
        assert guard.observe(90, 25, 3) is None


def test_one_time_displacement_is_confirmed_against_held_reference():
    guard = SceneGuard(consecutive=2, moved_difference=40)
    first = guard.observe(90, 25, 55)
    assert first is None
    assert guard.should_update_reference(90, 25, 55, first) is False

    second = guard.observe(91, 24, 54)
    assert second == "camera_moved"
    assert guard.should_update_reference(91, 24, 54, second) is True


def test_suspend_clears_partial_tamper_candidate():
    guard = SceneGuard(consecutive=2, moved_difference=40)
    assert guard.observe(90, 25, 55) is None
    guard.suspend()
    assert guard.observe(90, 25, 55) is None
