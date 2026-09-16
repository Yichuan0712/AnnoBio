"""
GEPA (reflective evolution) review method — a thin wrapper around the official `gepa` package
(pip install gepa; https://github.com/gepa-ai/gepa, the standalone package behind "GEPA: Reflective
Prompt Evolution Can Outperform Reinforcement Learning", Agrawal et al., 2025, arXiv:2507.19457).

This is NOT a reimplementation of GEPA's algorithm — the Pareto-frontier candidate pool, the reflective
mutation loop, the instruction-proposal prompt and its parsing all come from the `gepa` package itself
(`gepa.optimize`). What we own is the integration layer required by GEPAAdapter's contract:
  - `_AppGepaAdapter.evaluate()`  — compile the candidate section into the full prompt, call the task LLM
    for real against this app's dataset rows, score the output with this app's own matching engine
    (score_match_primitives.py / score_run_gt_pairing.py — the JS-ported one, not a stand-in).
  - `_AppGepaAdapter.make_reflective_dataset()` — turn a batch's outputs/errors/scores into the small
    JSON-serializable per-example records `gepa`'s own instruction proposer consumes; we don't write the
    reflection prompt ourselves, `gepa` does (gepa.strategies.instruction_proposal).
  - `_AppReflectionLM` — bridges gepa's `LanguageModel` protocol (a plain `str -> str` callable) to this
    app's credential system (llm.chat), so gepa's internal reflection calls use the same provider/model/
    api_key the rest of this review job uses instead of a separately-configured litellm model string.
  - `_AppGepaCallback` — translates gepa's own progress callbacks into this app's `stage` event stream
    (backend/review_methods.py's contract), so the frontend gets live progress the same way every other
    review method reports it.

Cost note: unlike the other review methods, this one calls the task LLM for real, every iteration, against
every targeted input — cost is roughly `iterations x num_examples` task calls plus `iterations` reflection
calls. `iterations` maps to `gepa_max_iterations` (its own setting, default 15) via `max_metric_calls =
gepa_max_iterations * num_examples`, since gepa's own budget unit is "metric calls" (one evaluate() call
on one example), not "iterations" — separate from the Thompson-sampling compositional optimizer's
`optimization_max_trials`, whose trials only touch one suggestion's target rows.

v1 scope, deliberately simplified rather than half-built:
- Optimizes exactly one prompt section (`body.target_section_index`, default 0) — not the whole prompt.
- No train/val split: every targeted comparison-row input is used both for reflection and for scoring
  (gepa's own default when `valset` is omitted — it reuses the trainset).
- Multiple ground-truth rows for one input are common upstream (extraction tasks), but this method only
  compares against the first GT row per input — full N:M matching is what compute_greedy_run_to_gt_pairing
  is for, and doesn't fit "one fixed output vs one fixed expectation per example" scoring.
- Task execution is sequential (no run_concurrency), and text-only (an input resolving to an image cell is
  reported as a per-example error, not silently mishandled — see prompt_template.py).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

import gepa
from gepa.core.adapter import EvaluationBatch

from llm import chat as llm_chat
from llm import run_structured as llm_run_structured
from prompt_template import compile_input_text
from review_pipeline import (
    PromptEditSuggestion,
    _group_comparison_rows_by_input,
    _row_to_dict,
    _sanitize_prompt_edits,
    _score_row_one_based,
    _sec_name_content,
)
from run_output_schema import build_output_model, build_table_output_model, run_structured_output_is_empty
from score_mapping_bundle import parse_score_mapping_bundle
from score_match_primitives import (
    build_embedding_cosine_map_via_local_model,
    get_match_flags,
    embedding_pair_matches,
    migrate_legacy_match_type,
    numeric_pair_matches,
    normalize_for_match,
    strings_match_contains,
    strings_match_semantic_align,
    SCORE_GT_ROW_INDEX_COLUMN,
)
from score_run_gt_pairing import evaluate_score_tree, flatten_score_rules
from safe_stdio import safe_print as _print

_SECTION_KEY = "section"
_DEFAULT_MAX_ITERATIONS = 15
_MAX_FAILING_RECORDS_IN_REFLECTIVE_DATASET = 12
_CLIP_CHARS = 800


def _clip(s: str, n: int = _CLIP_CHARS) -> str:
    t = (s or "").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


@dataclass
class _GepaExample:
    row_input: dict[str, Any]
    ground_truth_output: dict[str, Any]
    score_labels: list[int]  # 1-based Score # labels of every comparison row this example represents


def _build_training_examples(comparison_rows: list[Any], max_examples: int) -> list[_GepaExample]:
    all_groups = _group_comparison_rows_by_input(comparison_rows)
    # Failing inputs first (fixing them is the point), then passing ones fill any remaining budget (so GEPA
    # can tell when a candidate breaks something that already worked) — a plain `groups[:max_examples]`
    # truncation would silently drop failing inputs entirely on a dataset where they're not the first ones.
    failing = [g for g in all_groups if any(not _row_to_dict(r).get("matched", False) for r in g)]
    failing_ids = {id(g) for g in failing}
    passing = [g for g in all_groups if id(g) not in failing_ids]
    groups = (failing + passing)[: max(1, max_examples)]
    examples: list[_GepaExample] = []
    for g in groups:
        rows = sorted(g, key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
        if not rows:
            continue
        first = _row_to_dict(rows[0])
        gto = first.get("ground_truth_output")
        examples.append(
            _GepaExample(
                row_input=dict(first.get("row_input") or {}),
                ground_truth_output=dict(gto) if isinstance(gto, dict) else {},
                score_labels=sorted({_score_row_one_based(_row_to_dict(r)) for r in rows}),
            )
        )
    return examples


def _resolve_output_key_value(output_key: str, output: dict | None, row_input: dict[str, Any]) -> str:
    key = (output_key or "").strip()
    if key in ("#", "[#]"):
        return ""  # No stable row-index concept for a freshly generated candidate output; not scorable.
    if key.startswith("[") and key.endswith("]"):
        header = key[1:-1].strip()
        v = row_input.get(header)
        return "" if v is None else str(v)
    if isinstance(output, dict) and key in output:
        v = output[key]
        return "" if v is None else str(v)
    return ""


def _resolve_gt_value(column: str, example: _GepaExample) -> str:
    if (column or "").strip() == SCORE_GT_ROW_INDEX_COLUMN:
        return str(example.score_labels[0]) if example.score_labels else ""
    v = example.ground_truth_output.get(column)
    return "" if v is None else str(v)


def _make_rule_matches_row(batch: list[_GepaExample], outputs: list[dict | None], embedding_cosine_map: dict[str, float]):
    def rule_matches_row(rule: dict, i: int, _j: int, *_args) -> bool:
        example = batch[i]
        output = outputs[i]
        run_val_raw = _resolve_output_key_value(str(rule.get("outputKey") or ""), output, example.row_input)
        gt_vals_raw = [_resolve_gt_value(col, example) for col in (rule.get("gtColumns") or [])]
        match_type = migrate_legacy_match_type(rule.get("matchType"))
        flags = get_match_flags(rule)

        if match_type == "numeric":
            run_norm = normalize_for_match(run_val_raw, flags, True)
            return any(numeric_pair_matches(run_norm, normalize_for_match(g, flags, True), flags) for g in gt_vals_raw)
        if match_type == "exact" and flags.get("embeddingSimilarity"):
            return any(embedding_pair_matches(run_val_raw, g, embedding_cosine_map) for g in gt_vals_raw)
        if match_type == "exact" and flags.get("semanticAlign"):
            return any(strings_match_semantic_align(run_val_raw, g) for g in gt_vals_raw)
        run_val = normalize_for_match(run_val_raw, flags, False)
        for g in gt_vals_raw:
            gt_val = normalize_for_match(g, flags, False)
            if match_type == "exact" and flags.get("contains"):
                if strings_match_contains(run_val, gt_val):
                    return True
            elif run_val == gt_val:
                return True
        return False

    return rule_matches_row


def _run_task_prompt(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt_text: str,
    output_schema: dict,
    max_tokens: int,
    max_retries: int = 0,
) -> tuple[dict | None, str | None]:
    """Single task-model call, same schema handling as the Run job worker (main.py _do_run_work), plus the
    same retry-with-backoff behavior — a transient API hiccup shouldn't count as "this candidate is wrong"
    when scoring it against real data."""
    fields = output_schema.get("fields") or []
    return_shape = "table" if (output_schema.get("return_shape") or "single") == "table" else "single"
    row_model = build_output_model(fields)
    response_model = build_table_output_model(row_model) if return_shape == "table" else row_model
    output_field_keys = [{"key": f.get("key")} for f in fields if f.get("key")]

    last_err: str | None = None
    for attempt in range(max(0, max_retries) + 1):
        try:
            out, _used_fallback, _debug = llm_run_structured(
                provider=provider,
                model=model,
                api_key=api_key,
                base_url=base_url,
                prompt=prompt_text,
                response_model=response_model,
                max_tokens=max_tokens,
                return_shape=return_shape,
                return_debug=True,
            )
        except Exception as e:
            last_err = str(e)
            if attempt < max_retries:
                time.sleep(min(2**attempt, 8))
                continue
            return None, last_err

        if return_shape == "table" and isinstance(out, dict) and "rows" in out:
            out = out["rows"]
        if run_structured_output_is_empty(out, return_shape, output_field_keys):
            last_err = "Empty model output"
            if attempt < max_retries:
                time.sleep(min(2**attempt, 8))
                continue
            return None, last_err
        if return_shape == "table":
            first_row = out[0] if isinstance(out, list) and out else None
            return (first_row if isinstance(first_row, dict) else None), None
        return (out if isinstance(out, dict) else None), None
    return None, last_err


class _AppReflectionLM:
    """Bridges gepa's `LanguageModel` protocol (`__call__(prompt: str | list[dict]) -> str`) to this app's
    own credential system, so gepa's internal reflection calls (writing the new candidate section text)
    use the same provider/model/api_key as the rest of this review job."""

    def __init__(self, *, provider: str, model: str, api_key: str, base_url: str, max_tokens: int):
        self.provider = provider
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.max_tokens = max_tokens

    def __call__(self, prompt: str | list[dict[str, Any]]) -> str:
        messages = [{"role": "user", "content": prompt}] if isinstance(prompt, str) else prompt
        return llm_chat(
            provider=self.provider,
            model=self.model,
            api_key=self.api_key,
            base_url=self.base_url,
            messages=messages,
            max_tokens=self.max_tokens,
        )


class _AppGepaAdapter:
    """GEPAAdapter for this app: one component (`_SECTION_KEY`) mapping to the targeted prompt section's
    text. `evaluate()` compiles that text into the full prompt, runs the task model for real against each
    `_GepaExample`, and scores with this app's own matching engine — see the module docstring."""

    # GEPAAdapter is a Protocol with `propose_new_texts: ProposalFn | None = None` as a *class-level*
    # default; the engine reads `adapter.propose_new_texts` unconditionally (`is not None` check) to decide
    # whether to use a custom proposer or its own default one. A Protocol's default isn't inherited by an
    # unrelated class that merely structurally matches it, so omitting this raises AttributeError instead
    # of quietly falling back — declare it explicitly to opt into gepa's own default instruction proposer.
    propose_new_texts = None

    def __init__(
        self,
        *,
        section_index: int,
        sections: list[Any],
        output_root: dict,
        provider: str,
        model: str,
        api_key: str,
        base_url: str,
        output_schema: dict,
        max_tokens: int,
        max_retries: int,
        is_cancelled: Callable[[], bool],
    ):
        self.section_index = section_index
        self.sections = sections
        self.output_root = output_root
        self.provider = provider
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self.output_schema = output_schema
        self.max_tokens = max_tokens
        self.max_retries = max_retries
        self.is_cancelled = is_cancelled

    def _compile_template(self, candidate: dict[str, str]) -> str:
        section_texts = [(_sec_name_content(s)[1] or "") for s in self.sections]
        section_texts[self.section_index] = candidate[_SECTION_KEY]
        return "\n\n".join(t.strip() for t in section_texts if t.strip())

    def evaluate(self, batch: list[_GepaExample], candidate: dict[str, str], capture_traces: bool = False) -> EvaluationBatch:
        template = self._compile_template(candidate)
        outputs: list[dict | None] = []
        errors: list[str | None] = []
        for ex in batch:
            if self.is_cancelled():
                raise RuntimeError("Review cancelled")
            prompt_text, compile_err = compile_input_text(template, ex.row_input)
            if compile_err:
                outputs.append(None)
                errors.append(compile_err)
                continue
            out, err = _run_task_prompt(
                provider=self.provider, model=self.model, api_key=self.api_key, base_url=self.base_url,
                prompt_text=prompt_text, output_schema=self.output_schema, max_tokens=self.max_tokens,
                max_retries=self.max_retries,
            )
            outputs.append(out)
            errors.append(err)

        output_leaves = flatten_score_rules(self.output_root)
        embedding_cosine_map: dict[str, float] = {}
        if any(get_match_flags(r).get("embeddingSimilarity") for r in output_leaves):
            pairs: list[tuple[str, str]] = []
            for i, ex in enumerate(batch):
                for rule in output_leaves:
                    if not get_match_flags(rule).get("embeddingSimilarity"):
                        continue
                    run_val = _resolve_output_key_value(str(rule.get("outputKey") or ""), outputs[i], ex.row_input)
                    for col in rule.get("gtColumns") or []:
                        pairs.append((run_val, _resolve_gt_value(col, ex)))
            embedding_cosine_map = build_embedding_cosine_map_via_local_model(pairs)

        rule_matches_row = _make_rule_matches_row(batch, outputs, embedding_cosine_map)
        scores: list[float] = []
        for i in range(len(batch)):
            if errors[i] is not None:
                scores.append(0.0)
                continue
            ok = evaluate_score_tree(self.output_root, i, i, {}, {}, [], {}, rule_matches_row)
            scores.append(1.0 if ok else 0.0)

        trajectories = None
        if capture_traces:
            trajectories = [
                {"row_input": ex.row_input, "output": out, "error": err, "ground_truth": ex.ground_truth_output, "score": score}
                for ex, out, err, score in zip(batch, outputs, errors, scores)
            ]
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    def make_reflective_dataset(self, candidate, eval_batch: EvaluationBatch, components_to_update: list[str]):
        records = []
        for traj in eval_batch.trajectories or []:
            if traj["score"] >= 1.0:
                continue
            generated = traj["error"] or traj["output"] or "(no output)"
            feedback = f"Expected: {_clip(str(traj['ground_truth']))}"
            if traj["error"]:
                feedback += f" — the model call itself failed: {traj['error']}"
            records.append({
                "Inputs": {k: _clip(str(v), 300) for k, v in (traj["row_input"] or {}).items()},
                "Generated Outputs": _clip(str(generated)),
                "Feedback": feedback,
            })
            if len(records) >= _MAX_FAILING_RECORDS_IN_REFLECTIVE_DATASET:
                break
        if not records:
            records = [{
                "Inputs": "(every example in this batch already passed)",
                "Generated Outputs": "",
                "Feedback": "Try an alternate phrasing that stays correct but may generalize better.",
            }]
        return {_SECTION_KEY: records}


