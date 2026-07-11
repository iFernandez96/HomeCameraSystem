"""Deterministic, local alert importance policy.

This module intentionally has no I/O. The worker remains responsible for
detection; the server decides how loudly a household should be interrupted.
Keeping policy here makes every decision explainable and offline-testable.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AlertDecision:
    importance: str
    reason: str
    require_interaction: bool
    silent: bool


def decide_alert(event: dict, operating_mode: str) -> AlertDecision:
    label = str(event.get("label") or "").lower()
    known = bool(event.get("person_name") or event.get("person_names"))
    score = float(event.get("score") or 0.0)

    if operating_mode == "privacy":
        return AlertDecision("suppressed", "privacy_mode", False, True)
    if label in {"audio_smoke_alarm", "audio_glass_break", "audio_scream"}:
        return AlertDecision("urgent", "audio_emergency", True, False)
    if event.get("package_state") == "possible_theft":
        return AlertDecision("urgent", "possible_package_theft", True, False)
    if label in {"camera_covered", "camera_moved", "camera_offline"}:
        return AlertDecision("urgent", "camera_tamper", True, False)
    if label == "doorbell":
        return AlertDecision("urgent", "doorbell_pressed", True, False)
    if label == "package_delivered" or event.get("package_state") == "delivered":
        return AlertDecision("notable", "package_delivered", False, False)
    if label == "audio_dog_bark":
        return AlertDecision("routine", "audio_dog_bark", False, True)
    if label == "person" and not known and operating_mode in {"away", "night"}:
        return AlertDecision("urgent", "unknown_person_sensitive_mode", True, False)
    if label == "person" and not known:
        return AlertDecision("notable", "unknown_person", False, False)
    if label == "person" and known and operating_mode == "home":
        return AlertDecision("routine", "known_person_home", False, True)
    if label in {"cat", "dog", "bird"}:
        return AlertDecision("routine", "animal", False, True)
    if score >= 0.85:
        return AlertDecision("notable", "high_confidence", False, False)
    return AlertDecision("routine", "default", False, False)
