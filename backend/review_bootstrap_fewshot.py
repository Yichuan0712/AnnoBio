"""
BootstrapFewShotWithRandomSearch review method — a thin wrapper around DSPy's official
`dspy.BootstrapFewShotWithRandomSearch` teleprompter (pip install dspy; already a dependency via
review_gepa.py/review_miprov2.py). Same "wrap the official code" approach as those two methods, and
reuses their shared DSPy-bridging layer (review_dspy_shared.py) rather than re-deriving it.

Unlike GEPA (evolves the section's whole text) and MIPROv2 (jointly optimizes instructions AND
few-shot demos via Bayesian search), this optimizer does NOT touch the section's instructions at all —
it only searches over which few-shot examples to attach, and how many. Concretely (see
dspy.BootstrapFewShotWithRandomSearch.compile in the installed package): it tries a zero-shot baseline, a
labels-only baseline, an unshuffled bootstrap, then `bootstrap_fewshot_num_candidates` random subsets of
bootstrapped demonstrations (via the simpler `dspy.BootstrapFewShot` internally, which runs the *student*
program itself as its own teacher and keeps traces where `metric` succeeds), evaluates every candidate on
the same example set, and keeps whichever scored best. It is the simplest of the three DSPy-backed
methods here — no LLM-driven instruction/demo proposal, purely bootstrap + random sampling + evaluation —
so it's also the cheapest per candidate (no reflection/proposal calls, only task-model calls).

Same architecture scope as review_miprov2.py: optimizes the target section IN ISOLATION (its own
`{placeholder}` keys become dspy.InputFields; other sections aren't shown to the optimizer). See that
module's docstring for why.

Cost note: `bootstrap_fewshot_num_candidates` (its own setting, default 10) is the primary cost dial —
each candidate bootstraps and evaluates against the full example set, so cost is roughly
`(num_candidates + 3) x num_examples` task calls (the +3 is the zero-shot/labels-only/unshuffled
baselines `compile()` always tries first).

v1 scope, same simplifications as review_miprov2.py:
- No train/val split (`valset=None` -> dspy reuses trainset, matching this method's own default).
- Only the first GT row per input is used when an input has multiple.
- Coarse progress: `compile()` is one blocking call with no per-candidate callback hook exposed to us,
  so this method reports three stages (prepare / compile / select), not a live per-candidate stream.
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
    format_demos_block,
    make_metric,
    make_mean_score_fn,
    SectionModule,
)
from review_gepa import _build_training_examples
from review_pipeline import PromptEditSuggestion, _sanitize_prompt_edits, _sec_name_content
from score_mapping_bundle import parse_score_mapping_bundle
from score_run_gt_pairing import flatten_score_rules
from safe_stdio import safe_print as _print

_DEFAULT_NUM_CANDIDATES = 10


def run_bootstrap_fewshot(
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
    """Drive BootstrapFewShotWithRandomSearch. Emits: plan, stage(prepare|compile|select), suggestions
    (at most one), done."""
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
            "detail": "BootstrapFewShotWithRandomSearch needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # Same as GEPA/MIPROv2: a fixed (example, its own GT) pair, no pairing search needed.
    output_leaves = flatten_score_rules(output_root)
    if not output_leaves:
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — this method has no way to tell a correct answer from an incorrect one.",
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
        num_candidates = int(st.get("bootstrap_fewshot_num_candidates") or _DEFAULT_NUM_CANDIDATES)
    except (TypeError, ValueError):
        num_candidates = _DEFAULT_NUM_CANDIDATES
    num_candidates = max(2, min(100, num_candidates))

    input_keys = extract_placeholder_keys(seed_text)
    output_field_keys = [str(f.get("key") or "").strip() for f in output_schema["fields"] if f.get("key")]

    append_event({
        "type": "plan",
        "summary": (
            f"BootstrapFewShotWithRandomSearch: selecting few-shot examples for section \"{section_name}\" "
            f"in isolation ({len(input_keys)} placeholder field(s) it sees) against {len(examples)} "
            f"example(s) via the official dspy.BootstrapFewShotWithRandomSearch, trying "
            f"{num_candidates + 3} candidate demo sets. Instructions are not changed by this method — "
            "only which examples get attached."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "prepare", "kind": "start", "payload": {"num_examples": len(examples), "input_fields": input_keys}})

    gt_column_by_field = build_gt_column_by_field(output_leaves)
    dspy_examples = build_dspy_examples(examples=examples, input_keys=input_keys, output_field_keys=output_field_keys, gt_column_by_field=gt_column_by_field)
    metric = make_metric(output_root=output_root, output_leaves=output_leaves, output_field_keys=output_field_keys)

    signature = build_signature(instructions=seed_text, input_keys=input_keys, output_schema=output_schema, signature_name="BootstrapFewShotSection")
    student = SectionModule(signature)
    lm = build_dspy_lm(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    mean_score = make_mean_score_fn(dspy_examples=dspy_examples, input_keys=input_keys, metric=metric, lm=lm, is_cancelled=is_cancelled, log_prefix="BootstrapFewShot")

    append_event({"type": "stage", "stage_id": "prepare", "kind": "done", "payload": {}})
    if is_cancelled():
        return

    try:
        seed_score = mean_score(student)
    except RuntimeError:
        return
    _print(f"\n{'=' * 80}\nBootstrapFewShotWithRandomSearch seed — mean_score={seed_score:.3f}\n{'=' * 80}\n")

    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "compile", "kind": "start", "payload": {"num_candidates": num_candidates, "baseline_score": seed_score}})
    try:
        with dspy.context(lm=lm):
            optimizer = dspy.BootstrapFewShotWithRandomSearch(
                metric=metric,
                max_bootstrapped_demos=4,
                max_labeled_demos=16,
                num_candidate_programs=num_candidates,
                num_threads=1,
                stop_at_score=1.0,
            )
            optimized = optimizer.compile(student, trainset=dspy_examples, valset=None)
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[BootstrapFewShot] dspy.BootstrapFewShotWithRandomSearch.compile failed: {e}")
        append_event({"type": "error", "detail": f"BootstrapFewShotWithRandomSearch optimization failed: {e}"})
        return

    if is_cancelled():
        return
    append_event({"type": "stage", "stage_id": "compile", "kind": "done", "payload": {}})

    try:
        best_score = mean_score(optimized)
    except RuntimeError:
        return

    demos_block = format_demos_block(list(getattr(optimized.predict, "demos", None) or []), input_keys, output_field_keys)
    best_text = seed_text + demos_block
    _print(f"\n{'=' * 80}\nBootstrapFewShotWithRandomSearch done — seed={seed_score:.3f} best={best_score:.3f}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    if best_score <= seed_score or best_text.strip() == seed_text.strip():
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name=f"BootstrapFewShot: examples for \"{section_name}\"",
        phase1_addresses=["BootstrapFewShotWithRandomSearch selected few-shot examples for this section"],
        old_sentence=seed_text,
        new_sentence=best_text,
        reason=f"Empirically improved from {seed_score:.0%} to {best_score:.0%} on {len(examples)} example(s) by attaching selected examples.",
        target_score_row_indices=target_labels,
    )
    batch = _sanitize_prompt_edits(sections, [edit], comparison_rows)
    if not batch:
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "dropped": "old_sentence did not resolve uniquely"}})
        append_event({"type": "done"})
        return
    d = batch[0]
    d["issue_cluster_index"] = 0
    d["issue_cluster_label"] = "bootstrap_fewshot"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