class _AppGepaCallback:
    """Translates gepa's own progress callbacks into this app's `stage` event stream (review_methods.py's
    contract) so the frontend gets live progress the same way every other review method reports it."""

    def __init__(self, append_event: Callable[[dict], None], max_iterations: int):
        self.append_event = append_event
        self.max_iterations = max_iterations

    def on_optimization_start(self, event: dict) -> None:
        self.append_event({"type": "stage", "stage_id": "seed", "kind": "start", "payload": {"num_examples": event.get("trainset_size")}})

    def on_evaluation_end(self, event: dict) -> None:
        if not event.get("is_seed_candidate"):
            return
        scores = event.get("scores") or []
        baseline = sum(scores) / len(scores) if scores else 0.0
        self.append_event({"type": "stage", "stage_id": "seed", "kind": "done", "payload": {"baseline_score": baseline}})
        self.append_event({"type": "stage", "stage_id": "evolve", "kind": "start", "payload": {"max_iterations": self.max_iterations}})

    def on_iteration_end(self, event: dict) -> None:
        state = event.get("state")
        best_score = None
        try:
            scores = state.program_full_scores_val_set
            if scores:
                best_score = max(scores)
        except AttributeError:
            pass
        self.append_event({"type": "stage", "stage_id": "evolve", "kind": "iteration", "payload": {
            "iteration": event.get("iteration"),
            "max_iterations": self.max_iterations,
            "proposal_accepted": event.get("proposal_accepted"),
            "best_score": best_score,
        }})

    def on_error(self, event: dict) -> None:
        self.append_event({"type": "stage", "stage_id": "evolve", "kind": "iteration", "payload": {
            "iteration": event.get("iteration"),
            "max_iterations": self.max_iterations,
            "error": str(event.get("exception")),
        }})


