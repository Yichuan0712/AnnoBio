from __future__ import annotations

from typing import Any

from agent.context.build_agent_context import build_agent_context_blocks
from agent.prompt.agent_system_prompt import build_agent_system_prompt_parts


def format_agent_messages_for_log(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for idx, message in enumerate(messages or [], start=1):
        role = str(message.get("role") or "user").upper()
        content = str(message.get("content") or "")
        parts.append(f"[{idx}] {role}\n{content}")
    return "\n\n" + ("\n" + ("-" * 80) + "\n\n").join(parts) if parts else "(no messages)"


def build_agent_messages(
    messages: list[dict[str, Any]],
    workflow_snapshot: dict[str, Any] | None = None,
    observations: list[dict[str, Any]] | None = None,
    node_inspection: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    normalized_messages = [
        {
            "role": str(message.get("role") or "user"),
            "content": str(message.get("content") or ""),
        }
        for message in messages or []
    ]

    system_parts = build_agent_system_prompt_parts()
    system_parts.extend(
        build_agent_context_blocks(
            workflow_snapshot=workflow_snapshot,
            observations=observations,
            node_inspection=node_inspection,
        )
    )

    return [{"role": "system", "content": "\n".join(system_parts)}] + normalized_messages
