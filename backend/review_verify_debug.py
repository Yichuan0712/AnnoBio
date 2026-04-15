"""Review Verify debug: expand targets like the Electron app and format console output."""

from __future__ import annotations

import json
import os
from typing import Any, Callable


def review_verify_debug_enabled(settings: dict) -> bool:
    v = os.environ.get("REVIEW_VERIFY_DEBUG_PRINT", "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    flag = settings.get("review_verify_debug_print")
    return flag is True or flag in ("true", "1", "yes", "on")


def _stable_row_input_key(row_input: Any) -> str:
    if not isinstance(row_input, dict):
        return ""
    parts = []
    for k in sorted(row_input.keys(), key=lambda x: str(x)):
        parts.append(f"{k}\0{row_input[k]}")
    return "\n".join(parts)


def _runnable_rows_with_input_index(rows: list[dict], input_idx: int) -> list[dict]:
    out = []
    for r in rows:
        if not r or r.get("gt_only"):
            continue
        iri = r.get("input_row_index")
        if isinstance(iri, (int, float)) and not (isinstance(iri, float) and iri != iri):
            if int(iri) == int(input_idx) and int(iri) >= 0:
                out.append(r)
    return out


def _comparison_row_input_identity_key(r: dict | None) -> str | None:
    if not r or r.get("gt_only"):
        return None
    iri = r.get("input_row_index")
    if isinstance(iri, (int, float)) and not (isinstance(iri, float) and iri != iri):
        ii = int(iri)
        if ii >= 0:
            return f"in:{ii}"
    rk = _stable_row_input_key(r.get("row_input"))
    if rk:
        return f"inp:{rk}"
    ri = r.get("row_index")
    if isinstance(ri, (int, float)) and not (isinstance(ri, float) and ri != ri):
        return f"row:{int(ri)}"
    return None


def _expand_input_closure_from_seed_rows(all_rows: list[dict], seed_rows: list[dict]) -> list[dict]:
    identities: set[str] = set()
    for r in seed_rows:
        k = _comparison_row_input_identity_key(r)
        if k:
            identities.add(k)
    if not identities:
        return []
    out: list[dict] = []
    seen: set[int] = set()
    for r in all_rows:
        if not r or r.get("gt_only"):
            continue
        k = _comparison_row_input_identity_key(r)
        if not k or k not in identities:
            continue
        ri = r.get("row_index")
        if not isinstance(ri, (int, float)) or (isinstance(ri, float) and ri != ri):
            continue
        rii = int(ri)
        if rii in seen:
            continue
        seen.add(rii)
        out.append(r)
    out.sort(key=lambda x: int(x.get("row_index", 0)))
    return out


def _push_unique(out: list[dict], arr: list[dict]) -> None:
    seen = {int(x["row_index"]) for x in out if isinstance(x.get("row_index"), (int, float))}
    for r in arr:
        if not r or r.get("gt_only"):
            continue
        ri = r.get("row_index")
        if not isinstance(ri, (int, float)):
            continue
        rii = int(ri)
        if rii not in seen:
            seen.add(rii)
            out.append(r)


def _runnable_rows_for_gt_only_target(all_rows: list[dict], gt_only_row: dict) -> list[dict]:
    out: list[dict] = []
    gt_j = gt_only_row.get("source_gt_row_index")
    if isinstance(gt_j, (int, float)) and int(gt_j) >= 0:
        by_same = [
            r
            for r in all_rows
            if r
            and not r.get("gt_only")
            and isinstance(r.get("source_gt_row_index"), (int, float))
            and int(r["source_gt_row_index"]) == int(gt_j)
        ]
        _push_unique(out, by_same)
    synth_inp = gt_only_row.get("input_row_index")
    if isinstance(synth_inp, (int, float)) and int(synth_inp) >= 0:
        _push_unique(out, _runnable_rows_with_input_index(all_rows, int(synth_inp)))
    want_key = _stable_row_input_key(gt_only_row.get("row_input"))
    if want_key:
        by_prompt = [
            r
            for r in all_rows
            if r and not r.get("gt_only") and _stable_row_input_key(r.get("row_input")) == want_key
        ]
        _push_unique(out, by_prompt)
    if not out:
        _push_unique(out, [r for r in all_rows if r and not r.get("gt_only") and r.get("matched") is False])
    if not out:
        _push_unique(out, [r for r in all_rows if r and not r.get("gt_only")])
    out.sort(key=lambda x: int(x.get("row_index", 0)))
    return out


def _score_table_number_label(rows: list[dict], comparison_row_index: int) -> int | None:
    for x in rows:
        if int(x.get("row_index", -999999)) == int(comparison_row_index):
            st = x.get("score_table_row")
            if isinstance(st, (int, float)) and int(st) >= 1:
                return int(st)
    return None


def expand_targets_to_runnable_comparison_rows(
    comparison_rows: list[dict], ordered_targets: list[int]
) -> tuple[list[dict] | None, str | None]:
    rows = list(comparison_rows or [])
    by_row_index: dict[int, dict] = {}
    for r in rows:
        ri = r.get("row_index")
        if isinstance(ri, (int, float)) and not (isinstance(ri, float) and ri != ri):
            by_row_index[int(ri)] = r

    seed_rows: list[dict] = []
    seen_seed: set[int] = set()

    def add_seed(r: dict | None) -> None:
        if not r or r.get("gt_only"):
            return
        ri = r.get("row_index")
        if not isinstance(ri, (int, float)) or (isinstance(ri, float) and ri != ri):
            return
        rii = int(ri)
        if rii in seen_seed:
            return
        seen_seed.add(rii)
        seed_rows.append(r)

    for t in ordered_targets:
        t = int(t)
        direct = by_row_index.get(t)

        if direct and not direct.get("gt_only"):
            add_seed(direct)
            continue

        if direct and direct.get("gt_only"):
            resolved = _runnable_rows_for_gt_only_target(rows, direct)
            if resolved:
                for r in resolved:
                    add_seed(r)
                continue
            st = _score_table_number_label(rows, t)
            st_part = f" (Score table #{st})" if st is not None else ""
            return None, (
                f"Cannot verify target {t}: comparison row_index {t}{st_part} is ground-truth only (no model output)."
            )

        by_input = _runnable_rows_with_input_index(rows, t)
        if by_input:
            for r in by_input:
                add_seed(r)
            continue

        return None, f"Cannot verify target {t}: no runnable row with row_index {t} or input_row_index {t}."

    closure = _expand_input_closure_from_seed_rows(rows, seed_rows)
    return closure, None


def _run_result_by_index(run_results: list[dict] | None) -> dict[int, dict]:
    m: dict[int, dict] = {}
    for r in run_results or []:
        if not r:
            continue
        ri = r.get("row_index")
        if isinstance(ri, (int, float)) and not (isinstance(ri, float) and ri != ri):
            m[int(ri)] = r
    return m


def _gt_row_dict(gt_content: dict | None, j: int) -> dict[str, Any]:
    if not gt_content or j < 0:
        return {}
    headers = gt_content.get("headers") or []
    g_rows = gt_content.get("rows") or []
    if j >= len(g_rows):
        return {}
    row = g_rows[j]
    if not isinstance(row, list):
        return {}
    out: dict[str, Any] = {}
    for i, h in enumerate(headers):
        key = str(h).strip() if h is not None else f"col{i}"
        out[key] = row[i] if i < len(row) else None
    return out


def format_verify_debug_report(payload: dict) -> str:
    """Build multi-line report (UTF-8) for terminal or logs."""
    comparison_rows = payload.get("comparison_rows") or []
    targets = payload.get("targets") or payload.get("target_input_row_indices") or []
    if not isinstance(targets, list):
        targets = []
    ordered: list[int] = []
    seen: set[int] = set()
    for x in targets:
        try:
            n = int(x)
        except (TypeError, ValueError):
            continue
        if n < 0 or n in seen:
            continue
        seen.add(n)
        ordered.append(n)

    lines: list[str] = []
    lines.append("[Review Verify debug] === expansion (input-closed, same as reviewSuggestionTest.js) ===")
    lines.append(f"targets (seeds): {ordered}")
    outcome_ok = payload.get("outcome_ok")
    outcome_detail = payload.get("outcome_detail")
    if outcome_ok is not None or outcome_detail:
        lines.append(f"client outcome: ok={outcome_ok!r} detail={outcome_detail!r}")

    if not ordered:
        lines.append("(no targets — nothing to expand)")
        return "\n".join(lines) + "\n"

    expanded, err = expand_targets_to_runnable_comparison_rows(
        list(comparison_rows) if isinstance(comparison_rows, list) else [], ordered
    )
    if err:
        lines.append(f"expand error: {err}")
        return "\n".join(lines) + "\n"
    assert expanded is not None
    lines.append(f"expanded row_index order: {[int(r['row_index']) for r in expanded]}")
    lines.append("")

    run_results = payload.get("run_results")
    by_run = _run_result_by_index(run_results if isinstance(run_results, list) else None)
    verify_outputs = payload.get("verify_outputs")
    if verify_outputs is not None and not isinstance(verify_outputs, list):
        verify_outputs = None
    gt_content = payload.get("gt_content") or payload.get("gtContent")

    for i, comp in enumerate(expanded):
        ri = comp.get("row_index")
        gt_j = comp.get("source_gt_row_index")
        iri = comp.get("input_row_index")
        parts = [
            f"[{i}] comparison row_index={ri}",
            f"input_row_index={iri}",
            f"source_gt_row_index={gt_j}",
        ]
        if comp.get("score_table_row") is not None:
            parts.append(f"score_table_row={comp.get('score_table_row')}")
        lines.append(" ".join(str(x) for x in parts))

        if verify_outputs and i < len(verify_outputs):
            vo = verify_outputs[i]
            lines.append(
                "  fresh_verify_output: "
                + json.dumps(vo.get("output"), ensure_ascii=False, indent=2).replace("\n", "\n    ")
            )
            if vo.get("error"):
                lines.append(f"  fresh_verify_error: {vo.get('error')}")
        else:
            ro = comp.get("run_output")
            if isinstance(ro, dict) and ro:
                lines.append(
                    "  stored run_output (comparison row): "
                    + json.dumps(ro, ensure_ascii=False, indent=2).replace("\n", "\n    ")
                )
            elif isinstance(ri, (int, float)) and int(ri) in by_run:
                out = by_run[int(ri)].get("output")
                lines.append(
                    "  run_results[row_index].output: "
                    + json.dumps(out, ensure_ascii=False, indent=2).replace("\n", "\n    ")
                )

        gto = comp.get("ground_truth_output")
        if isinstance(gto, dict) and gto:
            lines.append(
                "  ground_truth_output (on comparison row): "
                + json.dumps(gto, ensure_ascii=False, indent=2).replace("\n", "\n    ")
            )
        exp = comp.get("expected")
        if exp:
            lines.append(f"  expected (human string): {exp}")

        if isinstance(gt_j, (int, float)) and int(gt_j) >= 0 and isinstance(gt_content, dict):
            g_row = _gt_row_dict(gt_content, int(gt_j))
            if g_row:
                lines.append(
                    "  gt_content row %s: %s"
                    % (
                        int(gt_j),
                        json.dumps(g_row, ensure_ascii=False, indent=2).replace("\n", "\n    "),
                    )
                )
        lines.append("")

    return "\n".join(lines)


def print_verify_debug_report(payload: dict, print_fn: Callable[..., None]) -> None:
    print_fn(format_verify_debug_report(payload).rstrip())
