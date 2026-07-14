"""Persist the operator's desired automatic-exposure metering settings."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import logging
import os
from pathlib import Path
from typing import List
from uuid import uuid4

from ..config import settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CameraExposureConfig:
    enabled: bool = False
    x: float = 0.25
    y: float = 0.25
    width: float = 0.5
    height: float = 0.5
    compensation: float = 0.0
    locked: bool = False


@dataclass(frozen=True)
class CameraExposurePreset:
    id: str
    name: str
    thumbnail: str
    config: CameraExposureConfig
    created_at: float


class CameraExposureStore:
    def _presets_path(self) -> Path:
        path = settings.camera_exposure_path
        return path.with_name(path.stem + "_presets.json")

    def get(self) -> CameraExposureConfig:
        try:
            with settings.camera_exposure_path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            return CameraExposureConfig(**raw)
        except FileNotFoundError:
            return CameraExposureConfig()
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            log.warning(
                "camera exposure config load failed at %s; using defaults",
                settings.camera_exposure_path,
                exc_info=True,
            )
            return CameraExposureConfig()

    def save(self, config: CameraExposureConfig) -> None:
        path: Path = settings.camera_exposure_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(asdict(config), handle, separators=(",", ":"))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        os.chmod(path, 0o600)

    def list_presets(self) -> List[CameraExposurePreset]:
        path = self._presets_path()
        try:
            with path.open("r", encoding="utf-8") as handle:
                raw = json.load(handle)
            return [
                CameraExposurePreset(
                    id=item["id"],
                    name=item["name"],
                    thumbnail=item["thumbnail"],
                    config=CameraExposureConfig(**item["config"]),
                    created_at=float(item["created_at"]),
                )
                for item in raw
            ]
        except FileNotFoundError:
            return []
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            log.warning("camera exposure presets load failed at %s", path, exc_info=True)
            return []

    def save_preset(
        self, name: str, thumbnail: str, config: CameraExposureConfig, created_at: float
    ) -> CameraExposurePreset:
        presets = self.list_presets()
        preset = CameraExposurePreset(
            id=uuid4().hex,
            name=name,
            thumbnail=thumbnail,
            config=config,
            created_at=created_at,
        )
        presets.insert(0, preset)
        self._write_presets(presets[:24])
        return preset

    def delete_preset(self, preset_id: str) -> bool:
        presets = self.list_presets()
        remaining = [preset for preset in presets if preset.id != preset_id]
        if len(remaining) == len(presets):
            return False
        self._write_presets(remaining)
        return True

    def _write_presets(self, presets: List[CameraExposurePreset]) -> None:
        path = self._presets_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        payload = [
            {
                **asdict(preset),
                "config": asdict(preset.config),
            }
            for preset in presets
        ]
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, separators=(",", ":"))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        os.chmod(path, 0o600)


camera_exposure = CameraExposureStore()
