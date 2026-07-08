"""Scratch deploy layout detection for OTA candidates."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

_COMPOSE_CANDIDATES = ("docker-compose.yml", "compose.yml", "compose.yaml")


@dataclass(frozen=True)
class DeployLayout:
    root: Path
    compose_path: Path
    env_path: Path
    data_path: Path


@dataclass(frozen=True)
class DeployLayoutResult:
    status: str
    root: Path
    layout: DeployLayout | None = None
    missing: tuple[str, ...] = ()
    reason: str | None = None

    @property
    def can_apply(self) -> bool:
        return self.status == "detected" and self.layout is not None


def detect_scratch_deploy_layout(root: Path) -> DeployLayoutResult:
    """Identify required compose, env, and data paths in a temp clone."""
    missing: list[str] = []

    compose_path = next(
        (root / candidate for candidate in _COMPOSE_CANDIDATES if (root / candidate).is_file()),
        None,
    )
    if compose_path is None:
        missing.append("compose")

    env_path = root / ".env"
    if not env_path.is_file():
        missing.append("env")

    data_path = root / "data"
    if not data_path.is_dir():
        missing.append("data")

    if missing:
        log.warning(
            "rejecting OTA scratch deploy layout root=%s reason=%s missing=%s",
            root,
            "incomplete_layout",
            ",".join(missing),
        )
        return DeployLayoutResult(
            status="rejected",
            root=root,
            missing=tuple(missing),
            reason="incomplete_layout",
        )

    assert compose_path is not None
    return DeployLayoutResult(
        status="detected",
        root=root,
        layout=DeployLayout(
            root=root,
            compose_path=compose_path,
            env_path=env_path,
            data_path=data_path,
        ),
    )
