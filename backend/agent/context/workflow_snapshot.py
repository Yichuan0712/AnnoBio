from __future__ import annotations

import json
from typing import Any


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def normalize_workflow_snapshot(workflow_snapshot: Any) -> dict[str, Any] | None:
    return _as_dict(workflow_snapshot)


def _format_snapshot_summary_lines(snapshot: dict[str, Any]) -> list[str]:
    summary = _as_dict(snapshot.get("summary")) or {}
    counts = _as_dict(summary.get("countsByType")) or {}
    runnable_run_ids = _as_list(summary.get("runnableRunNodeIds"))
    reviewable_score_ids = _as_list(summary.get("reviewableScoreNodeIds"))
    chains = _as_list(summary.get("chains"))
    total_nodes = summary.get("totalNodes")
    total_connections = summary.get("totalConnections")
    return [
        f"Total nodes: {total_nodes if total_nodes is not None else 'unknown'}",
        f"Total connections: {total_connections if total_connections is not None else 'unknown'}",
        f"Counts by type: {json.dumps(counts, ensure_ascii=False)}",
        f"Runnable runs: {len(runnable_run_ids)}",
        f"Reviewable scores: {len(reviewable_score_ids)}",
        f"Workflow chains: {len(chains)}",
    ]


def format_workflow_snapshot_for_prompt(workflow_snapshot: dict[str, Any] | None) -> list[str]:
    snapshot = normalize_workflow_snapshot(workflow_snapshot)
    if not snapshot:
        return ["No workflow snapshot was provided for this request."]
    return [
        "Current workflow summary:",
        *_format_snapshot_summary_lines(snapshot),
        "Workflow snapshot JSON:",
        json.dumps(snapshot, ensure_ascii=False, indent=2),
    ]
