"""
Python port of app/src/scoreRunGtPairing.js — greedy run<->GT pairing and the real AND/OR rule-tree fold.

Faithful port, not a rewrite: see score_match_primitives.py's module docstring for the parity contract.
Two rule trees (v2 bundle), matching the JS source:
  1. input_root  — input / row-index vs GT: all input leaves must match for (i, j) to be a candidate.
  2. output_root — model output vs GT: matching leaves define score and tie-break vector.
If the output tree has no leaves but the input tree does, a candidate's score is 1.
If both are empty, no pairs match.

`evaluate_score_tree` is the real boolean AND/OR fold of a rule tree for one (run, GT) pair — unlike a
candidate's `score` in the pairing below (any leaf matching is enough to be a *candidate*), this requires
the tree's actual structure to hold, and is what decides the final matched/unmatched verdict for an
already-paired (run, GT) pair.
"""

from __future__ import annotations

from typing import Any, Callable

RuleMatchesRow = Callable[[dict, int, int, dict, Any, Any, Any], bool]


def flatten_score_rules(node: dict | None) -> list[dict]:
    """Depth-first list of leaf rule nodes under a score tree root."""
    if not node:
        return []
    if node.get("type") == "rule":
        return [node]
    if node.get("type") == "group" and isinstance(node.get("children"), list):
        out: list[dict] = []
        for child in node["children"]:
            out.extend(flatten_score_rules(child))
        return out
    return []


def _empty_group() -> dict:
    return {"type": "group", "ops": [], "children": []}


def _normalize_tree_root(r: dict | None) -> dict:
    if not r:
        return _empty_group()
    if r.get("type") == "rule":
        return {"type": "group", "ops": [], "children": [r]}
    if r.get("type") == "group":
        return r
    return _empty_group()


def evaluate_score_tree(
    node: dict | None,
    run_row_index: int,
    gt_row_index: int,
    results_by_index: dict,
    run_ws: Any,
    output_fields: Any,
    gt_content: Any,
    rule_matches_row: RuleMatchesRow,
) -> bool:
    if not node:
        return False
    if node.get("type") == "rule":
        return rule_matches_row(node, run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content)
    if node.get("type") == "group" and isinstance(node.get("children"), list):
        children = node["children"]
        if len(children) == 0:
            return False
        ops = node.get("ops") or (["AND"] * max(0, len(children) - 1))
        r = evaluate_score_tree(children[0], run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content, rule_matches_row)
        for i in range(1, len(children)):
            nxt = evaluate_score_tree(children[i], run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content, rule_matches_row)
            r = (r or nxt) if (ops[i - 1] == "OR") else (r and nxt)
        return r
    return False


def _compute_run_input_band_key(
    run_row_index: int,
    input_root: dict | None,
    results_by_index: dict,
    run_ws: Any,
    output_fields: Any,
    get_run_value: Callable,
) -> str:
    in_r = _normalize_tree_root(input_root)
    input_leaves = flatten_score_rules(in_r)
    rr = results_by_index.get(run_row_index) if run_row_index is not None and run_row_index >= 0 else None
    if len(input_leaves) == 0:
        idx = (rr.get("input_row_index", run_row_index) if isinstance(rr, dict) else run_row_index) if rr else run_row_index
        return f"__ir__:{idx}"
    parts = []
    for rule in input_leaves:
        rv = get_run_value(rr, rule.get("outputKey"), run_row_index, run_ws, output_fields) if rr is not None else ""
        parts.append(f"{rule.get('outputKey') or ''}\0{rv}")
    return "".join(parts)


def _compare_greedy_pairs_key(p: dict) -> tuple:
    """Sort key producing the same order as JS `compareGreedyPairs` (descending score/vec, ascending i/j)."""
    vec = p["vec"]
    neg_vec = tuple(-v for v in vec)
    return (-p["score"], neg_vec, p["i"], p["j"])


