from __future__ import annotations

import json
from typing import Any


def _as_dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def normalize_node_inspection(node_inspection: Any) -> dict[str, Any] | None:
    return _as_dict(node_inspection)


def _format_diagnostics(diagnostics: list[Any]) -> list[str]:
    lines: list[str] = []
    for item in diagnostics:
        if not isinstance(item, dict):
            continue
        level = str(item.get("level") or "info").strip()
        message = str(item.get("message") or "").strip()
        if not message:
            continue
        lines.append(f"- [{level}] {message}")
    return lines


def _format_neighbors(label: str, neighbors: list[Any]) -> list[str]:
    out = [f"{label} ({len(neighbors)}):"]
    for item in neighbors[:8]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "Node").strip() or "Node"
        node_type = str(item.get("nodeType") or "unknown").strip() or "unknown"
        edge_type = str(item.get("edgeType") or "").strip()
        if edge_type:
            out.append(f"- {title} ({node_type}) via {edge_type}")
        else:
            out.append(f"- {title} ({node_type})")
    return out


def format_node_inspection_for_prompt(node_inspection: dict[str, Any] | None) -> list[str]:
    inspection = normalize_node_inspection(node_inspection)
    if not inspection:
        return []

    found = bool(inspection.get("found"))
    title = str(inspection.get("title") or "Node")
    node_type = str(inspection.get("nodeType") or "unknown")
    node_id = str(inspection.get("nodeId") or "")
    details = _as_dict(inspection.get("details")) or {}
    upstream = _as_list(inspection.get("upstream"))
    downstream = _as_list(inspection.get("downstream"))
    diagnostics = _as_list(inspection.get("diagnostics"))

    parts = [
        "Focused node context:",
        f"- Found: {found}",
        f"- Title: {title}",
        f"- Type: {node_type}",
    ]
    if node_id:
        parts.append(f"- Node id: {node_id}")
    parts.extend(_format_neighbors("Upstream", upstream))
    parts.extend(_format_neighbors("Downstream", downstream))

    diagnostic_lines = _format_diagnostics(diagnostics)
    if diagnostic_lines:
        parts.append("Diagnostics:")
        parts.extend(diagnostic_lines)

    parts.append("Focused node details JSON:")
    parts.append(json.dumps(details, ensure_ascii=False, indent=2))
    return parts
