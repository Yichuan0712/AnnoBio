"""
Review analyze pipeline, separate from FastAPI main module.

Phase 1 — per **failed input**: same dataset input, **all** unmatched model outputs vs their paired expected/scoring context in one LLM call; then rough opinion.

Phase 2 — one LLM call (after phase 1): **Modifications** → localized **prompt_edits** only (Accept/Revert in UI).

Extraction-style tasks: **under-coverage** (required items missing) and **over-coverage** (extra items not in ground truth) are both failures—the prompts below tell the model to diagnose and fix with that rubric.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from pydantic import BaseModel, Field

from llm import run_structured as llm_run_structured

logger = logging.getLogger(__name__)

# Server-side cap on validated edits (response size / UI); not stated in LLM prompts.
_MAX_VALIDATED_PROMPT_EDITS = 64


def _sec_name_content(sec: Any) -> tuple[str, str]:
    if isinstance(sec, dict):
        return (str(sec.get("name") or "").strip() or "(unnamed)", str(sec.get("content") or ""))
    return (str(getattr(sec, "name", "") or "").strip() or "(unnamed)", str(getattr(sec, "content", "") or ""))


def format_prompt_for_review(prompt_sections: list[Any]) -> str:
    parts: list[str] = []
    for i, sec in enumerate(prompt_sections or []):
        name, content = _sec_name_content(sec)
        parts.append(f"### Section {i}: {name}\n\n{content.strip() or '(empty)'}")
    return "\n\n".join(parts) if parts else "(No prompt sections)"


def _row_to_dict(row: Any) -> dict[str, Any]:
    if hasattr(row, "model_dump"):
        return row.model_dump()
    return dict(row) if isinstance(row, dict) else {}


def _input_identity_key(d: dict[str, Any]) -> str:
    """Stable key to group comparison rows that share the same dataset input (1 input → N outputs)."""
    iri = d.get("input_row_index")
    if iri is not None:
        try:
            return f"in:{int(iri)}"
        except (TypeError, ValueError):
            pass
    ri = d.get("row_input")
    if isinstance(ri, dict) and ri:
        return "inp:" + json.dumps(ri, ensure_ascii=False, sort_keys=True, default=str)
    try:
        return f"row:{int(d.get('row_index', -1))}"
    except (TypeError, ValueError):
        return f"row:{d.get('row_index', -1)!s}"


def _group_comparison_rows_by_input(rows: list[Any]) -> list[list[Any]]:
    buckets: dict[str, list[Any]] = {}
    order: list[str] = []
    for r in rows:
        key = _input_identity_key(_row_to_dict(r))
        if key not in buckets:
            order.append(key)
            buckets[key] = []
        buckets[key].append(r)
    groups = [buckets[k] for k in order]
    for g in groups:
        g.sort(key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    return groups


class PerRowOpinion(BaseModel):
    """Structured output for phase 1 (one failed input group; row_index = min comparison row_index in that group)."""

    row_index: int = Field(
        ...,
        description="Smallest comparison row_index in this input group (0-based; ties the opinion to the score table)",
    )
    card_title: str = Field(
        default="",
        description=(
            "Very short UI headline (about 4–12 words): a plain-English summary of the failure for a list card. "
            "Like a concise news headline—not snake_case, not a variable name, not the same long text as issue_summary."
        ),
    )
    issue_summary: str = Field(..., description="One or two sentences: what went wrong vs expected")
    rough_modification_opinion: str = Field(
        ...,
        description="Rough, prompt-level advice (criteria, wording, format)—not a full rewritten prompt",
    )
    problem_category_hint: str = Field(
        default="",
        description=(
            "Short tag for grouping, e.g. format_mismatch, missing_field, omission, over_extraction, ambiguity, threshold"
        ),
    )


class PromptEditSuggestion(BaseModel):
    """One localized prompt change; old_sentence must exist verbatim in the section (UI highlights red/green)."""

    name: str = Field(..., description="Short title for this edit")
    phase1_addresses: list[str] = Field(
        ...,
        min_length=1,
        max_length=3,
        description=(
            "1–3 strings naming Phase 1 findings this edit fixes; if many bullets are the same failure class, merge into fewer strings"
        ),
    )
    section_index: int = Field(0, ge=0, description="0-based index of the section to edit")
    old_sentence: str = Field(
        ...,
        description="Exact contiguous substring copied character-for-character from that section's body",
    )
    new_sentence: str = Field(
        default="",
        description="Replacement; empty string for pure deletion",
    )
    reason: str = Field(
        ...,
        description="How this old→new change implements the fix for the phase1_addresses items (1–2 sentences)",
    )
    row_indices: list[int] = Field(
        default_factory=list,
        description="Optional 0-based row indices this edit is meant to help",
    )


class Phase2Modifications(BaseModel):
    """Structured output for the modifications-only LLM call (localized prompt_edits)."""

    prompt_edits: list[PromptEditSuggestion] = Field(
        default_factory=list,
        description=(
            "Every edit MUST resolve at least one issue named in Phase 1 (section 3); together they MUST cover "
            "those failures—no unrelated or generic-only improvements; each old_sentence verbatim in section body"
        ),
    )


def _build_phase1_prompt_for_input_group(*, prompt_text: str, group_rows: list[Any]) -> str:
    if not group_rows:
        return ""
    first = _row_to_dict(group_rows[0])
    row_input = first.get("row_input") or {}
    idxs = sorted({int(_row_to_dict(r).get("row_index", -1)) for r in group_rows})
    failed_idxs = sorted(
        {
            int(_row_to_dict(r).get("row_index", -1))
            for r in group_rows
            if not _row_to_dict(r).get("matched", False)
        }
    )
    min_idx = min(idxs)
    min_fail = min(failed_idxs) if failed_idxs else min_idx
    fail_list = ", ".join(str(i) for i in failed_idxs) if failed_idxs else "(none)"

    def _ground_truth_output_dict(d: dict[str, Any]) -> dict[str, Any]:
        gto = d.get("ground_truth_output")
        if isinstance(gto, dict):
            return dict(gto)
        return {}

    def _is_model_facing_output_key(key: str) -> bool:
        k = str(key or "").strip()
        if not k or k in ("#", "[#]"):
            return False
        if len(k) >= 2 and k.startswith("[") and k.endswith("]"):
            return False
        return True

    def _field_scoring_parts_for_row(d: dict[str, Any]) -> list[str]:
        comparison_types = d.get("comparison_types")
        parts = [str(x) for x in (comparison_types or []) if isinstance(x, str)]
        return [x for x in parts if _is_model_facing_output_key(x.split(":", 1)[0].strip())]

    ordered_rows = sorted(group_rows, key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    gt_entries: list[dict[str, Any]] = []
    scoring_ordered: list[str] = []
    scoring_seen: set[str] = set()
    outputs_in_order: list[dict[str, Any] | None] = []
    for r in ordered_rows:
        d = _row_to_dict(r)
        gt_only = bool(d.get("gt_only"))
        run_output = d.get("run_output") or {}
        for part in _field_scoring_parts_for_row(d):
            key = part.split(":", 1)[0].strip()
            if key in scoring_seen:
                continue
            scoring_seen.add(key)
            scoring_ordered.append(part)
        if gt_only:
            outputs_in_order.append(None)
        else:
            outputs_in_order.append(dict(run_output) if isinstance(run_output, dict) else {})
        gt_obj = {k: v for k, v in _ground_truth_output_dict(d).items() if _is_model_facing_output_key(k)}
        gt_entries.append(gt_obj)

    rules_body = "\n".join(f"- {p}" for p in scoring_ordered) if scoring_ordered else "(not specified)"
    outputs_json = json.dumps(outputs_in_order, ensure_ascii=False, indent=2)
    multi = len(group_rows) > 1
    mixed = len(failed_idxs) > 0 and len(failed_idxs) < len(group_rows)
    if multi:
        if mixed:
            scope = (
                "This is **one dataset input** with **multiple** expectations below. **Some PASSED and some FAILED** scoring. "
                "Use passing entries as context (what the model got right); focus the diagnosis on failures "
                "and prompt changes that preserve correct behavior while fixing them."
            )
        else:
            scope = (
                "This is **one dataset input** with **multiple** expectations (see **sections 3 and 4**). "
                "Diagnose **holistically** across indices (same array order)."
            )
    else:
        scope = "This is **one** model output for this input that failed scoring."
    gt_json = json.dumps(gt_entries, ensure_ascii=False, indent=2)
    idx_list = ", ".join(str(i) for i in idxs)

    return f"""You review model output(s) for **one** dataset input (same placeholders / message as below). Possibly multiple expectations were scored; some may have **passed** and some **failed**.

