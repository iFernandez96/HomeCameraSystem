from doorbell import DebouncedButton


def test_press_emits_once_after_debounce_and_rearms_on_release():
    button = DebouncedButton(debounce_s=0.05, refractory_s=0.2)
    assert button.update(True, 0.0) is False
    assert button.update(True, 0.03) is False
    assert button.update(True, 0.06) is True
    assert button.update(True, 0.20) is False
    assert button.update(False, 0.21) is False
    assert button.update(True, 0.30) is False
    assert button.update(True, 0.36) is True


def test_contact_bounce_does_not_emit():
    button = DebouncedButton(debounce_s=0.05)
    assert button.update(True, 1.0) is False
    assert button.update(False, 1.02) is False
    assert button.update(True, 1.03) is False
    assert button.update(False, 1.04) is False
