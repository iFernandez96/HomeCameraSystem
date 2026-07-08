import pytest


def test_given_restart_argv_when_handoff_runs_then_injected_runner_records_exact_arguments():
    from app.services.backup_restore import run_restart_handoff

    recorded: list[list[str]] = []

    def runner(argv: list[str]) -> int:
        recorded.append(argv)
        return 0

    result = run_restart_handoff(
        ["systemctl", "restart", "homecam-server", "backup;rm -rf /"],
        runner=runner,
    )

    assert result == 0
    assert recorded == [["systemctl", "restart", "homecam-server", "backup;rm -rf /"]]


def test_given_shell_string_when_handoff_runs_then_command_is_rejected_before_runner():
    from app.services.backup_restore import run_restart_handoff

    def runner(_argv: list[str]) -> int:
        raise AssertionError("runner must not be called for invalid argv")

    with pytest.raises(ValueError):
        run_restart_handoff("sudo systemctl restart homecam-server", runner=runner)