def run_gepa(
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
    """Drive the GEPA method via gepa.optimize(). Emits: plan, stage(seed|evolve|select), suggestions
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
            "detail": "GEPA needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # GEPA compares a fixed (example, its own GT) pair; no run<->GT pairing search needed.
    if not flatten_score_rules(output_root):
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — GEPA has no way to tell a correct answer from an incorrect one.",
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
        max_iterations = int(st.get("gepa_max_iterations") or _DEFAULT_MAX_ITERATIONS)
    except (TypeError, ValueError):
        max_iterations = _DEFAULT_MAX_ITERATIONS
    max_iterations = max(4, min(200, max_iterations))
    try:
        task_max_retries = min(5, max(0, int(st.get("run_max_retries", 0))))
    except (TypeError, ValueError):
        task_max_retries = 0

    append_event({
        "type": "plan",
        "summary": (
            f"GEPA: evolving section \"{section_name}\" against {len(examples)} example(s) via the official "
            f"gepa package, up to {max_iterations} reflective iteration(s). Runs the task model for real "
            "every iteration — cost scales with iterations x examples."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    adapter = _AppGepaAdapter(
        section_index=target_idx, sections=sections, output_root=output_root,
        provider=provider, model=model, api_key=api_key, base_url=base_url,
        output_schema=output_schema, max_tokens=max_tokens, max_retries=task_max_retries,
        is_cancelled=is_cancelled,
    )
    reflection_lm = _AppReflectionLM(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    callback = _AppGepaCallback(append_event, max_iterations)

    def gepa_stopper(_state: Any) -> bool:
        return is_cancelled()

    try:
        result = gepa.optimize(
            seed_candidate={_SECTION_KEY: seed_text},
            trainset=examples,
            valset=None,  # gepa reuses trainset when omitted — matches this app's "no train/val split" choice
            adapter=adapter,
            reflection_lm=reflection_lm,
            candidate_selection_strategy="pareto",
            reflection_minibatch_size=len(examples),  # always reflect on the full set, not a random subsample
            max_metric_calls=max_iterations * len(examples),
            skip_perfect_score=True,
            perfect_score=1.0,
            callbacks=[callback],
            stop_callbacks=[gepa_stopper],
            display_progress_bar=False,
            raise_on_exception=True,
        )
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[GEPA] gepa.optimize failed: {e}")
        append_event({"type": "error", "detail": f"GEPA optimization failed: {e}"})
        return

    if is_cancelled():
        return

    seed_score = result.val_aggregate_scores[0] if result.val_aggregate_scores else 0.0
    best_idx = result.best_idx
    best_score = result.val_aggregate_scores[best_idx] if result.val_aggregate_scores else 0.0
    best_text = result.candidates[best_idx].get(_SECTION_KEY, seed_text)
    _print(f"\n{'=' * 80}\nGEPA done — seed={seed_score:.3f} best={best_score:.3f} candidates={result.num_candidates}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "evolve", "kind": "done", "payload": {"pool_size": result.num_candidates}})
    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})

    if best_score <= seed_score or best_text == seed_text:
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name=f"GEPA: evolved \"{section_name}\"",
        phase1_addresses=[f"GEPA evolved this section over {result.num_candidates - 1} candidate(s)"],
        old_sentence=seed_text,
        new_sentence=best_text,
        reason=f"Empirically improved from {seed_score:.0%} to {best_score:.0%} on {len(examples)} example(s).",
        target_score_row_indices=target_labels,
    )
    # _sanitize_prompt_edits resolves old_sentence to a verbatim, unique span (needed for Accept/Revert)
    # and converts target_score_row_indices from 1-based Score # labels to 0-based comparison row_index —
    # same as every other method's suggestions, so downstream (verify/accept/revert) sees a consistent shape.
    batch = _sanitize_prompt_edits(sections, [edit], comparison_rows)
    if not batch:
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "dropped": "old_sentence did not resolve uniquely"}})
        append_event({"type": "done"})
        return
    d = batch[0]
    d["issue_cluster_index"] = 0
    d["issue_cluster_label"] = "gepa"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
