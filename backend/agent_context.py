# Legacy entrypoint; real implementation lives under agent.context.
from agent.context.build_agent_context import build_agent_context_blocks
from agent.context.node_inspection import (
    format_node_inspection_for_prompt,
    normalize_node_inspection,
)
from agent.context.workflow_snapshot import (
    format_workflow_snapshot_for_prompt,
    normalize_workflow_snapshot,
)
