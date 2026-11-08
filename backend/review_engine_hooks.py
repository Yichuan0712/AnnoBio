"""The task-model and scoring hooks the AnnoBio engine's worked-example card needs (review_engine_v2.example_card).

The Optimize request carries what Verify already uses (scoreDetailModal.js runReviewStart): the Generate model and
its run settings, the Score node's bundle or match code, and the input / ground-truth table rows this Optimize
refers to (`score_tables`, rows kept at their original indices). With these the backend scores an input exactly as
Verify does: score_engine.evaluate_score_output_gt with the same input entries Verify builds for a card
(reviewSuggestionActions.js buildInputEntriesForSuggestion: the input's original row index and the ground-truth rows
its comparison rows name) and the same tables.
"""
from __future__ import annotations

from typing import Any, Callable

from score_engine import evaluate_score_output_gt


def dense_table(headers: list | None, indexed_rows: list | None) -> dict:
    """{headers, rows} with every given row at its original index (rows not sent are empty, never referenced)."""
    rows: list = []
    for item in indexed_rows or []:
        index, row = int(item[0]), item[1]
        if index < 0:
            continue
        while len(rows) <= index:
            rows.append([])
        rows[index] = list(row or [])
    return {"headers": list(headers or []), "rows": rows}


def _row(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    return raw.model_dump() if hasattr(raw, "model_dump") else raw.dict()


def input_entries_by_example(comparison_rows: list) -> dict[str, list]:
    """example id ("input-<n>", review_engine_v2.build_inputs) -> Verify's input entry for that input alone.
    Rows without an input_row_index are skipped, as Verify skips them."""
    entries: dict[int, dict] = {}
    for raw in comparison_rows:
        row = _row(raw)
        index = row.get("input_row_index")
        if index is None:
            continue
        entry = entries.setdefault(int(index), {"gtRows": []})
        gt = row.get("source_gt_row_index")
        # JS: `row?.ground_truth_output && row?.source_gt_row_index != null`; an object (even {}) is truthy.
        if row.get("ground_truth_output") is not None and gt is not None:
            gt_num = int(gt) + 1
            if not any(g["gtNum"] == gt_num for g in entry["gtRows"]):
                entry["gtRows"].append({"gtNum": gt_num, "gtRowIndex": int(gt)})
    return {f"input-{index + 1}": [index, entry] for index, entry in entries.items()}


def make_score_input(*, comparison_rows: list, score_mapping: Any, score_match_code: str, score_tables: dict,
                     output_fields: list, python_path: str | None, project_session_id: str | None,
                     evaluate: Callable = evaluate_score_output_gt):
    """score_input(example_id, outputs) -> (matched_count, total_count), Verify's verdict for that input."""
    run_ws = dense_table(score_tables.get("input_headers"), score_tables.get("input_rows"))
    gt_content = dense_table(score_tables.get("gt_headers"), score_tables.get("gt_rows"))
    entries = input_entries_by_example(comparison_rows)

    def score_input(example_id: str, outputs: list) -> tuple[int, int]:
        entry = entries[example_id]
        results = [{"row_index": i, "input_row_index": 0, "output": out if isinstance(out, dict) else {}, "error": None}
                   for i, out in enumerate(outputs)]
        verdict = evaluate(score_mapping=score_mapping, score_match_code=score_match_code or "", results=results,
                           input_entries=[entry], output_fields=output_fields, run_ws=run_ws, gt_content=gt_content,
                           python_path=python_path or None, project_session_id=project_session_id)
        return int(verdict["matchedCount"]), int(verdict["total"])
    score_input.scorable = set(entries)
    return score_input
