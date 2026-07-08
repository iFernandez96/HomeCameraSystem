from app.services.ota_restart import RecordingCommandRunner, record_restart_handoff


def test_given_restart_command_when_handoff_runs_with_default_runner_then_command_is_recorded_not_executed():
    result = record_restart_handoff(["systemctl", "restart", "homecam.service"])

    assert result.status == "recorded"
    assert result.handed_off is True
    assert result.argv == ("systemctl", "restart", "homecam.service")
    assert result.runner_result == {"recorded": True, "returncode": 0}


def test_given_injected_runner_when_handoff_runs_then_exact_argv_list_is_passed():
    runner = RecordingCommandRunner()

    result = record_restart_handoff(
        ["docker", "compose", "-f", "/tmp/staged/compose.yaml", "up", "-d"],
        runner=runner,
    )

    assert result.status == "recorded"
    assert result.argv == ("docker", "compose", "-f", "/tmp/staged/compose.yaml", "up", "-d")
    assert runner.commands == [result.argv]


def test_given_shell_string_when_restart_handoff_requested_then_rejected_before_runner():
    calls = []

    def runner(argv):
        calls.append(argv)

    result = record_restart_handoff("systemctl restart homecam.service", runner=runner)

    assert result.status == "rejected"
    assert result.reason == "invalid_argv"
    assert result.handed_off is False
    assert calls == []
