from app.services.alert_policy import decide_alert


def event(**changes):
    value = {"label": "person", "score": 0.8, "person_name": None}
    value.update(changes)
    return value


def test_unknown_person_is_urgent_when_away_or_at_night():
    for mode in ("away", "night"):
        decision = decide_alert(event(), mode)
        assert decision.importance == "urgent"
        assert decision.require_interaction is True
        assert decision.silent is False


def test_known_person_at_home_is_routine_and_silent():
    decision = decide_alert(event(person_name="israel"), "home")
    assert decision.importance == "routine"
    assert decision.reason == "known_person_home"
    assert decision.silent is True


def test_privacy_mode_suppresses_even_if_stale_worker_posts_event():
    decision = decide_alert(event(), "privacy")
    assert decision.importance == "suppressed"


def test_animals_are_routine_and_silent():
    decision = decide_alert(event(label="cat"), "away")
    assert decision.importance == "routine"
    assert decision.silent is True


def test_camera_tamper_is_urgent():
    decision = decide_alert(event(label="camera_covered"), "home")
    assert decision.importance == "urgent"
    assert decision.reason == "camera_tamper"


def test_doorbell_press_is_urgent_in_every_watching_mode():
    for mode in ("home", "away", "night"):
        decision = decide_alert(event(label="doorbell"), mode)
        assert decision.importance == "urgent"
        assert decision.reason == "doorbell_pressed"


def test_audio_emergency_and_possible_theft_are_urgent():
    for value in (
        event(label="audio_smoke_alarm"),
        event(label="audio_glass_break"),
        event(package_state="possible_theft"),
    ):
        assert decide_alert(value, "home").importance == "urgent"


def test_package_delivery_is_notable_and_dog_bark_is_routine():
    assert decide_alert(event(label="package_delivered"), "home").importance == "notable"
    dog = decide_alert(event(label="audio_dog_bark"), "away")
    assert dog.importance == "routine" and dog.silent is True
