#!/usr/bin/env python3
"""Bounded host-side liveness supervision for the FastAPI container.

This runs on the Jetson host under systemd and deliberately owns only the
``server`` Compose service.  Camera recovery remains exclusively owned by the
detection worker's persisted MediaMTX/Argus ladder.

Keep this file compatible with JetPack's host Python 3.6.
"""
import argparse
import json
import logging
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


LOG = logging.getLogger("server_supervisor")
STATE_VERSION = 1
STRUCTURAL_LOOP_EXIT = 78
DEFAULT_STATE_PATH = (
    "/srv/homecam-media/recordings/.server-supervisor-state.json"
)
DEFAULT_HEALTH_URL = "http://127.0.0.1:8000/healthz"
DEFAULT_INTERVAL_S = 10.0
DEFAULT_FAILURE_THRESHOLD = 3
DEFAULT_MAX_RESTARTS = 3
DEFAULT_WINDOW_S = 600.0


def new_state():
    return {
        "v": STATE_VERSION,
        "status": "starting",
        "consecutive_failures": 0,
        "restart_times": [],
        "last_reason": "none",
        "last_action": "none",
        "last_action_at": 0.0,
        "last_action_result": "none",
        "latched": False,
    }


def _valid_number(value):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _validate_state(payload):
    if not isinstance(payload, dict) or payload.get("v") != STATE_VERSION:
        raise ValueError("unsupported state")
    state = new_state()
    state.update(payload)
    if not isinstance(state["status"], str):
        raise ValueError("invalid status")
    if (
        not isinstance(state["consecutive_failures"], int)
        or isinstance(state["consecutive_failures"], bool)
    ):
        raise ValueError("invalid failure count")
    if state["consecutive_failures"] < 0:
        raise ValueError("negative failure count")
    if not isinstance(state["restart_times"], list):
        raise ValueError("invalid restart history")
    if not all(_valid_number(value) for value in state["restart_times"]):
        raise ValueError("invalid restart time")
    if not _valid_number(state["last_action_at"]):
        raise ValueError("invalid action time")
    if not isinstance(state["latched"], bool):
        raise ValueError("invalid latch")
    for key in ("last_reason", "last_action", "last_action_result"):
        if not isinstance(state[key], str):
            raise ValueError("invalid {}".format(key))
        state[key] = state[key][:96]
    return state


def load_state(path):
    if not os.path.exists(path):
        return new_state()
    try:
        with open(path, "r") as handle:
            return _validate_state(json.load(handle))
    except Exception:
        # Losing the restart budget would permit an unbounded structural loop.
        # Fail closed and require the operator to inspect/reset the latch.
        state = new_state()
        state.update({
            "status": "structural_loop",
            "last_reason": "state_invalid",
            "last_action": "stop",
            "last_action_result": "latched",
            "latched": True,
        })
        return state