{scope}

## 1. Prompt template

Full instruction text the model was given (all sections, as in the app):

{prompt_text}

## 2. Input (substituted placeholders)

Keys are `{{placeholder}}` names from the template above; values are the strings substituted into the prompt for this run.

```json
{json.dumps(row_input, ensure_ascii=False, indent=2)}
```

## 3. Model output

JSON **array**: one element per expectation, **same length and index order** as **section 4 (Ground truth)**. Each element is the model `output` object for that expectation, or `null` if no run result was paired (missing extraction).

```json
{outputs_json}
```

## 4. Ground truth

JSON **array**: one object per expectation. Index `i` matches index `i` in **section 3 (Model output)**. **Keys** are the score-rule **output keys** — the same property names used when comparing model JSON to the GT sheet. Omitted here: row-index rules (`#`, `[#]`) and bracket worksheet selectors (`[…]`) that are not model-output fields.

```json
{gt_json}
```

## 5. Comparison rules (how each output key is scored against ground truth)

For each listed output field, the line describes the match type / options used when comparing **section 3** values to **section 4**.

{rules_body}

## Your task

0. **card_title**: A **short headline** (about 4–12 words) for a UI list card—plain English, summary-style, readable at a glance. It must **not** be snake_case or look like a code identifier. It is **not** a substitute for the full explanation below.
1. **issue_summary**: Briefly explain the mismatch(es) (one or two sentences, or a bit more if multiple outputs need tying together). If the failure is extractive, mention **missing** and/or **extra** relative to expected when relevant.
2. **rough_modification_opinion**: Rough modification advice for the **prompt** only—what to clarify, add, or constrain so coverage is exact (no missing required items, no spurious extras); do NOT paste a full new prompt.
3. **problem_category_hint**: a very short English snake_case or hyphen tag for grouping similar failures (internal use).

