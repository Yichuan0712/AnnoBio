from __future__ import annotations

import json
from typing import Any


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def format_agent_observations_for_prompt(observations: list[dict[str, Any]] | None) -> list[str]:
    items = _as_list(observations)
    if not items:
        return []

    parts = ["Agent observation history:"]
    for index, observation in enumerate(items, start=1):
        if not isinstance(observation, dict):
            continue
        skill_name = str(observation.get("skill_name") or "unknown")
        args = _as_dict(observation.get("args")) or {}
        ok = bool(observation.get("ok"))
        summary = str(observation.get("summary") or "").strip()
        result = observation.get("result")
        parts.append(f"Observation {index}:")
        parts.append(f"- Skill: {skill_name}")
        parts.append(f"- Ok: {ok}")
        if summary:
            parts.append(f"- Summary: {summary}")
        parts.append("- Args JSON:")
        parts.append(json.dumps(args, ensure_ascii=False, indent=2))
        parts.append("- Result JSON:")
        parts.append(json.dumps(result, ensure_ascii=False, indent=2))
    return parts
