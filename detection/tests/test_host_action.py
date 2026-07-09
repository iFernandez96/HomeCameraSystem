import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import host_action  # noqa: E402


def _record(**overrides):
    rec = {
        "id": "req-1",
        "kind": "mediamtx",
        "args": {},
        "requested_at": 100.0,
    }
    rec.update(overrides)
    return rec


def test_given_fresh_record_when_planned_then_execute():
    # arrange
    rec = _record()

    # act
    plan = host_action.plan_action(rec, 110.0, set(), max_age_s=90.0)

    # assert
    assert plan == host_action.PLAN_EXECUTE


@pytest.mark.parametrize(
    "record,now,seen,expected",
    [
        (_record(id="seen"), 110.0, {"seen"}, host_action.PLAN_SKIP_SEEN),
        (_record(requested_at=-100.0), 110.0, set(), host_action.PLAN_SKIP_STALE),
        (_record(requested_at=120.0), 110.0, set(), host_action.PLAN_SKIP_STALE),
        (_record(kind="halt"), 110.0, set(), host_action.PLAN_SKIP_UNKNOWN),
        (None, 110.0, set(), host_action.PLAN_SKIP_UNKNOWN),
        (_record(requested_at="bad"), 110.0, set(), host_action.PLAN_SKIP_UNKNOWN),
    ],
)
def test_given_non_executable_record_when_planned_then_skip_reason(
    record, now, seen, expected
):
    # arrange / act
    plan = host_action.plan_action(record, now, seen, max_age_s=90.0)

    # assert
    assert plan == expected


def _deps(**overrides):
    calls = []

    def restart_mediamtx():
        calls.append("mediamtx")
        return True

    def restart_nvargus():
        calls.append("nvargus")
        return True

    def do_reboot():
        calls.append("reboot")
        return True

    def tail_journal(unit, since, lines):
        calls.append(("logs", unit, since, lines))
        return ["line"]

    deps = SimpleNamespace(
        restart_mediamtx=restart_mediamtx,
        restart_nvargus=restart_nvargus,
        do_reboot=do_reboot,
        tail_journal=tail_journal,
        allow_reboot=True,
        calls=calls,
    )
    for key, value in overrides.items():
        setattr(deps, key, value)
    return deps


def test_given_mediamtx_action_when_executed_then_restart_callable_used():
    # arrange
    deps = _deps()

    # act
    status, detail, result = host_action.execute_action(_record(kind="mediamtx"), deps)

    # assert
    assert (status, detail, result) == ("done", "mediamtx restart requested", None)
    assert deps.calls == ["mediamtx"]


def test_given_nvargus_action_when_executed_then_nvargus_callable_used():
    # arrange
    deps = _deps()

    # act
    status, detail, result = host_action.execute_action(_record(kind="nvargus"), deps)

    # assert
    assert (status, detail, result) == ("done", "nvargus restart requested", None)
    assert deps.calls == ["nvargus"]


def test_given_failed_mediamtx_restart_when_executed_then_failed_status():
    # arrange
    deps = _deps(restart_mediamtx=lambda: False)

    # act
    status, detail, result = host_action.execute_action(_record(kind="mediamtx"), deps)

    # assert
    assert (status, detail, result) == ("failed", "mediamtx restart failed", None)


def test_given_reboot_disabled_when_executed_then_no_reboot_call():
    # arrange
    deps = _deps(allow_reboot=False)

    # act
    status, detail, result = host_action.execute_action(_record(kind="reboot"), deps)

    # assert
    assert status == "failed"
    assert detail == "reboot disabled by DETECT_WATCHDOG_ALLOW_REBOOT=0"
    assert result is None
    assert deps.calls == []


def test_given_logs_action_when_executed_then_tail_result_returned():
    # arrange
    deps = _deps()
    rec = _record(kind="logs", args={"unit": "mediamtx", "since": "1 hour", "lines": 5})

    # act
    status, detail, result = host_action.execute_action(rec, deps)

    # assert
    assert (status, detail) == ("done", "logs fetched")
    assert result == {"lines": ["line"]}
    assert deps.calls == [("logs", "mediamtx", "1 hour", 5)]


def test_given_seen_reboot_id_when_planned_twice_then_reboot_at_most_once():
    # arrange
    deps = _deps()
    rec = _record(id="reboot-1", kind="reboot")
    seen = set()

    # act
    if host_action.plan_action(rec, 101.0, seen) == host_action.PLAN_EXECUTE:
        seen.add(rec["id"])
        host_action.execute_action(rec, deps)
    second = host_action.plan_action(rec, 102.0, seen)

    # assert
    assert second == host_action.PLAN_SKIP_SEEN
    assert deps.calls == ["reboot"]


