"""Real OTA bundle layout detection for staged candidates."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DeployLayout:
    root: Path
    staged_client_dist: Path
    staged_detection_entry: Path
    client_dist_target: Path


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


def detect_scratch_deploy_layout(
    root: Path, *, client_dist_target: Path
) -> DeployLayoutResult:
    """Identify the staged bundle pieces the container can really apply."""
    missing: list[str] = []

    staged_client_dist = root / "client" / "dist"
    if not (staged_client_dist / "index.html").is_file():
        missing.append("client/dist/index.html")

    staged_detection_entry = root / "detection" / "detect.py"
    if not staged_detection_entry.is_file():
        missing.append("detection/detect.py")

    if not client_dist_target.is_dir():
        missing.append("client_dist_target")
    elif not os.access(client_dist_target, os.W_OK):
        missing.append("client_dist_target_writable")

    if missing:
        log.warning(
            "rejecting OTA staged bundle layout root=%s reason=%s missing=%s",
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

    return DeployLayoutResult(
        status="detected",
        root=root,
        layout=DeployLayout(
            root=root,
            staged_client_dist=staged_client_dist,
            staged_detection_entry=staged_detection_entry,
            client_dist_target=client_dist_target,
        ),
    )
