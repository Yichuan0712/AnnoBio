"""
Server-side pass-rate evaluation for Review Finetune (MIPROv2 metric).
Mirrors app/src/reviewSuggestionTest.js + scoreDetailModal.js scoring for target rows.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Optional

from typing import List

from pydantic import BaseModel, Field, create_model

from llm import run_structured as llm_run_structured

EMBEDDING_COSINE_THRESHOLD = 0.76
SEMANTIC_ALIGN_DICE_THRESHOLD = 0.65

DEFAULT_SCORE_MATCH_FLAGS: dict[str, Any] = {
    "semanticAlign": False,
    "embeddingSimilarity": False,
    "contains": False,
    "ignoreCase": False,
    "ignoreSymbols": False,
    "ignoreWhitespace": False,
    "numericMode": "exact",
    "numericAbsEpsilon": 0,
    "numericRelEpsilon": 0,
    "numericDecimalPlaces": 2,
}


def _sanitize_field_name(key: str) -> str:
    s = re.sub(r"[^\w]", "_", str(key).strip())
    return s or "field"


def build_output_model(fields: list[dict]) -> type[BaseModel]:
    type_map = {
        "str": (str, ...),
        "float": (float, ...),
        "list_str": (list[str], ...),
        "list_float": (list[float], ...),
    }
    field_defs: dict[str, Any] = {}
    for f in fields:
        key = f.get("key") or "field"
        name = _sanitize_field_name(key)
        if name in field_defs:
            n = 1
            while f"{name}_{n}" in field_defs:
                n += 1
            name = f"{name}_{n}"
        raw_type = (f.get("type") or "str").strip().lower()
        desc = (f.get("description") or "").strip() or None
        allow_none = f.get("allow_none") or f.get("allowNone") is True
        if raw_type not in type_map:
            raw_type = "str"
        typ, _ = type_map[raw_type]
        if allow_none:
            typ = Optional[typ]
            field_defs[name] = (typ, Field(default=None, description=desc or key))
        else:
            field_defs[name] = (typ, Field(..., description=desc or key))
    return create_model("StructuredOutput", **field_defs)


def build_table_output_model(row_model: type[BaseModel]) -> type[BaseModel]:
    return create_model("TableOutput", rows=(List[row_model], Field(default_factory=list)))


def migrate_legacy_match_type(match_type: str | None) -> str:
    if match_type in ("contains", "gt-contains-run"):
        return "exact"
    return match_type or "exact"


def legacy_match_type_was_contains(match_type: str | None) -> bool:
    return match_type in ("contains", "gt-contains-run")


def round_to_decimals(n: float, places: int) -> float:
    p = max(0, min(20, math.floor(places)))
    m = 10**p
    return round(n * m) / m


def normalize_for_match(s: Any, flags: dict[str, Any], is_numeric: bool) -> str:
    t = "" if s is None else str(s).strip()
    if is_numeric:
        return t
    if flags.get("ignoreWhitespace"):
        t = re.sub(r"\s+", " ", t).strip()
    if flags.get("ignoreCase"):
        t = t.lower()
    if flags.get("ignoreSymbols"):
        t = re.sub(r"[^\w\s]", "", t)
        t = re.sub(r"\s+", " ", t).strip()
    return t


def numeric_pair_matches(run_trimmed: str, gt_trimmed: str, flags: dict[str, Any]) -> bool:
    run_norm = "" if run_trimmed is None else str(run_trimmed).strip()
    gt_norm = "" if gt_trimmed is None else str(gt_trimmed).strip()
    try:
        run_num = float(run_norm)
        gt_num = float(gt_norm)
    except ValueError:
        return run_norm == gt_norm
    if not math.isfinite(run_num) or not math.isfinite(gt_num):
        return run_norm == gt_norm
    mode = flags.get("numericMode") or "exact"
    if mode == "abs":
        eps = float(flags.get("numericAbsEpsilon") or 0)
        eps = eps if math.isfinite(eps) and eps >= 0 else 0.0
        return abs(run_num - gt_num) <= eps
    if mode == "rel":
        rel = float(flags.get("numericRelEpsilon") or 0)
        r = rel if math.isfinite(rel) and rel >= 0 else 0.0
        denom = max(abs(run_num), abs(gt_num), 1e-15)
        return abs(run_num - gt_num) / denom <= r
    if mode == "decimals":
        p = int(flags.get("numericDecimalPlaces") or 2)
        if not math.isfinite(p):
            p = 2
        p = max(0, min(20, p))
        return round_to_decimals(run_num, p) == round_to_decimals(gt_num, p)
    return run_num == gt_num


def strings_match_contains(run_val: Any, gt_val: Any) -> bool:
    r = "" if run_val is None else str(run_val)
    g = "" if gt_val is None else str(gt_val)
    if len(r) == 0 and len(g) == 0:
        return True
    if len(r) == 0 or len(g) == 0:
        return False
    return g in r or r in g


def _normalize_semantic_align_input(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v if v is not None else "").strip().lower()).strip()


def _string_char_bigrams(s: str) -> list[str]:
    if len(s) < 2:
        return []
    return [s[i : i + 2] for i in range(len(s) - 1)]


def strings_match_semantic_align(run_val: Any, gt_val: Any) -> bool:
    a = _normalize_semantic_align_input(run_val)
    b = _normalize_semantic_align_input(gt_val)
    if len(a) == 0 and len(b) == 0:
        return True
    if len(a) == 0 or len(b) == 0:
        return False
    if a == b:
        return True
    if len(a) < 2 or len(b) < 2:
        return a == b
    ba = _string_char_bigrams(a)
    bb = _string_char_bigrams(b)
    counts: dict[str, int] = {}
    for x in ba:
        counts[x] = counts.get(x, 0) + 1
    inter = 0
    for x in bb:
        c = counts.get(x) or 0
        if c > 0:
            inter += 1
            counts[x] = c - 1
    dice = (2 * inter) / (len(ba) + len(bb)) if (len(ba) + len(bb)) > 0 else 0.0
    return dice >= SEMANTIC_ALIGN_DICE_THRESHOLD


def to_compare_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, list):
        return ", ".join(to_compare_str(x) for x in v).strip()
    return str(v).strip()


def get_match_flags(rule: dict[str, Any]) -> dict[str, Any]:
    raw = rule.get("matchFlags") if isinstance(rule.get("matchFlags"), dict) else {}
    out = {**DEFAULT_SCORE_MATCH_FLAGS, **raw}
    return out


def normalize_score_mapping_to_rules(data: Any) -> list[dict[str, Any]]:
    if not data:
        return []
    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
        first = data[0]
        if first.get("outputKey") is not None and first.get("gtColumn") is not None:
            pairs = []
            for r in data:
                pairs.append(
                    {
                        "outputKey": r.get("outputKey") or "",
                        "gtColumn": r.get("gtColumn") or "",
                        "matchType": r.get("matchType") or "exact",
                    }
                )
            by_key: dict[str, Any] = {}
            for p in pairs:
                raw_mt = p.get("matchType") or "exact"
                k = p.get("outputKey") or ""
                if k not in by_key:
                    by_key[k] = {
                        "outputKey": k,
                        "gtColumns": [],
                        "matchType": migrate_legacy_match_type(raw_mt),
                        "anyContains": False,
                    }
                if legacy_match_type_was_contains(raw_mt):
                    by_key[k]["anyContains"] = True
                by_key[k]["matchType"] = migrate_legacy_match_type(raw_mt)
                gc = p.get("gtColumn") or ""
                if gc and gc not in by_key[k]["gtColumns"]:
                    by_key[k]["gtColumns"].append(gc)
            return [
                {
                    "outputKey": r["outputKey"],
                    "gtColumns": r["gtColumns"],
                    "matchType": r["matchType"],
                    "matchFlags": {**DEFAULT_SCORE_MATCH_FLAGS, "contains": r["anyContains"]},
                }
                for r in by_key.values()
                if r["outputKey"] or r["gtColumns"]
            ]
        if first.get("rules") is not None:
            pairs = []
            for g in data:
                for r in g.get("rules") or []:
                    pairs.append(
                        {
                            "outputKey": r.get("outputKey") or "",
                            "gtColumn": r.get("gtColumn") or "",
                            "matchType": r.get("matchType") or "exact",
                        }
                    )
            return normalize_score_mapping_to_rules(pairs)
    return []


def parse_score_mapping_to_tree(data: Any) -> dict[str, Any]:
    if not data:
        return {"type": "group", "ops": [], "children": []}
    if isinstance(data, dict) and data.get("type") == "group" and isinstance(data.get("children"), list):
        children = []
        for c in data["children"]:
            if c and c.get("type") == "group":
                children.append(parse_score_mapping_to_tree(c))
            else:
                children.append(_normalize_score_child(c))
        ops = data.get("ops") or []
        n = max(0, len(children) - 1)
        if not isinstance(ops, list) or len(ops) < n:
            default_op = "OR" if data.get("op") == "OR" else "AND"
            ops = list(ops)[:n] if len(ops) >= n else list(ops) + [default_op] * (n - len(ops))
        else:
            ops = [o if o == "OR" else "AND" for o in ops[:n]]
        return {"type": "group", "ops": ops, "children": children}
    rules = normalize_score_mapping_to_rules(data)
    children = []
    for r in rules:
        children.append(
            {
                "type": "rule",
                "outputKey": r.get("outputKey") or "",
                "gtColumns": list(r.get("gtColumns") or []),
                "matchType": migrate_legacy_match_type(r.get("matchType")),
                "matchFlags": get_match_flags({"matchFlags": r.get("matchFlags")}),
            }
        )
    ops = ["AND"] * max(0, len(children) - 1)
    return {"type": "group", "ops": ops, "children": children}


def _normalize_score_child(c: Any) -> dict[str, Any]:
    if not c or c.get("type") != "rule":
        return {"type": "rule", "outputKey": "", "gtColumns": [], "matchType": "exact", "matchFlags": dict(DEFAULT_SCORE_MATCH_FLAGS)}
    raw_mt = c.get("matchType") or "exact"
    f = {**DEFAULT_SCORE_MATCH_FLAGS, **(c.get("matchFlags") or {})}
    if legacy_match_type_was_contains(raw_mt):
        f["contains"] = True
    return {
        "type": "rule",
        "outputKey": (c.get("outputKey") or ""),
        "gtColumns": list(c.get("gtColumns") or []),
        "matchType": migrate_legacy_match_type(raw_mt),
        "matchFlags": f,
    }


def get_run_value(run_result: dict[str, Any] | None, output_key: str, run_ws: dict[str, Any], output_fields: list[Any]) -> str:
    if not run_result:
        run_result = {}
    display_idx = run_result.get("row_index", 0)
    input_row_idx = run_result.get("input_row_index", run_result.get("row_index", 0))
    if output_key in ("#", "[#]"):
        return to_compare_str(display_idx)
    key_str = str(output_key or "").strip()
    if key_str.startswith("[") and key_str.endswith("]"):
        header = key_str[1:-1].strip()
        rows = run_ws.get("rows") or []
        headers = run_ws.get("headers") or []
        col_idx = next((i for i, h in enumerate(headers) if str(h).strip() == header), -1)
        if col_idx >= 0 and input_row_idx < len(rows) and rows[input_row_idx] is not None:
            row = rows[input_row_idx]
            if col_idx < len(row):
                return to_compare_str(row[col_idx])
        return ""
    out = run_result.get("output")
    if isinstance(out, dict) and key_str in out:
        return to_compare_str(out[key_str])
    if run_result.get("error"):
        return to_compare_str(run_result.get("error"))
    return ""


def get_gt_value(gt_content: dict[str, Any], row_index: int, column_name: str) -> str:
    headers = gt_content.get("headers") or []
    rows = gt_content.get("rows") or []
    col_idx = next((i for i, h in enumerate(headers) if str(h).strip() == str(column_name).strip()), -1)
    if col_idx >= 0 and 0 <= row_index < len(rows) and rows[row_index] is not None:
        row = rows[row_index]
        if col_idx < len(row):
            return to_compare_str(row[col_idx])
    return ""


def _escape_regex(s: str) -> str:
    return re.sub(r"[.*+?^${}()|[\]\\]", lambda m: "\\" + m.group(0), s)


def find_segment_in_content(content: str, old_sentence: str) -> str | None:
    if not content or old_sentence is None:
        return None
    trimmed = str(old_sentence).strip()
    if not trimmed:
        return None
    if trimmed in content:
        return trimmed
    pattern = _escape_regex(trimmed).replace(r"\s+", r"\\s+")
    if r"\s+" not in pattern:
        pattern = re.sub(r"\s+", r"\\s+", pattern)
    try:
        m = re.search(pattern, content)
        return m.group(0) if m else None
    except re.error:
        return None


def get_locatable_segment(content: str, old_sentence: str) -> str | None:
    seg = find_segment_in_content(content, old_sentence)
    if seg:
        return seg
    # minimal fallback: normalized equality on chunks
    if not content or old_sentence is None:
        return None
    trimmed = str(old_sentence).strip()
    if not trimmed:
        return None

    def norm(s: str) -> str:
        return re.sub(r"\s+", " ", s).strip()

    norm_old = norm(trimmed)
    parts = re.split(r"(?<=[.!?\n])\s*|\n", content)
    best = None
    best_score = 0
    for part in parts:
        seg2 = part.strip()
        if len(seg2) < 2:
            continue
        ns = norm(seg2)
        if ns == norm_old:
            return seg2
        if norm_old in ns or ns in norm_old:
            score = min(len(ns), len(norm_old))
            if score > best_score:
                best_score = score
                best = seg2
    return best


def rebuild_working_from_applied(
    originals: list[dict[str, Any]],
    suggestions: list[dict[str, Any]],
) -> list[dict[str, str]] | None:
    if not isinstance(originals, list) or not isinstance(suggestions, list):
        return None
    sections = [{"name": str(s.get("name") or ""), "content": str(s.get("content") or "")} for s in originals]
    for s in suggestions:
        if s.get("applied") is not True:
            continue
        sec_idx = max(0, min(int(s.get("section_index") or 0), len(sections) - 1))
        use_sentence = s.get("old_sentence") is not None and s.get("new_sentence") is not None
        old_sentence = str(s.get("old_sentence") or "").strip()
        new_sentence = str(s.get("new_sentence") or "").strip()
        legacy_new = str(s.get("new_content") or "").strip()
        content = sections[sec_idx]["content"] if sections[sec_idx] else ""
        if use_sentence:
            seg = get_locatable_segment(content, old_sentence) or old_sentence
            to_replace = seg or old_sentence
            if to_replace in content:
                sections[sec_idx]["content"] = content.replace(to_replace, new_sentence, 1)
            else:
                seg_new = get_locatable_segment(content, new_sentence)
                if seg_new:
                    sections[sec_idx]["content"] = content.replace(seg_new, old_sentence, 1)
                else:
                    sections[sec_idx]["content"] = content.replace(new_sentence, old_sentence, 1)
        else:
            sections[sec_idx]["content"] = legacy_new
    return sections


def sections_to_template(sections: list[dict[str, Any]]) -> str:
    parts = []
    for s in sections:
        name = str(s.get("name") or "").strip() or "(unnamed)"
        content = str(s.get("content") or "").strip() or ""
        parts.append(f"## {name}\n\n{content}")
    return "\n\n".join(parts)


def substitute_prompt_placeholders(template_text: str, row_input: dict[str, Any] | None) -> str:
    text = str(template_text or "")
    inp = row_input if isinstance(row_input, dict) else {}
    for k, val in inp.items():
        name = str(k).strip()
        if not name:
            continue
        v = "" if val is None else str(val)
        text = text.replace("{" + name + "}", v)
    return text


def _collect_embedding_pairs(
    score_root: dict[str, Any],
    results_by_index: dict[int, dict[str, Any]],
    run_ws: dict[str, Any],
    output_fields: list[Any],
    gt_content: dict[str, Any],
) -> list[list[str]]:
    leaf_rules: list[dict[str, Any]] = []

    def walk(n: dict[str, Any] | None) -> None:
        if not n:
            return
        if n.get("type") == "rule":
            leaf_rules.append(n)
        if n.get("type") == "group":
            for ch in n.get("children") or []:
                walk(ch)

    walk(score_root)
    embedding_rules = []
    for rule in leaf_rules:
        f = get_match_flags(rule)
        if migrate_legacy_match_type(rule.get("matchType")) == "exact" and f.get("embeddingSimilarity"):
            embedding_rules.append(rule)
    if not embedding_rules:
        return []
    run_row_indices = sorted(results_by_index.keys())
    gt_count = len(gt_content.get("rows") or [])
    pairs: list[list[str]] = []
    for i in run_row_indices:
        run_result = results_by_index.get(i)
        for j in range(gt_count):
            for rule in embedding_rules:
                run_val = get_run_value(run_result, rule.get("outputKey") or "", run_ws, output_fields)
                for col in rule.get("gtColumns") or []:
                    gt = get_gt_value(gt_content, j, col)
                    pairs.append([run_val, gt])
    return pairs


def _build_embedding_map(pairs: list[list[str]]) -> dict[str, float]:
    if not pairs:
        return {}
    try:
        from embedding_service import compute_pair_cosine_similarities
    except ImportError:
        return {}
    sims = compute_pair_cosine_similarities(pairs)
    out: dict[str, float] = {}
    for ab, c in zip(pairs, sims):
        key = json.dumps([ab[0], ab[1]], ensure_ascii=False)
        out[key] = float(c)
    return out


def embedding_pair_matches(run_val_raw: str, gt_val_raw: str, embedding_map: dict[str, float]) -> bool:
    a = "" if run_val_raw is None else str(run_val_raw)
    b = "" if gt_val_raw is None else str(gt_val_raw)
    if len(a.strip()) == 0 and len(b.strip()) == 0:
        return True
    if len(a.strip()) == 0 or len(b.strip()) == 0:
        return False
    key = json.dumps([a, b], ensure_ascii=False)
    c = embedding_map.get(key)
    if c is None or not math.isfinite(c):
        return False
    return c >= EMBEDDING_COSINE_THRESHOLD


def rule_matches_row(
    rule: dict[str, Any],
    run_row_index: int,
    gt_row_index: int,
    results_by_index: dict[int, dict[str, Any]],
    run_ws: dict[str, Any],
    output_fields: list[Any],
    gt_content: dict[str, Any],
    embedding_map: dict[str, float],
) -> bool:
    if not rule or rule.get("type") != "rule":
        return False
    run_result = results_by_index.get(run_row_index)
    run_val_raw = get_run_value(run_result, rule.get("outputKey") or "", run_ws, output_fields)
    gt_vals_raw = [get_gt_value(gt_content, gt_row_index, col) for col in (rule.get("gtColumns") or [])]
    match_type = migrate_legacy_match_type(rule.get("matchType"))
    flags = get_match_flags(rule)

    if match_type == "numeric":
        run_norm = normalize_for_match(run_val_raw, flags, True)
        for g in gt_vals_raw:
            gt_norm = normalize_for_match(g, flags, True)
            if numeric_pair_matches(run_norm, gt_norm, flags):
                return True
        return False

    if match_type == "exact" and flags.get("embeddingSimilarity"):
        return any(embedding_pair_matches(run_val_raw, g, embedding_map) for g in gt_vals_raw)
    if match_type == "exact" and flags.get("semanticAlign"):
        return any(strings_match_semantic_align(run_val_raw, g) for g in gt_vals_raw)
    run_val = normalize_for_match(run_val_raw, flags, False)
    for g in gt_vals_raw:
        gt_val = normalize_for_match(g, flags, False)
        if match_type == "exact":
            if flags.get("contains"):
                if strings_match_contains(run_val, gt_val):
                    return True
            elif run_val == gt_val:
                return True
        elif run_val == gt_val:
            return True
    return False


def evaluate_score_tree(
    node: dict[str, Any] | None,
    run_row_index: int,
    gt_row_index: int,
    results_by_index: dict[int, dict[str, Any]],
    run_ws: dict[str, Any],
    output_fields: list[Any],
    gt_content: dict[str, Any],
    embedding_map: dict[str, float],
) -> bool:
    if not node:
        return False
    if node.get("type") == "rule":
        return rule_matches_row(node, run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content, embedding_map)
    if node.get("type") == "group":
        children = node.get("children") or []
        if not children:
            return False
        ops = node.get("ops") or ["AND"] * max(0, len(children) - 1)
        r = evaluate_score_tree(children[0], run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content, embedding_map)
        for i in range(1, len(children)):
            nxt = evaluate_score_tree(children[i], run_row_index, gt_row_index, results_by_index, run_ws, output_fields, gt_content, embedding_map)
            op = ops[i - 1] if i - 1 < len(ops) else "AND"
            r = r or nxt if op == "OR" else r and nxt
        return r
    return False


def compute_pass_rate(
    *,
    provider: str,
    model: str,
    api_key: str,
    run_max_tokens: int,
    originals: list[dict[str, Any]],
    all_suggestions: list[dict[str, Any]],
    sug_index: int,
    candidate_rewrite: str,
    expanded_rows: list[dict[str, Any]],
    run_results: list[dict[str, Any]],
    output_fields: list[Any],
    output_schema: dict[str, Any],
    score_mapping_json: Any,
    run_ws: dict[str, Any],
    gt_content: dict[str, Any],
) -> tuple[float, bool, str]:
    """
    Returns (pass_rate 0..1, ok, error_message).
    """
    fields = output_schema.get("fields") or []
    if not fields:
        return 0.0, False, "Missing output schema fields"
    try:
        raw = score_mapping_json
        if isinstance(raw, str):
            raw = json.loads(raw or "[]")
        score_root = parse_score_mapping_to_tree(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return 0.0, False, "Invalid score mapping"

    patched: list[dict[str, Any]] = []
    for i, s in enumerate(all_suggestions):
        base = dict(s) if isinstance(s, dict) else {}
        if i == sug_index:
            patched.append({**base, "applied": True, "new_sentence": candidate_rewrite})
        else:
            patched.append({**base, "applied": False})
    test_sections = rebuild_working_from_applied(originals, patched)
    if not test_sections or len(test_sections) != len(originals):
        return 0.0, False, "prompt rebuild failed"

    template_text = sections_to_template(test_sections)
    prompts = [substitute_prompt_placeholders(template_text, row.get("row_input") or {}) for row in expanded_rows]
    if not prompts:
        return 0.0, False, "No runnable expanded rows"

    shape_raw = str(output_schema.get("return_shape") or "single").strip().lower()
    return_shape = shape_raw if shape_raw in ("single", "table") else "single"
    if return_shape == "table":
        RowModel = build_output_model(fields)
        ResponseModel = build_table_output_model(RowModel)
    else:
        ResponseModel = build_output_model(fields)

    fresh_outputs: list[dict[str, Any]] = []
    for prompt in prompts:
        try:
            out, _fb = llm_run_structured(
                provider=provider,
                model=model,
                api_key=api_key,
                prompt=prompt,
                response_model=ResponseModel,
                max_tokens=run_max_tokens,
                return_shape=return_shape,
            )
            if return_shape == "table" and isinstance(out, dict) and "rows" in out:
                rows = out["rows"]
                if isinstance(rows, list) and len(rows) > 0 and isinstance(rows[0], dict):
                    out = rows[0]
                else:
                    return 0.0, False, "empty table output"
            if not isinstance(out, dict):
                return 0.0, False, "invalid structured output"
            fresh_outputs.append(out)
        except Exception as e:
            return 0.0, False, str(e)[:500]

    if len(fresh_outputs) != len(expanded_rows):
        return 0.0, False, "internal row count mismatch"

    results_by_index: dict[int, dict[str, Any]] = {}
    for r in run_results or []:
        if r and isinstance(r.get("row_index"), int):
            results_by_index[int(r["row_index"])] = dict(r)

    emb_pairs = _collect_embedding_pairs(score_root, results_by_index, run_ws, output_fields, gt_content)
    embedding_map = _build_embedding_map(emb_pairs)

    passed = 0
    total = 0
    for i, comp_row in enumerate(expanded_rows):
        comp_idx = comp_row.get("row_index")
        gt_j = comp_row.get("source_gt_row_index")
        if not isinstance(comp_idx, int):
            return 0.0, False, "invalid comparison row"
        if gt_j is None or (isinstance(gt_j, float) and math.isnan(gt_j)):
            return 0.0, False, f"No paired ground truth for row_index {comp_idx}"
        gt_j = int(gt_j)
        syn_out = dict(fresh_outputs[i])
        base_res = results_by_index.get(comp_idx) or {"row_index": comp_idx, "output": {}}
        results_by_index[comp_idx] = {**base_res, "row_index": comp_idx, "output": syn_out, "error": None}
        emb_pairs2 = _collect_embedding_pairs(score_root, results_by_index, run_ws, output_fields, gt_content)
        embedding_map = _build_embedding_map(emb_pairs2)
        total += 1
        if evaluate_score_tree(score_root, comp_idx, gt_j, results_by_index, run_ws, output_fields, gt_content, embedding_map):
            passed += 1

    if total == 0:
        return 0.0, False, "no rows scored"
    return passed / total, True, ""