@pytest.mark.parametrize(
    "unit",
    ["homecam-detect", "mediamtx", "nvargus-daemon", "homecam-server"],
)
def test_given_allowed_journal_unit_when_validated_then_true(unit):
    # arrange / act / assert
    assert host_action.is_valid_journal_unit(unit) is True


def test_given_bad_journal_unit_when_validated_then_false():
    # arrange / act / assert
    assert host_action.is_valid_journal_unit("mediamtx; reboot") is False


@pytest.mark.parametrize(
    "raw",
    [
        "30 minutes ago",
        "2 hours",
        "-1 day ago",
        "2026-07-08",
        "2026-07-08 12:34",
        "2026-07-08 12:34:56",
    ],
)
def test_given_whitelisted_since_when_sanitized_then_preserved(raw):
    # arrange / act / assert
    assert host_action._sanitize_since(raw) == raw


@pytest.mark.parametrize("raw", ["; rm -rf /", "`date`", "--since=@0", "today && reboot"])
def test_given_unsafe_since_when_sanitized_then_rejected(raw):
    # arrange / act / assert
    assert host_action._sanitize_since(raw) is None


@pytest.mark.parametrize(
    "line,expected",
    [
        ("authorization: Bearer abc123", "authorization: ***"),
        ("password=super-secret failed", "password=*** failed"),
        ("api_key: keyvalue", "api_key: ***"),
        ("x-api-key=abc", "x-api-key=***"),
        ("jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "jwt: ***"),
    ],
)
def test_given_secret_value_shape_when_scrubbed_then_value_redacted(line, expected):
    # arrange / act
    scrubbed = host_action.scrub_lines([line], max_lines=10)

    # assert
    assert scrubbed == [expected]


def test_given_secret_keyword_without_value_shape_when_scrubbed_then_line_dropped():
    # arrange / act
    scrubbed = host_action.scrub_lines(["request included bearer credentials"], 10)

    # assert
    assert scrubbed == []


def test_given_opaque_blobs_when_scrubbed_then_blobs_redacted():
    # arrange
    lines = [
        "normal id 0123456789abcdef0123456789abcdef done",
        "payload QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    ]

    # act
    scrubbed = host_action.scrub_lines(lines, 10)

    # assert
    assert scrubbed == ["normal id *** done", "payload ***"]


def test_given_many_long_lines_when_scrubbed_then_count_and_length_are_capped():
    # arrange
    lines = ["normal " * 400, "second", "third"]

    # act
    scrubbed = host_action.scrub_lines(lines, max_lines=2)

    # assert
    assert len(scrubbed) == 2
    assert len(scrubbed[0]) == 2000
    assert scrubbed[1] == "second"


def test_given_snapshot_logs_missing_when_real_fixture_required_then_explicit_skip():
    # arrange
    root = Path(__file__).resolve().parents[2]
    logs_dir = root / ".jetson-snapshot" / "logs"
    fixture_files = list(logs_dir.glob("*")) if logs_dir.exists() else []

    # act / assert
    if not fixture_files:
        pytest.skip(".jetson-snapshot/logs has no real journald fixtures")


def test_given_journal_tail_when_called_then_runner_argv_is_bounded_and_scrubbed():
    # arrange
    calls = []

    class Result:
        stdout = (
            b"2026-07-08 normal mediamtx ready\n"
            b"2026-07-08 password=abc123 rejected\n"
        )

    def runner(cmd, timeout, stdout, stderr):
        calls.append((cmd, timeout, stdout, stderr))
        return Result()

    # act
    lines = host_action.tail_journal(
        "mediamtx", "30 minutes ago", 50, runner=runner
    )

    # assert
    assert lines == [
        "2026-07-08 normal mediamtx ready",
        "2026-07-08 password=*** rejected",
    ]
    assert calls == [
        (
            [
                "sudo",
                "-n",
                "journalctl",
                "-u",
                "mediamtx",
                "-n",
                "50",
                "--no-pager",
                "-o",
                "short-iso",
                "--since",
                "30 minutes ago",
            ],
            10.0,
            subprocess.PIPE,
            subprocess.PIPE,
        )
    ]


def test_given_bad_unit_when_tail_journal_then_runner_not_called():
    # arrange
    calls = []

    def runner(cmd, timeout, stdout, stderr):
        calls.append(cmd)
        raise AssertionError("runner should not be called")

    # act
    lines = host_action.tail_journal("bad;unit", None, 10, runner=runner)

    # assert
    assert lines == []
    assert calls == []
