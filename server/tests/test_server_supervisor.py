import ast
import importlib.util
import json
import stat
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "deploy" / "server_supervisor.py"
SPEC = importlib.util.spec_from_file_location("server_supervisor", MODULE_PATH)
SUPERVISOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPERVISOR)


def args(tmp_path, **overrides):
    values = {
        "state_path": str(tmp_path / "state.json"),
        "health_url": "http://127.0.0.1:8000/healthz",
        "repo_root": str(ROOT),
        "interval_s": 0.0,
        "failure_threshold": 3,
        "max_restarts": 3,
        "window_s": 600.0,
        "once": True,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_given_two_failed_probes_when_evaluated_then_recovery_is_debounced():
    # arrange
    state = SUPERVISOR.new_state()

    # act
    first = SUPERVISOR.evaluate_probe(state, False, "healthz_unreachable", 1, 3, 3, 600)
    second = SUPERVISOR.evaluate_probe(state, False, "healthz_unreachable", 2, 3, 3, 600)

    # assert
    assert first == "none"
    assert second == "none"
    assert state["consecutive_failures"] == 2
    assert state["restart_times"] == []


def test_given_three_failed_probes_when_evaluated_then_one_server_restart_is_recorded():
    # arrange
    state = SUPERVISOR.new_state()

    # act
    actions = [
        SUPERVISOR.evaluate_probe(state, False, "healthz_unreachable", now, 3, 3, 600)
        for now in (1, 2, 3)
    ]

    # assert
    assert actions == ["none", "none", "restart_server"]
    assert state["last_action"] == "restart_server"
    assert state["last_reason"] == "healthz_unreachable"
    assert state["restart_times"] == [3.0]


def test_given_recovery_budget_exhausted_when_failures_continue_then_loop_latches():
    # arrange
    state = SUPERVISOR.new_state()
    state["restart_times"] = [10.0, 20.0, 30.0]

    # act
    actions = [
        SUPERVISOR.evaluate_probe(state, False, "healthz_http_500", now, 3, 3, 600)
        for now in (40, 41, 42)
    ]

    # assert
    assert actions == ["none", "none", "stop"]
    assert state["latched"] is True
    assert state["status"] == "structural_loop"
    assert state["last_action"] == "stop"
    assert state["last_action_result"] == "latched"


def test_given_old_restarts_when_window_expires_then_recovery_budget_rearms():
    # arrange
    state = SUPERVISOR.new_state()
    state["restart_times"] = [1.0, 2.0, 3.0]
    state["consecutive_failures"] = 2

    # act
    action = SUPERVISOR.evaluate_probe(
        state, False, "healthz_unreachable", 1000.0, 3, 3, 600.0,
    )

    # assert
    assert action == "restart_server"
    assert state["restart_times"] == [1000.0]


def test_given_a_healthy_probe_when_degraded_then_failure_debounce_resets():
    # arrange
    state = SUPERVISOR.new_state()
    state["status"] = "degraded"
    state["consecutive_failures"] = 2
    state["last_reason"] = "healthz_timeout"

    # act
    action = SUPERVISOR.evaluate_probe(state, True, "none", 10, 3, 3, 600)

    # assert
    assert action == "none"
    assert state["status"] == "healthy"
    assert state["consecutive_failures"] == 0
    assert state["last_reason"] == "none"


def test_given_a_recovery_action_when_run_then_budget_is_persisted_before_restart(tmp_path):
    # arrange
    calls = []

    def probe(_url):
        return False, "healthz_unreachable"

    state = SUPERVISOR.new_state()
    state["consecutive_failures"] = 2
    SUPERVISOR.save_state(str(tmp_path / "state.json"), state)

    def restart(_root):
        calls.append(SUPERVISOR.load_state(str(tmp_path / "state.json")))
        return True, "exit_0"

    # act
    result = SUPERVISOR.run(args(tmp_path), probe=probe, restart=restart, now=lambda: 50.0)

    # assert
    assert result == 0
    assert len(calls) == 1
    assert calls[0]["restart_times"] == [50.0]
    assert calls[0]["last_action_result"] == "started"
    final = SUPERVISOR.load_state(str(tmp_path / "state.json"))
    assert final["last_action_result"] == "ok"


def test_given_corrupt_persisted_state_when_loaded_then_it_fails_closed_latched(tmp_path):
    # arrange
    state_path = tmp_path / "state.json"
    state_path.write_text("not-json")

    # act
    state = SUPERVISOR.load_state(str(state_path))

    # assert
    assert state["latched"] is True
    assert state["status"] == "structural_loop"
    assert state["last_reason"] == "state_invalid"


def test_given_state_is_saved_when_inspected_then_it_is_atomic_private_json(tmp_path):
    # arrange
    state_path = tmp_path / "state.json"
    state = SUPERVISOR.new_state()
    state["last_reason"] = "healthz_unreachable"

    # act
    SUPERVISOR.save_state(str(state_path), state)

    # assert
    assert json.loads(state_path.read_text())["last_reason"] == "healthz_unreachable"
    assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    assert not (tmp_path / "state.json.tmp").exists()


def test_given_restart_command_when_built_then_only_server_compose_service_is_targeted():
    # arrange / act
    command = SUPERVISOR.restart_command("/home/israel/HomeCameraSystem")

    # assert
    assert command == [
        "/usr/bin/docker", "compose", "-f",
        "/home/israel/HomeCameraSystem/deploy/docker-compose.yml",
        "up", "-d", "--no-build", "--force-recreate", "server",
    ]
    assert "mediamtx" not in " ".join(command)
    assert "nvargus" not in " ".join(command)
    assert "reboot" not in " ".join(command)


def test_given_host_python_surface_when_parsed_then_it_contains_no_post_python36_syntax():
    # arrange
    source = MODULE_PATH.read_text()

    # act / assert
    tree = ast.parse(source, str(MODULE_PATH), feature_version=(3, 6))
    assert "from __future__ import annotations" not in source
    assert not any(isinstance(node, ast.JoinedStr) for node in ast.walk(tree))


def test_given_deployment_files_when_inspected_then_one_bounded_supervisor_owns_recovery():
    # arrange
    compose = (ROOT / "deploy" / "docker-compose.yml").read_text()
    unit = (ROOT / "deploy" / "systemd" / "homecam-server-supervisor.service").read_text()
    installer = (ROOT / "deploy" / "install-jetson.sh").read_text()

    # act / assert
    assert 'restart: "no"' in compose
    assert "Requires=homecam-server.service" in unit
    assert "PartOf=homecam-server.service" in unit
    assert "RestartPreventExitStatus=78" in unit
    assert "ExecStart=/usr/bin/python3" in unit
    assert "homecam-server-supervisor.service" in installer
    assert installer.index("enable --now homecam-server.service") < installer.index(
        "enable --now homecam-server-supervisor.service"
    )


def test_given_server_drill_when_inspected_then_it_kills_server_and_pins_camera_pids():
    # arrange
    drill = (ROOT / "deploy" / "recovery-drill.sh").read_text()
    server_block = drill[drill.index("server() {"):drill.index("\n}\n\ndisk()")]

    # act / assert
    assert "docker kill homecam-server" in server_block
    assert 'server_id=$(docker inspect -f "{{.Id}}" homecam-server)' in server_block
    assert '"$new_id" != "$server_id"' in server_block
    assert "SECONDS + 120" in server_block
    assert "mediamtx_pid=" in server_block
    assert "detect_pid=" in server_block
    assert "rtsp://127.0.0.1:8554/cam" in server_block
    assert "systemctl restart mediamtx" not in server_block
    assert "systemctl restart homecam-detect" not in server_block
