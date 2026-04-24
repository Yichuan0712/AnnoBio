from __future__ import annotations

from typing import Any

from agent.context.node_inspection import format_node_inspection_for_prompt
from agent.context.workflow_snapshot import format_workflow_snapshot_for_prompt


def build_agent_context_blocks(
    workflow_snapshot: dict[str, Any] | None = None,
    node_inspection: dict[str, Any] | None = None,
) -> list[str]:
    blocks = format_workflow_snapshot_for_prompt(workflow_snapshot)
    blocks.extend(format_node_inspection_for_prompt(node_inspection))
    return blocks
