"""
Direct rewrite: a lighter-weight alternative to the default Phase 1/1.5/2 pipeline
(``review_pipeline.run_review_pipeline``).

Where the default method diagnoses every failing input individually (Phase 1), clusters
related diagnoses (Phase 1.5), then writes one edit per cluster (Phase 2), this method
skips the per-input diagnosis and clustering steps entirely: one LLM call reads every
failing input at once and proposes prompt edits directly. Two stages instead of three,
and a single LLM call instead of one-per-input-group plus one-per-cluster.

Serves as the reference template for adding another review method: same call signature
as ``run_review_pipeline``, its own ``stage`` events for whatever steps it needs, and it
converges on the same ``suggestions`` / ``done`` events every method must emit. Register
new methods in ``review_methods.py`` — no other file needs to change.
"""

from __future__ import annotations

from typing import Any, Callable

from pydantic import BaseModel, Field

from llm import run_structured as llm_run_structured
from review_pipeline import (
    PromptEditLlm,
    PromptEditSuggestion,
    _MAX_VALIDATED_PROMPT_EDITS,
    _format_prompt_for_review,
    _group_comparison_rows_by_input,
    _phase1_group_context_parts,
    _phase1_input_one_based_from_group,
    _row_to_dict,
    _sanitize_prompt_edits,
    _score_row_one_based,
)
from safe_stdio import safe_print as _print


class DirectRewriteEdits(BaseModel):
    """Structured output from the single direct-rewrite LLM call."""

    prompt_edits: list[PromptEditLlm] = Field(
        default_factory=list,
        description="Localized old->new prompt edits that fix the failing inputs shown. Merge edits that share a root cause.",
    )


def _build_direct_rewrite_prompt(*, prompt_text: str, groups: list[list[Any]]) -> str:
    blocks: list[str] = []
    for g in groups:
        input_num = _phase1_input_one_based_from_group(g)
        scope, subs = _phase1_group_context_parts(g)
        blocks.append(f"### Failing input #{input_num}\n\n{scope}\n\n{subs}")
    failures_block = "\n\n---\n\n".join(blocks) if blocks else "(no failing inputs)"

    return f"""Produce minimal **localized** edits to the stored prompt so it handles every failing input below correctly. Output only `prompt_edits`.

The **stored prompt** block and the **failing inputs** block are separate — read in order; do not treat them as columns or side-by-side panels.

Rules:
- `old_sentence` must be copied verbatim from **one** place in the stored prompt below. Prefer a span that appears **only once** in the full prompt so the server can resolve it unambiguously.
- Merge edits that fix multiple failing inputs for the same underlying reason into **one** edit rather than repeating near-duplicate edits.
- Do not paste failing-input markdown into `old_sentence`.
- Edits must improve **task prompt** extraction: fuller where the model under-delivers vs expected, stricter where it over-generates vs expected.
- **`name` and `reason`**: end-user plain English only; never Python/Pydantic/class names or other internal identifiers.

## Stored prompt (sole source for `old_sentence`)

{prompt_text}

## Failing inputs (never use as `old_sentence`)

{failures_block}

## `prompt_edits` fields

- **name**: Short UI label.
- **phase1_addresses**: 1-3 short strings naming which failing input(s) or failure type this edit fixes.
- **old_sentence**: Contiguous substring from the stored prompt (see rules above).
- **new_sentence**: Replacement, or `""` to delete.
- **reason**: How this fixes the cited failures.

Invalid spans are dropped server-side.

Return **`prompt_edits`** only.
"""


def run_direct_rewrite(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    body: Any,
    max_tokens: int,
    max_failed_inputs: int,
    is_cancelled: Callable[[], bool],
    append_event: Callable[[dict], None],
) -> None:
    """Drive the direct-rewrite method. Emits: plan, stage(gather|rewrite), suggestions, done."""
    sections = list(getattr(body, "prompt_sections", None) or [])
    prompt_text = _format_prompt_for_review(sections)
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])

    if getattr(body, "all_rows_matched", None) is True:
        append_event({"type": "plan", "summary": "All rows matched — nothing to review.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    unmatched = [r for r in comparison_rows if not _row_to_dict(r).get("matched", False)]
    if not unmatched:
        append_event({"type": "plan", "summary": "No unmatched rows.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    max_in = max(1, min(200, int(max_failed_inputs)))
    all_groups = _group_comparison_rows_by_input(comparison_rows)
    failed_groups = [
        g for g in all_groups if any(not _row_to_dict(r).get("matched", False) for r in g)
    ][:max_in]

    append_event(
        {
            "type": "plan",
            "summary": (
                f"Direct rewrite: one LLM call reads {len(failed_groups)} failing input(s) "
                "and proposes edits directly (no per-input diagnosis, no clustering)."
            ),
            "diagnosis_total": 0,
        }
    )
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "gather", "kind": "start", "payload": {"failed_inputs": len(failed_groups)}})
    prompt = _build_direct_rewrite_prompt(prompt_text=prompt_text, groups=failed_groups)
    _print(f"\n{'=' * 80}\nDIRECT REWRITE PROMPT ({len(failed_groups)} failing input(s), {len(prompt)} chars)\n{'=' * 80}\n{prompt}\n{'=' * 80}\n")
    append_event({"type": "stage", "stage_id": "gather", "kind": "done", "payload": {"prompt_chars": len(prompt)}})

    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "rewrite", "kind": "start", "payload": {}})
    out, used_fallback, debug = llm_run_structured(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        prompt=prompt,
        response_model=DirectRewriteEdits,
        max_tokens=max_tokens,
        return_debug=True,
    )
    if isinstance(out, dict):
        parsed = DirectRewriteEdits(**out)
    elif isinstance(out, DirectRewriteEdits):
        parsed = out
    else:
        parsed = DirectRewriteEdits(**(out.model_dump() if hasattr(out, "model_dump") else out.dict()))

    target_labels = sorted({_score_row_one_based(_row_to_dict(r)) for r in unmatched})
    target_labels = [x for x in target_labels if x >= 1] or [1]

    raw_edits = list(parsed.prompt_edits or [])
    edits = [
        PromptEditSuggestion(**e.model_dump(), target_score_row_indices=list(target_labels))
        for e in raw_edits
    ]
    _print(
        f"\n{'=' * 80}\nDIRECT REWRITE RESULT — llm_transport={debug.get('path') if isinstance(debug, dict) else None} "
        f"used_fallback={used_fallback} edits={len(edits)}\n{'=' * 80}\n"
    )
    append_event({"type": "stage", "stage_id": "rewrite", "kind": "done", "payload": {"edit_count": len(edits)}})

    if is_cancelled():
        return

    batch = _sanitize_prompt_edits(sections, edits, comparison_rows)
    for d in batch[:_MAX_VALIDATED_PROMPT_EDITS]:
        d["issue_cluster_index"] = 0
        d["issue_cluster_label"] = "direct rewrite"
        append_event({"type": "suggestions", "suggestions": [d]})

    append_event({"type": "done"})
