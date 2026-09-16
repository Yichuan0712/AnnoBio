"""
MIPROv2 review method — a thin wrapper around DSPy's official `dspy.MIPROv2` optimizer
(pip install dspy; https://dspy.ai/api/optimizers/MIPROv2/). Jointly optimizes ONE prompt section's
instructions and its few-shot demonstrations via DSPy's own bootstrap -> instruction-proposal ->
Bayesian-optimization pipeline (`dspy.MIPROv2.compile`) — not a reimplementation, same "wrap the
official code" approach as review_gepa.py. The Pareto/reflective-mutation code in review_gepa.py was
likewise replaced by the real `gepa` package; nothing here duplicates that decision, it follows it.

Architecture note — why this method sees less of the prompt than GEPA (decided in the design
conversation this was built from, not an oversight):
DSPy's Signature model is "instructions (optimizable) + structured input/output fields" — it has no
notion of this app's inline `{placeholder}` template substitution scattered across N prompt sections.
GEPA's adapter interface let us keep our own template substitution and just hand GEPA compiled prompt
text; MIPROv2 requires an actual `dspy.Predict(signature)` so DSPy's own ChatAdapter can render the
prompt and bootstrap demos, and there's no clean way to fold "the other sections' content" into that
without either (a) including it in `instructions`, where MIPROv2 could then rewrite it too (breaking
"only touch the target section"), or (b) giving up DSPy's real prompt rendering. Chosen approach: this
method optimizes the target section IN ISOLATION — the `{placeholder}` keys found in ITS OWN raw text
become `dspy.InputField`s (their per-example values come from `row_input` directly, not string
substitution), the section's raw text becomes the Signature's `instructions` (placeholders are left
inline, unresolved — DSPy still renders the actual value via the separate labeled input field, so the
model gets the real value even though the literal `{key}` token is also visible in the instructions),
and other prompt sections are not shown to MIPROv2 during optimization at all. The DSPy-bridging
machinery (Signature/Example/metric/LM construction) lives in review_dspy_shared.py, shared with
review_bootstrap_fewshot.py — both wrap a real dspy teleprompter the same way.

Cost note: `num_trials` (its own setting, `miprov2_num_trials`, default 10) is MIPROv2's primary cost
dial — each trial evaluates one (instruction, demo-set) combination against the example set, so cost is
roughly `num_trials x num_examples` task calls, plus the smaller bootstrap and instruction-proposal calls
DSPy makes internally. Separate from `gepa_max_iterations` and `optimization_max_trials` for the same
reason those two are separate from each other: different methods, different per-trial costs.

v1 scope, same spirit as review_gepa.py's — deliberately simplified rather than half-built:
- Optimizes exactly one prompt section (`body.target_section_index`, default 0); other sections excluded
  from what MIPROv2 sees (see architecture note above).
- No train/val split: every targeted comparison-row input is used both for bootstrapping/proposing and
  for scoring (`valset=None`, mirroring gepa's own default and this app's existing precedent).
- Multiple ground-truth rows for one input: only the first GT row per input is used (same limit as GEPA).
- Progress reporting is coarser than GEPA's: `dspy.MIPROv2.compile()` is one blocking call with no
  official per-trial callback hook (unlike gepa's rich GEPACallback), so this method reports three
  stages (prepare / compile / select) rather than a live per-iteration stream.
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

_DEFAULT_NUM_TRIALS = 10


def run_miprov2(
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
    """Drive the MIPROv2 method via dspy.MIPROv2. Emits: plan, stage(prepare|compile|select), suggestions
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
            "detail": "MIPROv2 needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # Same as GEPA: a fixed (example, its own GT) pair, no run<->GT pairing search needed.
    output_leaves = flatten_score_rules(output_root)
    if not output_leaves:
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — MIPROv2 has no way to tell a correct answer from an incorrect one.",
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
        num_trials = int(st.get("miprov2_num_trials") or _DEFAULT_NUM_TRIALS)
    except (TypeError, ValueError):
        num_trials = _DEFAULT_NUM_TRIALS
    num_trials = max(4, min(200, num_trials))

    input_keys = extract_placeholder_keys(seed_text)
    output_field_keys = [str(f.get("key") or "").strip() for f in output_schema["fields"] if f.get("key")]

    append_event({
        "type": "plan",
        "summary": (
            f"MIPROv2: optimizing section \"{section_name}\" in isolation "
            f"({len(input_keys)} placeholder field(s) it sees) against {len(examples)} example(s) via the "
            f"official dspy.MIPROv2, up to {num_trials} trial(s). Runs the task model for real per trial — "
            "cost scales with trials x examples."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "prepare", "kind": "start", "payload": {"num_examples": len(examples), "input_fields": input_keys}})

    gt_column_by_field = build_gt_column_by_field(output_leaves)
    dspy_examples = build_dspy_examples(examples=examples, input_keys=input_keys, output_field_keys=output_field_keys, gt_column_by_field=gt_column_by_field)
    metric = make_metric(output_root=output_root, output_leaves=output_leaves, output_field_keys=output_field_keys)

    signature = build_signature(instructions=seed_text, input_keys=input_keys, output_schema=output_schema, signature_name="MiproSection")
    student = SectionModule(signature)
    lm = build_dspy_lm(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    mean_score = make_mean_score_fn(dspy_examples=dspy_examples, input_keys=input_keys, metric=metric, lm=lm, is_cancelled=is_cancelled, log_prefix="MIPROv2")

    append_event({"type": "stage", "stage_id": "prepare", "kind": "done", "payload": {}})
    if is_cancelled():
        return

    try:
        seed_score = mean_score(student)
    except RuntimeError:
        return
    _print(f"\n{'=' * 80}\nMIPROv2 seed — mean_score={seed_score:.3f}\n{'=' * 80}\n")

    if is_cancelled():
        return

    # auto=None means num_candidates must be supplied explicitly (dspy raises otherwise); keep it well
    # under num_trials so the Bayesian search has room to actually compare candidates across trials
    # rather than exhausting the candidate pool on trial 1.
    num_candidates = max(2, min(10, num_trials // 2))
    append_event({"type": "stage", "stage_id": "compile", "kind": "start", "payload": {"num_trials": num_trials, "num_candidates": num_candidates, "baseline_score": seed_score}})
    try:
        with dspy.context(lm=lm):
            optimizer = dspy.MIPROv2(metric=metric, auto=None, num_candidates=num_candidates, num_threads=1, verbose=False, track_stats=False)
            optimized = optimizer.compile(
                student,
                trainset=dspy_examples,
                valset=None,
                num_trials=num_trials,
                minibatch=False,
                # Keep fewshot_aware_proposer (the demos MIPROv2 bootstraps are its core value over a
                # plain instruction-only optimizer); skip the other proposer inputs — each is an extra LM
                # call (dataset summary, "program code" description that means little for a single
                # isolated section, style "tips") that mainly adds variety, not correctness, and this
                # method already runs enough real LLM calls without them.
                program_aware_proposer=False,
                data_aware_proposer=False,
                tip_aware_proposer=False,
            )
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[MIPROv2] dspy.MIPROv2.compile failed: {e}")
        append_event({"type": "error", "detail": f"MIPROv2 optimization failed: {e}"})
        return

    if is_cancelled():
        return
    append_event({"type": "stage", "stage_id": "compile", "kind": "done", "payload": {}})

    try:
        best_score = mean_score(optimized)
    except RuntimeError:
        return

    new_instructions = optimized.predict.signature.instructions or seed_text
    demos_block = format_demos_block(list(getattr(optimized.predict, "demos", None) or []), input_keys, output_field_keys)
    best_text = new_instructions + demos_block
    _print(f"\n{'=' * 80}\nMIPROv2 done — seed={seed_score:.3f} best={best_score:.3f}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    if best_score <= seed_score or best_text.strip() == seed_text.strip():
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name=f"MIPROv2: evolved \"{section_name}\"",
        phase1_addresses=["MIPROv2 jointly optimized this section's instructions and few-shot demos"],
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
    d["issue_cluster_label"] = "miprov2"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