Respond with JSON matching the schema (**row_index** must be **{min_fail}** — anchor to a **failed** row; failed row_index set: {fail_list}; all comparison rows for this input in this prompt: {idx_list}).
"""


def _sections_block_for_phase2(sections: list[Any]) -> str:
    parts: list[str] = []
    for i, sec in enumerate(sections or []):
        name, content = _sec_name_content(sec)
        parts.append(f"--- Section index {i}: {name} ---\n{content}")
    return "\n\n".join(parts) if parts else "(no sections)"


def _build_phase2_modifications_prompt(*, prompt_text: str, opinions_text: str, sections: list[Any]) -> str:
    """Second LLM call: localized prompt edits only (no design clusters)."""
    sections_block = _sections_block_for_phase2(sections)
    return f"""## Phase 2 goal (read first)

**Fix what Phase 1 found, with as little change to the prompt as possible.**

**Hard rule:** Every `prompt_edit` you output **must** directly fix something **Phase 1 already identified** in **section 3** (issue_summary, rough_modification_opinion, category hint, or the same row’s diagnosis). **Do not** output an edit whose only justification is generic “better prompt” or “clarity”—if you cannot point to **which sentence of section 3** it answers, **omit** that edit.

- **Section 3** is the **sole** source of problems to fix. Do **not** redesign the prompt, add unrelated polish, or address failures Phase 1 did not mention.
- **Coverage:** Taken together, your edits **must** resolve **all** distinct failures Phase 1 calls out for the failed input group(s) in section 3, **unless** the prompt literally has no place to apply a fix (then output fewer edits and let `reason` state the gap—still no generic-only edits).
- Each `prompt_edit` is a **minimal** change: prefer one sentence / bullet / clause. More edits **only** when Phase 1 clearly names several separate fixes.
- **Smallest effective diff wins**; do **not** split one fix into many micro-edits.
- **Extraction / coverage:** tighten only as much as Phase 1 implies—no long new rubrics unless section 3 asks for that scope.