def save_state(path, state):
    parent = os.path.dirname(path) or "."
    if not os.path.isdir(parent):
        raise OSError("state parent is unavailable")
    temp_path = path + ".tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(temp_path, flags, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            fd = -1
            json.dump(state, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        os.chmod(path, 0o600)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def evaluate_probe(state, healthy, reason, now, failure_threshold,
                   max_restarts, window_s):
    """Update state and return ``none``, ``restart_server``, or ``stop``."""
    cutoff = float(now) - float(window_s)
    state["restart_times"] = [
        float(value) for value in state["restart_times"]
        if float(value) >= cutoff
    ]
    if state["latched"]:
        return "stop"
    if healthy:
        state["status"] = "healthy"
        state["consecutive_failures"] = 0
        state["last_reason"] = "none"
        return "none"

    state["status"] = "degraded"
    state["last_reason"] = str(reason)[:96]
    state["consecutive_failures"] += 1
    if state["consecutive_failures"] < int(failure_threshold):
        return "none"
    if len(state["restart_times"]) >= int(max_restarts):
        state["status"] = "structural_loop"
        state["last_action"] = "stop"
        state["last_action_at"] = float(now)
        state["last_action_result"] = "latched"
        state["latched"] = True
        return "stop"

    state["status"] = "recovering"
    state["consecutive_failures"] = 0
    state["restart_times"].append(float(now))
    state["last_action"] = "restart_server"
    state["last_action_at"] = float(now)
    state["last_action_result"] = "started"
    return "restart_server"


def probe_health(url, timeout_s=2.0):
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=float(timeout_s)) as response:
            if int(response.status) != 200:
                return False, "healthz_http_{}".format(int(response.status))
            payload = json.loads(response.read(4096).decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return False, "healthz_invalid_response"
        return True, "none"
    except urllib.error.HTTPError as exc:
        return False, "healthz_http_{}".format(int(exc.code))
    except urllib.error.URLError:
        return False, "healthz_unreachable"
    except ValueError:
        return False, "healthz_invalid_response"
    except Exception as exc:
        return False, "healthz_{}".format(type(exc).__name__.lower())[:96]


def restart_command(repo_root):
    return [
        "/usr/bin/docker", "compose",
        "-f", os.path.join(repo_root, "deploy", "docker-compose.yml"),
        "up", "-d", "--no-build", "--force-recreate", "server",
    ]


def restart_server(repo_root, timeout_s=45.0):
    try:
        completed = subprocess.run(
            restart_command(repo_root),
            cwd=repo_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=float(timeout_s),
            check=False,
        )
        return completed.returncode == 0, "exit_{}".format(completed.returncode)
    except subprocess.TimeoutExpired:
        return False, "restart_timeout"
    except Exception as exc:
        return False, "restart_{}".format(type(exc).__name__.lower())[:96]


def reset_latch(path):
    state = new_state()
    state["status"] = "reset"
    state["last_reason"] = "operator_reset"
    save_state(path, state)


def run(args, probe=probe_health, restart=restart_server, sleeper=time.sleep,
        now=time.time):
    state = load_state(args.state_path)
    if state["latched"]:
        LOG.error(
            "alert=structural_loop action=stop reason=%s restarts=%d",
            state["last_reason"], len(state["restart_times"]),
        )
        return STRUCTURAL_LOOP_EXIT

    LOG.info(
        "status=started action=monitor_server interval_s=%.1f threshold=%d "
        "max_restarts=%d window_s=%.1f",
        args.interval_s, args.failure_threshold, args.max_restarts,
        args.window_s,
    )
    while True:
        healthy, reason = probe(args.health_url)
        previous_status = state["status"]
        before = json.dumps(state, sort_keys=True, separators=(",", ":"))
        action = evaluate_probe(
            state, healthy, reason, now(), args.failure_threshold,
            args.max_restarts, args.window_s,
        )
        after = json.dumps(state, sort_keys=True, separators=(",", ":"))
        if after != before:
            save_state(args.state_path, state)
        if healthy and previous_status != "healthy":
            LOG.info("status=healthy action=none reason=healthz_ok")
        elif not healthy:
            LOG.warning(
                "status=%s action=%s reason=%s consecutive_failures=%d "
                "restarts_in_window=%d",
                state["status"], action, state["last_reason"],
                state["consecutive_failures"], len(state["restart_times"]),
            )

        if action == "stop":
            LOG.error(
                "alert=structural_loop action=stop reason=%s restarts=%d",
                state["last_reason"], len(state["restart_times"]),
            )
            return STRUCTURAL_LOOP_EXIT
        if action == "restart_server":
            # The action budget is persisted before the side effect. A process
            # death here therefore cannot reset or exceed the circuit breaker.
            LOG.warning(
                "status=recovering action=restart_server reason=%s attempt=%d",
                state["last_reason"], len(state["restart_times"]),
            )
            ok, result = restart(args.repo_root)
            state["last_action_result"] = "ok" if ok else result
            save_state(args.state_path, state)
            if not ok:
                LOG.error(
                    "status=recovering action=restart_server reason=%s result=%s",
                    state["last_reason"], result,
                )
        if args.once:
            return 0
        sleeper(float(args.interval_s))


def parse_args(argv=None):
    repo_default = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-path", default=DEFAULT_STATE_PATH)
    parser.add_argument("--health-url", default=DEFAULT_HEALTH_URL)
    parser.add_argument("--repo-root", default=repo_default)
    parser.add_argument("--interval-s", type=float, default=DEFAULT_INTERVAL_S)
    parser.add_argument(
        "--failure-threshold", type=int, default=DEFAULT_FAILURE_THRESHOLD,
    )
    parser.add_argument("--max-restarts", type=int, default=DEFAULT_MAX_RESTARTS)
    parser.add_argument("--window-s", type=float, default=DEFAULT_WINDOW_S)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--reset-latch", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [server_supervisor] %(message)s",
    )
    args = parse_args(argv)
    if args.reset_latch:
        reset_latch(args.state_path)
        LOG.info("status=reset action=clear_latch reason=operator_request")
        return 0
    if args.failure_threshold < 1 or args.max_restarts < 1:
        LOG.error("configuration_invalid")
        return 2
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
