"""
Minimal Python port of app/src/scoreMappingBundle.js — parses the persisted Score rule-tree bundle just
enough to evaluate it (score_run_gt_pairing.py), not to edit it (no groupId bookkeeping, no legacy-array
normalization beyond falling back to empty rules). The current bundle shape (`{v, input, output}`, each a
`{type: 'group', ops, children}` tree of `{type: 'rule', outputKey, gtColumns, matchType, matchFlags}`
leaves) is already exactly the dict shape score_run_gt_pairing.py's functions expect — no transformation
needed once parsed.
"""

from __future__ import annotations

import json
from typing import Any

SCORE_MAPPING_BUNDLE_V = 2


def empty_score_rule_group() -> dict:
    return {"type": "group", "ops": [], "children": []}


def parse_score_mapping_bundle(raw: Any) -> tuple[dict, dict]:
    """Returns (input_root, output_root). Falls back to empty groups on any parse/shape failure."""
    data: Any
    if isinstance(raw, str):
        try:
            data = json.loads(raw or "{}")
        except (json.JSONDecodeError, TypeError):
            data = {}
    elif isinstance(raw, dict):
        data = raw
    else:
        data = {}

    if (
        isinstance(data, dict)
        and data.get("v") == SCORE_MAPPING_BUNDLE_V
        and isinstance(data.get("input"), dict)
        and isinstance(data.get("output"), dict)
        and data["input"].get("type") == "group"
        and data["output"].get("type") == "group"
    ):
        return data["input"], data["output"]
    return empty_score_rule_group(), empty_score_rule_group()
