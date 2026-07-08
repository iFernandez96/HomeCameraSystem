"""OTA restart handoff seam."""
from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

log = logging.getLogger(__name__)

CommandRunner = Callable[[tuple[str, ...]], object]


@dataclass
class RecordingCommandRunner:
    """Default runner that records argv and performs no host action."""

    commands: list[tuple[str, ...]]

    def __init__(self) -> None:
        self.commands = []

    def __call__(self, argv: tuple[str, ...]) -> dict[str, object]:
        self.commands.append(argv)
        return {"recorded": True, "returncode": 0}


@dataclass(frozen=True)
class RestartHandoffResult:
    status: str
    argv: tuple[str, ...] | None = None
    runner_result: object | None = None
    reason: str | None = None

    @property
    def handed_off(self) -> bool:
        return self.status == "recorded"


def _validated_argv(command: Sequence[str]) -> tuple[str, ...] | None:
    if isinstance(command, str):
        return None
    argv = tuple(command)
    if not argv:
        return None
    if any(not isinstance(part, str) or not part.strip() for part in argv):
        return None
    return argv


def record_restart_handoff(
    command: Sequence[str], *, runner: CommandRunner | None = None
) -> RestartHandoffResult:
    """Pass an already-tokenized argv list to an injected restart runner."""
    argv = _validated_argv(command)
    if argv is None:
        log.warning("rejecting OTA restart handoff reason=%s", "invalid_argv")
        return RestartHandoffResult(status="rejected", reason="invalid_argv")

    actual_runner = runner or RecordingCommandRunner()
    runner_result = actual_runner(argv)
    log.info("ota restart handoff recorded argv=%s", argv)
    return RestartHandoffResult(
        status="recorded", argv=argv, runner_result=runner_result
    )