Output format: **only** `prompt_edits`. No clusters, no meta summaries, no full rewritten prompt.

## 1. Prompt template

Full instruction text the model was given (same as Phase 1; use together with **section 2** for locating spans to edit):

{prompt_text}

## 2. Prompt sections (by index)

Verbatim section bodies only. **`old_sentence` must be copied from here** — not from headers like `--- Section index 0: … ---`, and not from **section 1** if the wording differs.

{sections_block}

## 3. Phase 1 opinions (rough notes per failed input group)

Diagnosis and rough fix hints from the first review pass (use to decide what to change in **section 2**):

{opinions_text}

## Your task — **prompt_edits** (in-app diff + Accept/Revert)

Each edit in `prompt_edits` **must** include:

- **`phase1_addresses`**: **1 to 3 strings** (hard cap **3**). Each string should name a **Phase 1 finding** from **section 3** (short phrase or quote). **Special case:** if Phase 1 lists many bullets that are **the same underlying issue** (same failure mode / one thematic gap), **do not** split into extra edits just to mirror bullet count: **summarize** that cluster in **one to three** strings and fix it with **one** localized edit when one `old_sentence`→`new_sentence` truly addresses that whole class. Split into another `prompt_edit` only when Phase 1 implies **different** change strategies or **different** places in the prompt. **Do not** use vague entries like “improve clarity” unless Phase 1 said so.
- **`reason`**: 1–2 sentences on **how** the `old_sentence`→`new_sentence` change implements those fixes (implementation detail, not a repeat of the whole section 3).

Other rules:

1. **Count:** **Minimum** edits that still **fully** cover Phase 1’s problems in section 3. No padding.
2. **old_sentence:** **Character-for-character** from **section 2** (one contiguous substring).
3. **new_sentence:** Replaces `old_sentence`; **""** = deletion.
4. **section_index:** Section in **section 2** where `old_sentence` appears.
5. If `old_sentence` is **not** an exact substring of that body, **omit** that edit.
6. **row_indices** (optional): 0-based comparison row indices when it ties to a specific Phase 1 row note.