def compute_greedy_run_to_gt_pairing(
    *,
    input_root: dict | None,
    output_root: dict | None,
    results: list[dict],
    run_ws: Any,
    gt_content: Any,
    output_fields: Any,
    rule_matches_row: RuleMatchesRow,
    get_run_value: Callable | None = None,
) -> dict:
    """
    Returns {run_to_gt, matched, matched_count, total, run_count} — same shape as the JS
    `computeGreedyRunToGtPairing`. `run_to_gt[i]` is the 0-based GT row index run row `i` was paired
    with, or -1. `gt_content` must expose `.get("rows")` (or attribute `rows`) like the JS `{ rows }` shape.
    """
    results_by_index: dict[int, dict] = {}
    for r in results or []:
        if r:
            results_by_index[r.get("row_index")] = r

    scoring_results = [r for r in (results or []) if r]
    run_row_indices: list[int] = list(dict.fromkeys(r.get("row_index") for r in scoring_results))

    gt_rows = (gt_content.get("rows") if isinstance(gt_content, dict) else getattr(gt_content, "rows", None)) or []
    gt_count = len(gt_rows)
    run_ws_rows = (run_ws.get("rows") if isinstance(run_ws, dict) else getattr(run_ws, "rows", None)) or []
    input_row_count = len(run_ws_rows)
    max_run_row_index = max(run_row_indices) if run_row_indices else -1
    run_count = max(input_row_count, max_run_row_index + 1)
    dim = max(run_count, gt_count)

    in_r = _normalize_tree_root(input_root)
    out_r = _normalize_tree_root(output_root)
    input_leaves = flatten_score_rules(in_r)
    output_leaves = flatten_score_rules(out_r)

    run_to_gt = [-1] * dim
    gt_used = [False] * gt_count

    pairs: list[dict] = []
    for i in run_row_indices:
        for j in range(gt_count):
            if len(input_leaves) > 0:
                input_ok = all(
                    rule_matches_row(rule, i, j, results_by_index, run_ws, output_fields, gt_content)
                    for rule in input_leaves
                )
                if not input_ok:
                    continue
            if len(output_leaves) > 0:
                vec = [1 if rule_matches_row(rule, i, j, results_by_index, run_ws, output_fields, gt_content) else 0 for rule in output_leaves]
                score = sum(vec)
            elif len(input_leaves) > 0:
                vec = [1]
                score = 1
            else:
                vec = []
                score = 0
            if score > 0:
                pairs.append({"i": i, "j": j, "score": score, "vec": vec})

    if get_run_value is not None:
        band_of_run = {i: _compute_run_input_band_key(i, input_root, results_by_index, run_ws, output_fields, get_run_value) for i in run_row_indices}
        pairs_by_band: dict[str, list[dict]] = {}
        for p in pairs:
            pairs_by_band.setdefault(band_of_run[p["i"]], []).append(p)
        for band in sorted(pairs_by_band.keys()):
            band_pairs = sorted(pairs_by_band[band], key=_compare_greedy_pairs_key)
            for p in band_pairs:
                i, j = p["i"], p["j"]
                if run_to_gt[i] >= 0 or gt_used[j]:
                    continue
                run_to_gt[i] = j
                gt_used[j] = True
    else:
        for p in sorted(pairs, key=_compare_greedy_pairs_key):
            i, j = p["i"], p["j"]
            if run_to_gt[i] >= 0 or gt_used[j]:
                continue
            run_to_gt[i] = j
            gt_used[j] = True

    max_row = max(run_count, gt_count)
    matched = [idx < run_count and run_to_gt[idx] >= 0 for idx in range(max_row)]
    matched_count = sum(1 for jj in run_to_gt[:run_count] if jj >= 0)

    return {
        "run_to_gt": run_to_gt,
        "matched": matched,
        "matched_count": matched_count,
        "total": len(scoring_results),
        "run_count": run_count,
    }
