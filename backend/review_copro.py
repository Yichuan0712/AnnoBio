"""
COPRO review method — a thin wrapper around DSPy's official `dspy.COPRO` optimizer
(https://dspy.ai/api/optimizers/COPRO/; already installed, same `dspy` package as review_miprov2.py /
review_bootstrap_fewshot.py). Same "wrap the official code" approach and reuses their shared DSPy-bridging
layer (review_dspy_shared.py) — no new dependency, no new integration pattern.

COPRO ("Coordinate-ascent Prompt Optimization") only touches instructions, never few-shot demos — the
complement of review_bootstrap_fewshot.py, which only touches demos and never instructions. Concretely
(dspy.COPRO.compile in the installed package): for `depth` rounds, it asks an LM to propose `breadth`
instruction variants (one call with n=breadth-1 completions, plus the current instruction itself as
candidate #breadth), evaluates every candidate against the full example set, and carries the best-scoring
one into the next round as the new seed to vary from. No demos are bootstrapped or selected — cheaper per
round than MIPROv2, but also gives up MIPROv2's joint instructions+demos optimization.

Same architecture scope as review_miprov2.py: optimizes the target section IN ISOLATION (its own
`{placeholder}` keys become dspy.InputFields; other sections aren't shown to the optimizer). See that
module's docstring for why.

Cost note: `copro_breadth` and `copro_depth` (their own settings, defaults 6 and 3) are the cost dials —
cost is roughly `breadth x depth x num_examples` task-model evaluation calls, plus `depth` instruction-
proposal calls (each proposing `breadth` variants in one call via n-sampling, not `breadth` separate calls).
"""

from __future__ import annotations

from typing import Any, Callable

import dspy

from review_dspy_shared import (
    build_dspy_examples,
    build_dspy_lm,
    build_gt_column_by_field,
    build_signature,
    extract_placeholder_keys,
    make_mean_score_fn,
    make_metric,
    SectionModule,
)
from review_gepa import _build_training_examples
from review_pipeline import PromptEditSuggestion, _sanitize_prompt_edits, _sec_name_content
from score_mapping_bundle import parse_score_mapping_bundle
from score_run_gt_pairing import flatten_score_rules
from safe_stdio import safe_print as _print

_DEFAULT_BREADTH = 6
_DEFAULT_DEPTH = 3


def run_copro(
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
    settings: dict | None = None,
) -> None:
    """Drive COPRO. Emits: plan, stage(prepare|compile|select), suggestions (at most one), done."""
    sections = list(getattr(body, "prompt_sections", None) or [])
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])

    if not sections:
        append_event({"type": "plan", "summary": "No prompt sections to optimize.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    target_idx = getattr(body, "target_section_index", None)
    target_idx = target_idx if isinstance(target_idx, int) and 0 <= target_idx < len(sections) else 0
    section_name, seed_text = _sec_name_content(sections[target_idx])

    output_schema = getattr(body, "output_schema", None) or {}
    if not output_schema.get("fields"):
        append_event({
            "type": "error",
            "detail": "COPRO needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # Same as the other DSPy-based methods: a fixed (example, its own GT) pair.
    output_leaves = flatten_score_rules(output_root)
    if not output_leaves:
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — COPRO has no way to tell a correct answer from an incorrect one.",
            "diagnosis_total": 0,
        })
        append_event({"type": "done"})
        return

    max_examples = max(1, min(200, int(max_failed_inputs)))
    examples = _build_training_examples(comparison_rows, max_examples)
    if not examples:
        append_event({"type": "plan", "summary": "No dataset inputs to optimize against.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    st = settings or {}
    try:
        breadth = int(st.get("copro_breadth") or _DEFAULT_BREADTH)
    except (TypeError, ValueError):
        breadth = _DEFAULT_BREADTH
    breadth = max(2, min(30, breadth))
    try:
        depth = int(st.get("copro_depth") or _DEFAULT_DEPTH)
    except (TypeError, ValueError):
        depth = _DEFAULT_DEPTH
    depth = max(1, min(10, depth))

    input_keys = extract_placeholder_keys(seed_text)
    output_field_keys = [str(f.get("key") or "").strip() for f in output_schema["fields"] if f.get("key")]

    append_event({
        "type": "plan",
        "summary": (
            f"COPRO: optimizing instructions for section \"{section_name}\" in isolation "
            f"({len(input_keys)} placeholder field(s) it sees) against {len(examples)} example(s) via the "
            f"official dspy.COPRO, breadth={breadth} depth={depth}. Instructions only — few-shot examples "
            "are not touched by this method. Cost scales with breadth x depth x examples."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "prepare", "kind": "start", "payload": {"num_examples": len(examples), "input_fields": input_keys}})

    gt_column_by_field = build_gt_column_by_field(output_leaves)
    dspy_examples = build_dspy_examples(examples=examples, input_keys=input_keys, output_field_keys=output_field_keys, gt_column_by_field=gt_column_by_field)
    metric = make_metric(output_root=output_root, output_leaves=output_leaves, output_field_keys=output_field_keys)

    signature = build_signature(instructions=seed_text, input_keys=input_keys, output_schema=output_schema, signature_name="CoproSection")
    student = SectionModule(signature)
    lm = build_dspy_lm(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    mean_score = make_mean_score_fn(dspy_examples=dspy_examples, input_keys=input_keys, metric=metric, lm=lm, is_cancelled=is_cancelled, log_prefix="COPRO")

    append_event({"type": "stage", "stage_id": "prepare", "kind": "done", "payload": {}})
    if is_cancelled():
        return

    try:
        seed_score = mean_score(student)
    except RuntimeError:
        return
    _print(f"\n{'=' * 80}\nCOPRO seed — mean_score={seed_score:.3f}\n{'=' * 80}\n")

    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "compile", "kind": "start", "payload": {"breadth": breadth, "depth": depth, "baseline_score": seed_score}})
    try:
        with dspy.context(lm=lm):
            optimizer = dspy.COPRO(metric=metric, breadth=breadth, depth=depth, track_stats=False)
            optimized = optimizer.compile(
                student,
                trainset=dspy_examples,
                eval_kwargs={"num_threads": 1, "display_progress": False, "display_table": False},
            )
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[COPRO] dspy.COPRO.compile failed: {e}")
        append_event({"type": "error", "detail": f"COPRO optimization failed: {e}"})
        return

    if is_cancelled():
        return
    append_event({"type": "stage", "stage_id": "compile", "kind": "done", "payload": {}})

    try:
        best_score = mean_score(optimized)
    except RuntimeError:
        return

    best_text = optimized.predict.signature.instructions or seed_text
    _print(f"\n{'=' * 80}\nCOPRO done — seed={seed_score:.3f} best={best_score:.3f}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    if best_score <= seed_score or best_text.strip() == seed_text.strip():
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name=f"COPRO: evolved \"{section_name}\"",
        phase1_addresses=["COPRO optimized this section's instructions via coordinate ascent"],
        old_sentence=seed_text,
        new_sentence=best_text,
        reason=f"Empirically improved from {seed_score:.0%} to {best_score:.0%} on {len(examples)} example(s).",
        target_score_row_indices=target_labels,
    )
    batch = _sanitize_prompt_edits(sections, [edit], comparison_rows)
    if not batch:
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "dropped": "old_sentence did not resolve uniquely"}})
        append_event({"type": "done"})
        return
    d = batch[0]
    d["issue_cluster_index"] = 0
    d["issue_cluster_label"] = "copro"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
