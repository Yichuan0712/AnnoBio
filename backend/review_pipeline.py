"""
Review analyze pipeline, separate from FastAPI main module.

Phase 1 — per failed row: full prompt + row I/O; LLM returns rough per-row opinion.

Phase 2 — one LLM call (after phase 1): **Modifications** → localized **prompt_edits** only (Accept/Revert in UI).
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from pydantic import BaseModel, Field

from llm import run_structured as llm_run_structured

logger = logging.getLogger(__name__)


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


class PerRowOpinion(BaseModel):
    """Structured output for phase 1 (single failed row)."""

    row_index: int = Field(..., description="Same row_index as in the request (0-based run/comparison index)")
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
        description="Short tag for grouping, e.g. format_mismatch, missing_field, ambiguity, threshold",
    )


class PromptEditSuggestion(BaseModel):
    """One localized prompt change; old_sentence must exist verbatim in the section (UI highlights red/green)."""

    name: str = Field(..., description="Short title for this edit")
    section_index: int = Field(0, ge=0, description="0-based index of the section to edit")
    old_sentence: str = Field(
        ...,
        description="Exact contiguous substring copied character-for-character from that section's body",
    )
    new_sentence: str = Field(
        default="",
        description="Replacement; empty string for pure deletion",
    )
    reason: str = Field(..., description="Why this change addresses the failures")
    row_indices: list[int] = Field(
        default_factory=list,
        description="Optional 0-based row indices this edit is meant to help",
    )


class Phase2Modifications(BaseModel):
    """Structured output for the modifications-only LLM call (localized prompt_edits)."""

    prompt_edits: list[PromptEditSuggestion] = Field(
        default_factory=list,
        description="0–12 concrete edits; each old_sentence must appear exactly once in the given section",
    )


def _build_phase1_prompt(*, prompt_text: str, row: Any) -> str:
    d = _row_to_dict(row)
    row_input = d.get("row_input") or {}
    run_output = d.get("run_output") or {}
    expected = d.get("expected") or ""
    comparison_types = d.get("comparison_types")
    ct_line = ", ".join(comparison_types) if comparison_types else "(not specified)"

    return f"""You review one failed model run against a fixed prompt and ground truth.

## Full prompt (all sections — this is what the model was instructed with)

{prompt_text}

## Input for this row (dataset / placeholders used to build the user message)

```json
{json.dumps(row_input, ensure_ascii=False, indent=2)}
```

## Model output (incorrect — this did not satisfy scoring)

```json
{json.dumps(run_output, ensure_ascii=False, indent=2)}
```

## Expected / ground truth (what scoring compared against)

{expected!s}

## How scoring compared fields

{ct_line}

## Your task

0. **card_title**: A **short headline** (about 4–12 words) for a UI list card—plain English, summary-style, readable at a glance. It must **not** be snake_case or look like a code identifier. It is **not** a substitute for the full explanation below.
1. **issue_summary**: Briefly explain the mismatch (one or two sentences).
2. **rough_modification_opinion**: Rough modification advice for the **prompt** only—what to clarify, add, or constrain; do NOT paste a full new prompt.
3. **problem_category_hint**: a very short English snake_case or hyphen tag for grouping similar failures (internal use).

Respond with JSON matching the schema (row_index must be {d.get("row_index", -1)}).
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
    return f"""You have per-row expert notes from failed runs. Propose **localized prompt edits** only—no high-level design buckets.

## Full prompt (overview)

{prompt_text}

## Sections by index — **copy old_sentence ONLY from these bodies** (not from headers like "Section index 0")

{sections_block}

## Per-row rough opinions

{opinions_text}

## Task — **prompt_edits** (in-app diff + Accept/Revert)

1. Output **0 to 12** items. Each is **one localized change**.
2. **old_sentence** = **character-for-character** copy from one section body above (one contiguous substring; usually one sentence or line).
3. **new_sentence** replaces it; **""** = pure deletion.
4. **section_index** matches the section containing old_sentence.
5. If no exact substring exists, **omit** that edit.
6. **reason** + optional **row_indices** (0-based).

Do **not** output clusters or design-style summaries—only **prompt_edits**.

Respond with JSON: **prompt_edits** only.
"""


def _sanitize_prompt_edits(sections: list[Any], edits: list[PromptEditSuggestion]) -> list[dict[str, Any]]:
    """Drop edits whose old_sentence is not an exact substring of the section (UI needs a real span)."""
    out: list[dict[str, Any]] = []
    n = len(sections or [])
    if n == 0:
        return out
    for e in edits[:16]:
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
        out.append(
            {
                "name": (e.name or "Prompt edit").strip()[:200],
                "section_index": idx,
                "old_sentence": old,
                "new_sentence": new,
                "reason": (e.reason or "").strip(),
                "row_indices": ri,
            }
        )
        if len(out) >= 12:
            break
    return out


def _analyze_one_row(
    *,
    row: Any,
    prompt_text: str,
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
) -> PerRowOpinion:
    prompt = _build_phase1_prompt(prompt_text=prompt_text, row=row)
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
    d = _row_to_dict(row)
    expected_idx = d.get("row_index", op.row_index)
    op.row_index = int(expected_idx)
    return op


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
    n = len(to_analyze)
    append_event(
        {
            "type": "plan",
            "summary": f"Phase 1: analyzing {n} failed row(s); then prompt edit suggestions.",
            "diagnosis_total": n,
        }
    )

    if is_cancelled():
        return

    opinions: list[PerRowOpinion] = []
    conc = max(1, min(4, int(concurrency)))

    def one(r: Any) -> PerRowOpinion:
        return _analyze_one_row(
            row=r,
            prompt_text=prompt_text,
            provider=provider,
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
        )

    done_n = 0
    if conc <= 1:
        for r in to_analyze:
            if is_cancelled():
                return
            op = one(r)
            opinions.append(op)
            done_n += 1
            append_event(
                {
                    "type": "diagnosis_row",
                    "row_index": op.row_index,
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
            futures = {ex.submit(one, r): r for r in to_analyze}
            for fut in as_completed(futures):
                if is_cancelled():
                    try:
                        ex.shutdown(wait=False, cancel_futures=True)
                    except TypeError:
                        ex.shutdown(wait=False)
                    return
                op = fut.result()
                opinions.append(op)
                done_n += 1
                append_event(
                    {
                        "type": "diagnosis_row",
                        "row_index": op.row_index,
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

    opinions.sort(key=lambda x: x.row_index)

    if is_cancelled():
        return

    # Compact text for phase 2 (cap each opinion length to limit tokens)
    lines: list[str] = []
    for op in opinions:
        rough = op.rough_modification_opinion.strip()
        if len(rough) > 1200:
            rough = rough[:1197] + "..."
        head = (op.card_title or "").strip() or op.issue_summary
        lines.append(
            f"- Row {op.row_index}: [{op.problem_category_hint or 'uncategorized'}] {head}\n  Detail: {op.issue_summary}\n  Rough fix: {rough}"
        )
    opinions_text = "\n".join(lines)

    mod_prompt = _build_phase2_modifications_prompt(
        prompt_text=prompt_text,
        opinions_text=opinions_text,
        sections=sections,
    )
    logger.info("Review phase 2 (modifications) prompt length: %s chars", len(mod_prompt))
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
