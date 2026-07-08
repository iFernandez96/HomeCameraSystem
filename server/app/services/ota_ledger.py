"""Append-only OTA update ledger.

The OTA route is still scaffold-only. This module is the first pure slice of
the eventual updater: local JSONL records with injectable time and terminal
status enforcement.
"""
from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

log = logging.getLogger(__name__)

LedgerStatus = Literal["requested", "rejected", "started", "applied", "rolled_back"]

VALID_STATUSES: frozenset[str] = frozenset(
    {"requested", "rejected", "started", "applied", "rolled_back"}
)
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"rejected", "applied", "rolled_back"}
)


class OtaLedgerError(RuntimeError):
    """Base class for OTA ledger failures."""


class InvalidLedgerStatusError(OtaLedgerError):
    """Raised when a caller attempts to record an unknown status."""


class TerminalStatusAlreadyRecordedError(OtaLedgerError):
    """Raised when an attempt already has its single terminal status."""


@dataclass(frozen=True)
class LedgerEvent:
    attempt_id: str
    status: LedgerStatus
    created_at: str
    reason: str | None = None
    metadata: dict[str, Any] | None = None

    def to_record(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "attempt_id": self.attempt_id,
            "status": self.status,
            "created_at": self.created_at,
        }
        if self.reason is not None:
            record["reason"] = self.reason
        if self.metadata:
            record["metadata"] = self.metadata
        return record


def _default_clock() -> datetime:
    return datetime.now(UTC)


def _format_clock_value(value: datetime | str) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    if isinstance(value, str) and value:
        return value
    raise OtaLedgerError("ledger clock must return datetime or non-empty string")


def read_events(path: Path) -> list[dict[str, Any]]:
    """Read valid JSONL ledger rows from ``path``.

    Missing files are an empty ledger. Malformed existing rows are hard
    failures because continuing would make terminal-state decisions unsafe.
    """
    if not path.exists():
        return []

    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line_number, line in enumerate(fh, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise OtaLedgerError(
                    f"malformed ledger JSONL at line {line_number}"
                ) from exc
            if not isinstance(record, dict):
                raise OtaLedgerError(f"malformed ledger row at line {line_number}")
            events.append(record)
    return events


def terminal_status_for(path: Path, attempt_id: str) -> str | None:
    for event in read_events(path):
        if (
            event.get("attempt_id") == attempt_id
            and event.get("status") in TERMINAL_STATUSES
        ):
            return str(event["status"])
    return None


def append_event(
    path: Path,
    *,
    attempt_id: str,
    status: LedgerStatus,
    reason: str | None = None,
    metadata: Mapping[str, Any] | None = None,
    clock: Callable[[], datetime | str] = _default_clock,
) -> LedgerEvent:
    """Append one OTA ledger event and return the normalized event.

    The write is a single ``O_APPEND`` JSONL write followed by ``fsync``. Before
    appending a terminal status, existing rows are scanned so each attempt id can
    have exactly one terminal outcome.
    """
    if not attempt_id:
        raise OtaLedgerError("attempt_id is required")
    if status not in VALID_STATUSES:
        raise InvalidLedgerStatusError(f"invalid OTA ledger status: {status}")

    path.parent.mkdir(parents=True, exist_ok=True)
    if status in TERMINAL_STATUSES:
        existing = terminal_status_for(path, attempt_id)
        if existing is not None:
            raise TerminalStatusAlreadyRecordedError(
                f"attempt {attempt_id} already ended with {existing}"
            )

    event = LedgerEvent(
        attempt_id=attempt_id,
        status=status,
        created_at=_format_clock_value(clock()),
        reason=reason,
        metadata=dict(metadata) if metadata else None,
    )
    encoded = (
        json.dumps(event.to_record(), sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")

    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        written = os.write(fd, encoded)
        if written != len(encoded):
            raise OtaLedgerError("short write while appending OTA ledger")
        os.fsync(fd)
    finally:
        os.close(fd)

    log.info(
        "ota ledger event attempt_id=%s status=%s path=%s",
        attempt_id,
        status,
        path,
    )
    return event