Respond with JSON: **`prompt_edits` only** (no other keys).
"""


def _sanitize_prompt_edits(sections: list[Any], edits: list[PromptEditSuggestion]) -> list[dict[str, Any]]:
    """Drop edits whose old_sentence is not an exact substring of the section (UI needs a real span)."""
    out: list[dict[str, Any]] = []
    n = len(sections or [])
    if n == 0:
        return out
    for e in edits:
        idx = int(e.section_index)
        idx = max(0, min(idx, n - 1))
        _, content = _sec_name_content(sections[idx])
        old = e.old_sentence or ""
        if not old.strip():
            continue
        if old not in content:
            continue
        new = e.new_sentence if e.new_sentence is not None else ""
        if not isinstance(new, str):
            new = str(new)
        ri: list[int] = []
        for x in e.row_indices or []:
            try:
                ri.append(int(x))
            except (TypeError, ValueError):
                continue
        p1: list[str] = []
        raw_p1 = getattr(e, "phase1_addresses", None)
        if isinstance(raw_p1, list):
            for x in raw_p1:
                s = str(x).strip()
                if s:
                    p1.append(s[:500])
                    if len(p1) >= 3:
                        break
        if not p1:
            continue
        out.append(
            {
                "name": (e.name or "Prompt edit").strip()[:200],
                "phase1_addresses": p1,
                "section_index": idx,
                "old_sentence": old,
                "new_sentence": new,
                "reason": (e.reason or "").strip(),
                "row_indices": ri,
            }
        )
        if len(out) >= _MAX_VALIDATED_PROMPT_EDITS:
            break
    return out


def _analyze_input_group(
    *,
    group_rows: list[Any],
    prompt_text: str,
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
) -> tuple[PerRowOpinion, list[int]]:
    prompt = _build_phase1_prompt_for_input_group(prompt_text=prompt_text, group_rows=group_rows)
    idxs_all = sorted({int(_row_to_dict(r).get("row_index", -1)) for r in group_rows})
    failed_idxs = sorted(
        {
            int(_row_to_dict(r).get("row_index", -1))
            for r in group_rows
            if not _row_to_dict(r).get("matched", False)
        }
    )
    print(
        "\n"
        + "=" * 80
        + "\nREVIEW PHASE 1 PROMPT"
        + f" (all row_index: {idxs_all}, failed: {failed_idxs}, {len(prompt)} chars)\n"
        + "=" * 80
        + "\n"
        + prompt
        + "\n"
        + "=" * 80
        + "\n",
        flush=True,
    )
    out, _ = llm_run_structured(
        provider=provider,
        model=model,
        api_key=api_key,
        prompt=prompt,
        response_model=PerRowOpinion,
        max_tokens=max_tokens,
    )
    if isinstance(out, dict):
        op = PerRowOpinion(**out)
    elif isinstance(out, PerRowOpinion):
        op = out
    else:
        op = PerRowOpinion(**(out.model_dump() if hasattr(out, "model_dump") else out.dict()))
    op.row_index = int(min(failed_idxs)) if failed_idxs else int(min(idxs_all))
    return op, idxs_all


def run_review_pipeline(
    *,
    provider: str,
    model: str,
    api_key: str,
    body: Any,
    max_tokens: int,
    max_failed_rows: int,
    concurrency: int,
    is_cancelled: Callable[[], bool],
    append_event: Callable[[dict], None],
) -> None:
    """
    Drive review. Emits: plan, diagnosis_row, suggestions, done.
    Caller handles credential errors and job status.
    """
    sections = list(getattr(body, "prompt_sections", None) or [])
    prompt_text = format_prompt_for_review(sections)
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])

    all_matched_flag = getattr(body, "all_rows_matched", None)
    if all_matched_flag is True:
        append_event({"type": "plan", "summary": "All rows matched — nothing to review.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    unmatched = [r for r in comparison_rows if not _row_to_dict(r).get("matched", False)]
    if not unmatched:
        append_event({"type": "plan", "summary": "No unmatched rows.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    to_analyze = unmatched[: max(1, min(200, int(max_failed_rows)))]
    failed_input_keys = {_input_identity_key(_row_to_dict(r)) for r in to_analyze}
    all_groups = _group_comparison_rows_by_input(comparison_rows)
    groups = [g for g in all_groups if _input_identity_key(_row_to_dict(g[0])) in failed_input_keys]
    n = len(groups)
    row_count = len(to_analyze)
    append_event(
        {
            "type": "plan",
            "summary": (
                f"Phase 1: analyzing {n} input group(s) with failures ({row_count} failed comparison row(s)); "
                "each prompt includes every comparison row for that input (matched + unmatched). "
                "Then prompt edit suggestions."
            ),
            "diagnosis_total": n,
        }
    )

    if is_cancelled():
        return

    opinions: list[tuple[PerRowOpinion, list[int]]] = []
    conc = max(1, min(4, int(concurrency)))

    def one_group(g: list[Any]) -> tuple[PerRowOpinion, list[int]]:
        return _analyze_input_group(
            group_rows=g,
            prompt_text=prompt_text,
            provider=provider,
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
        )

    done_n = 0
    if conc <= 1:
        for g in groups:
            if is_cancelled():
                return
            op, ridxs = one_group(g)
            opinions.append((op, ridxs))
            done_n += 1
            append_event(
                {
                    "type": "diagnosis_row",
                    "row_index": op.row_index,
                    "row_indices": ridxs,
                    "done": done_n,
                    "total": n,
                    "opinion": {
                        "card_title": op.card_title or "",
                        "issue_summary": op.issue_summary,
                        "rough_modification_opinion": op.rough_modification_opinion,
                        "problem_category_hint": op.problem_category_hint or "",
                    },
                }
            )
    else:
        with ThreadPoolExecutor(max_workers=conc) as ex:
            futures = {ex.submit(one_group, g): g for g in groups}
            for fut in as_completed(futures):
                if is_cancelled():
                    try:
                        ex.shutdown(wait=False, cancel_futures=True)
                    except TypeError:
                        ex.shutdown(wait=False)
                    return
                op, ridxs = fut.result()
                opinions.append((op, ridxs))
                done_n += 1
                append_event(
                    {
                        "type": "diagnosis_row",
                        "row_index": op.row_index,
                        "row_indices": ridxs,
                        "done": done_n,
                        "total": n,
                        "opinion": {
                            "card_title": op.card_title or "",
                            "issue_summary": op.issue_summary,
                            "rough_modification_opinion": op.rough_modification_opinion,
                            "problem_category_hint": op.problem_category_hint or "",
                        },
                    }
                )

    opinions.sort(key=lambda t: t[0].row_index)

    if is_cancelled():
        return

    # Compact text for phase 2 (cap each opinion length to limit tokens)
    lines: list[str] = []
    for op, ridxs in opinions:
        rough = op.rough_modification_opinion.strip()
        if len(rough) > 1200:
            rough = rough[:1197] + "..."
        head = (op.card_title or "").strip() or op.issue_summary
        rows_lbl = ", ".join(str(i) for i in ridxs) if len(ridxs) > 1 else str(op.row_index)
        lines.append(
            f"- Comparison row(s) {rows_lbl}: [{op.problem_category_hint or 'uncategorized'}] {head}\n"
            f"  Detail: {op.issue_summary}\n  Rough fix: {rough}"
        )
    opinions_text = "\n".join(lines)

    mod_prompt = _build_phase2_modifications_prompt(
        prompt_text=prompt_text,
        opinions_text=opinions_text,
        sections=sections,
    )
    logger.info("Review phase 2 (modifications) prompt length: %s chars", len(mod_prompt))
    print(
        "\n"
        + "=" * 80
        + "\nREVIEW PHASE 2 PROMPT"
        + f" ({len(mod_prompt)} chars)\n"
        + "=" * 80
        + "\n"
        + mod_prompt
        + "\n"
        + "=" * 80
        + "\n",
        flush=True,
    )
    out_mod, _ = llm_run_structured(
        provider=provider,
        model=model,
        api_key=api_key,
        prompt=mod_prompt,
        response_model=Phase2Modifications,
        max_tokens=max_tokens,
    )
    if isinstance(out_mod, dict):
        mod = Phase2Modifications(**out_mod)
    elif isinstance(out_mod, Phase2Modifications):
        mod = out_mod
    else:
        mod = Phase2Modifications(**(out_mod.model_dump() if hasattr(out_mod, "model_dump") else out_mod.dict()))

    if is_cancelled():
        return

    edit_dicts = _sanitize_prompt_edits(sections, list(mod.prompt_edits or []))
    if edit_dicts:
        append_event({"type": "suggestions", "suggestions": edit_dicts})

    append_event({"type": "done"})
