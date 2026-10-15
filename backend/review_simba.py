"""
SIMBA review method — a thin wrapper around DSPy's official `dspy.SIMBA` optimizer
(https://dspy.ai; already installed, same `dspy` package as review_miprov2.py/review_copro.py/
review_bootstrap_fewshot.py). Same "wrap the official code" approach and reuses their shared DSPy-bridging
layer (review_dspy_shared.py) — no new dependency, no new integration pattern.

SIMBA ("Stochastic Introspective Mini-Batch Ascent") jointly evolves instructions AND few-shot demos like
MIPROv2, but through a different mechanism: `dspy.SIMBA.compile` (installed package) repeatedly samples a
mini-batch (`bsize`), runs several stochastic rollouts of the current program on it (`num_candidates`),
has the model introspect on which rollouts succeeded/failed and why, and proposes a new candidate program
(instruction rewrite or a new demo) from that introspection — no external Bayesian-optimization library,
the "search" is the LLM's own analysis of its mini-batch performance. Its `metric` is called as plain
`metric(example, prediction)` (confirmed by reading dspy/teleprompt/simba_utils.py in the installed
package) — the exact same two-positional-argument shape review_dspy_shared.make_metric already produces,
so no adapter was needed here (unlike what might be assumed from the constructor's type hint, which is
looser than the actual call site).

Same prompt-to-Signature mapping as review_miprov2.py: the prompt text becomes the instructions and its
`{placeholder}` keys become dspy.InputFields. See that module's docstring for why.

Cost note: `simba_max_steps` (its own setting, default 8) is the primary cost dial. `bsize` (mini-batch
size) is clamped to this method's own example count rather than SIMBA's own default of 32, since this
app's review datasets are frequently smaller than that and SIMBA has no built-in handling for a batch
size larger than the trainset. Cost is roughly `max_steps x bsize x num_candidates` task-model calls, plus
introspection calls per step.
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
    make_mean_score_fn,
    make_metric,
    PromptModule,
)
from review_gepa import _build_training_examples
from review_pipeline import PromptEditSuggestion, _sanitize_prompt_edits
from score_mapping_bundle import parse_score_mapping_bundle
from score_run_gt_pairing import flatten_score_rules
from safe_stdio import safe_print as _print

_DEFAULT_MAX_STEPS = 8


def run_simba(
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
    """Drive SIMBA. Emits: plan, stage(prepare|compile|select), suggestions (at most one), done."""
    prompt = str(getattr(body, "prompt", "") or "")
    seed_text = prompt.strip()
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])

    if not seed_text:
        append_event({"type": "plan", "summary": "The prompt is empty; nothing to optimize.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    output_schema = getattr(body, "output_schema", None) or {}
    if not output_schema.get("fields"):
        append_event({
            "type": "error",
            "detail": "SIMBA needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # Same as the other DSPy-based methods: a fixed (example, its own GT) pair.
    output_leaves = flatten_score_rules(output_root)
    if not output_leaves:
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — SIMBA has no way to tell a correct answer from an incorrect one.",
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
    # SIMBA has no handling for a mini-batch bigger than the trainset — cap it, don't inherit dspy's
    # own default of 32 (this app's review datasets are frequently smaller than that).
    if len(examples) < 2:
        append_event({
            "type": "plan",
            "summary": "SIMBA needs at least 2 dataset inputs to form a mini-batch; only 1 is available.",
            "diagnosis_total": 0,
        })
        append_event({"type": "done"})
        return

    st = settings or {}
    try:
        max_steps = int(st.get("simba_max_steps") or _DEFAULT_MAX_STEPS)
    except (TypeError, ValueError):
        max_steps = _DEFAULT_MAX_STEPS
    max_steps = max(2, min(40, max_steps))
    bsize = max(2, min(32, len(examples)))

    input_keys = extract_placeholder_keys(seed_text)
    output_field_keys = [str(f.get("key") or "").strip() for f in output_schema["fields"] if f.get("key")]

    append_event({
        "type": "plan",
        "summary": (
            f"SIMBA: jointly evolving the prompt's instructions and few-shot demos "
            f"({len(input_keys)} placeholder field(s)) against {len(examples)} "
            f"example(s) via the official dspy.SIMBA, max_steps={max_steps} bsize={bsize}. Cost scales "
            "with max_steps x bsize x candidates."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "prepare", "kind": "start", "payload": {"num_examples": len(examples), "input_fields": input_keys}})

    gt_column_by_field = build_gt_column_by_field(output_leaves)
    dspy_examples = build_dspy_examples(examples=examples, input_keys=input_keys, output_field_keys=output_field_keys, gt_column_by_field=gt_column_by_field)
    metric = make_metric(output_root=output_root, output_leaves=output_leaves, output_field_keys=output_field_keys)

    signature = build_signature(instructions=seed_text, input_keys=input_keys, output_schema=output_schema, signature_name="SimbaPrompt")
    student = PromptModule(signature)
    lm = build_dspy_lm(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    mean_score = make_mean_score_fn(dspy_examples=dspy_examples, input_keys=input_keys, metric=metric, lm=lm, is_cancelled=is_cancelled, log_prefix="SIMBA")

    append_event({"type": "stage", "stage_id": "prepare", "kind": "done", "payload": {}})
    if is_cancelled():
        return

    try:
        seed_score = mean_score(student)
    except RuntimeError:
        return
    _print(f"\n{'=' * 80}\nSIMBA seed — mean_score={seed_score:.3f}\n{'=' * 80}\n")

    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "compile", "kind": "start", "payload": {"max_steps": max_steps, "bsize": bsize, "baseline_score": seed_score}})
    try:
        with dspy.context(lm=lm):
            optimizer = dspy.SIMBA(metric=metric, bsize=bsize, max_steps=max_steps, num_threads=1)
            optimized = optimizer.compile(student, trainset=dspy_examples)
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[SIMBA] dspy.SIMBA.compile failed: {e}")
        append_event({"type": "error", "detail": f"SIMBA optimization failed: {e}"})
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
    _print(f"\n{'=' * 80}\nSIMBA done — seed={seed_score:.3f} best={best_score:.3f}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    if best_score <= seed_score or best_text.strip() == seed_text.strip():
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name="SIMBA: evolved prompt",
        phase1_addresses=["SIMBA jointly optimized the prompt's instructions and few-shot demos"],
        old_sentence=seed_text,
        new_sentence=best_text,
        reason=f"Empirically improved from {seed_score:.0%} to {best_score:.0%} on {len(examples)} example(s).",
        target_score_row_indices=target_labels,
    )
    batch = _sanitize_prompt_edits(prompt, [edit], comparison_rows)
    if not batch:
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "dropped": "old_sentence did not resolve uniquely"}})
        append_event({"type": "done"})
        return
    d = batch[0]
    d["issue_cluster_index"] = 0
    d["issue_cluster_label"] = "simba"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
