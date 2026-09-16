"""
TextGrad review method — a thin wrapper around the official `textgrad` package
(https://github.com/zou-group/textgrad, "TextGrad: Automatic 'Differentiation' via Text", Nature 2025).
Same "wrap the official code" approach as review_gepa.py/review_miprov2.py/review_bootstrap_fewshot.py.

Dependency note: textgrad's PyPI package declares `datasets`/`pyarrow`/`gdown`/`pandas`/`pillow` as hard
requirements — used by its own benchmark-dataset example scripts (`textgrad.tasks`, never imported here),
not by the core optimization API this module actually uses. Installing it normally pulls in ~100MB of
unrelated transitive dependencies (`pyarrow` alone is ~90MB). Confirmed by testing `pip install --no-deps
textgrad` plus only `platformdirs` (needed at top-level import) and `diskcache` (already a dependency via
gepa): `import textgrad` and everything this module uses works fine. requirements.txt installs it this way
— do not "fix" this by switching to a normal `pip install textgrad`, that's the heavy path, not a bug.

Engine note: textgrad's built-in provider engines (ChatOpenAI, ChatAnthropic, the `experimental:` LiteLLM
engine, ...) all read credentials from process-global environment variables (OPENAI_API_KEY etc.) with no
per-instance override — unsafe for concurrent review jobs using different credentials in different
threads. `_AppTextGradEngine` below implements textgrad's minimal `EngineLM.generate`/`__call__` contract
itself, calling this app's own `llm.chat()` with this job's own credential — same pattern as
review_gepa.py's `_AppReflectionLM`.

Algorithm: this is real textual gradient descent, not a reimplementation. `Variable.backward()` (an LLM
call that computes natural-language feedback attributing blame back through the computation graph) and
`TextualGradientDescent.step()` (an LLM call that rewrites the parameter given the accumulated feedback)
are both `textgrad`'s own code (`textgrad.autograd`, `textgrad.optimizer`). What we own: the loss function
— `textgrad.autograd.StringBasedFunction` wraps a plain Python callable as the "gradient" source, and that
callable is this app's own matching engine (score_match_primitives.py / score_run_gt_pairing.py), not an
LLM's subjective judgment — matching the choice already made for GEPA/MIPROv2/BootstrapFewShot's metrics.

Architecture note — same "in isolation" scope as review_miprov2.py/review_bootstrap_fewshot.py, chosen for
consistency across every method built on that decision, not because TextGrad's API forces it (unlike
DSPy's rigid Signature model, a bare `Variable` is just a string, so this method *could* see the whole
assembled prompt like GEPA does): the target section's raw text becomes the optimized `Variable`, its own
`{placeholder}` keys are rendered as a plain "key: value" block in the (non-optimized) question `Variable`
per example, and other prompt sections are not shown to TextGrad during optimization.

Cost note: `textgrad_num_steps` (its own setting, default 6) is the cost dial. TextGrad is more expensive
per round than the DSPy-based methods — each step does a forward pass, a real LLM-driven backward pass,
and an optimizer LLM call, so cost is roughly `num_steps x num_examples x ~3` calls.

v1 scope, same simplifications as the other three methods: no train/val split, only the first GT row per
input when there are several, text-only (`prompt_template.py` reports an image placeholder as a per-
example error). Progress reporting is closer to GEPA's than to MIPROv2/BootstrapFewShot's: one `iteration`
stage event per step, because — unlike those two methods' single opaque `compile()` call — this method's
loop is this app's own code driving textgrad's primitives one step at a time, so it always knows exactly
where it is. TGD is a heuristic, not a guaranteed-improving procedure (no built-in acceptance test, unlike
GEPA's Pareto frontier or MIPROv2/BootstrapFewShot's explicit best-of-N comparison) — every step's prompt
is scored (for free, from the same forward passes used to build that step's loss) and the best one seen
across all steps, including the seed, is what gets suggested — not just whichever the last step produced.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import textgrad as tg
from textgrad.autograd import StringBasedFunction
from textgrad.engine.base import EngineLM

from llm import _extract_json_from_text
from llm import chat as llm_chat
from review_dspy_shared import build_gt_column_by_field, extract_placeholder_keys
from review_gepa import _build_training_examples, _make_rule_matches_row, _resolve_gt_value
from review_pipeline import PromptEditSuggestion, _sanitize_prompt_edits, _sec_name_content
from score_mapping_bundle import parse_score_mapping_bundle
from score_match_primitives import build_embedding_cosine_map_via_local_model, get_match_flags
from score_run_gt_pairing import evaluate_score_tree, flatten_score_rules
from safe_stdio import safe_print as _print

_DEFAULT_NUM_STEPS = 6


class _AppTextGradEngine(EngineLM):
    """Minimal textgrad EngineLM: routes every call (forward, backward, optimizer step) through this
    app's own llm.chat() and credential — see module docstring for why."""

    def __init__(self, *, provider: str, model: str, api_key: str, base_url: str, max_tokens: int):
        self.model_string = model
        self.system_prompt = "You are a helpful assistant."
        self._provider = provider
        self._model = model
        self._api_key = api_key
        self._base_url = base_url
        self._max_tokens = max_tokens

    def generate(self, prompt: Any, system_prompt: str | None = None, **kwargs: Any) -> str:
        sys_prompt = system_prompt if system_prompt is not None else self.system_prompt
        content = prompt if isinstance(prompt, str) else str(prompt)
        messages = [{"role": "system", "content": sys_prompt}, {"role": "user", "content": content}]
        return llm_chat(provider=self._provider, model=self._model, api_key=self._api_key, base_url=self._base_url, messages=messages, max_tokens=self._max_tokens)

    def __call__(self, prompt: Any, **kwargs: Any) -> str:
        return self.generate(prompt, **kwargs)


def _extract_prediction_dict(text: str) -> dict | None:
    try:
        raw = _extract_json_from_text(text)
        obj = json.loads(raw)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _format_question(row_input_subset: dict[str, str], response_format_hint: str) -> str:
    lines = [f"{k}: {v}" for k, v in row_input_subset.items()]
    lines.append("")
    lines.append(response_format_hint)
    return "\n".join(lines)


def run_textgrad(
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
    """Drive TextGrad. Emits: plan, stage(prepare|optimize(iteration)|select), suggestions (at most one),
    done."""
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
            "detail": "TextGrad needs an output schema (add typed output fields on the Prompt node) to know what a correct answer looks like.",
        })
        return

    input_root, output_root = parse_score_mapping_bundle(getattr(body, "score_mapping", None))
    del input_root  # Same as GEPA/MIPROv2: a fixed (example, its own GT) pair, no pairing search needed.
    output_leaves = flatten_score_rules(output_root)
    if not output_leaves:
        append_event({
            "type": "plan",
            "summary": "No Score output rules configured — TextGrad has no way to tell a correct answer from an incorrect one.",
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
        num_steps = int(st.get("textgrad_num_steps") or _DEFAULT_NUM_STEPS)
    except (TypeError, ValueError):
        num_steps = _DEFAULT_NUM_STEPS
    num_steps = max(2, min(50, num_steps))

    input_keys = extract_placeholder_keys(seed_text)
    output_field_keys = [str(f.get("key") or "").strip() for f in output_schema["fields"] if f.get("key")]
    gt_column_by_field = build_gt_column_by_field(output_leaves)

    response_format_hint = (
        "Respond with a single JSON object with these keys: " + ", ".join(output_field_keys)
        + ". Output ONLY the JSON object, no other text, no markdown fences."
    )

    append_event({
        "type": "plan",
        "summary": (
            f"TextGrad: optimizing section \"{section_name}\" in isolation "
            f"({len(input_keys)} placeholder field(s) it sees) against {len(examples)} example(s) via the "
            f"official textgrad package's textual gradient descent, {num_steps} step(s). Each step runs the "
            "task model, computes an LLM-generated textual gradient, then an LLM call to rewrite the "
            "section — cost scales with steps x examples x ~3."
        ),
        "diagnosis_total": 0,
    })
    if is_cancelled():
        return

    append_event({"type": "stage", "stage_id": "prepare", "kind": "start", "payload": {"num_examples": len(examples), "input_fields": input_keys}})

    engine = _AppTextGradEngine(provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens)
    system_prompt_var = tg.Variable(seed_text, requires_grad=True, role_description=f'Instructions for the "{section_name}" part of a prompt template')
    task_model = tg.BlackboxLLM(engine, system_prompt=system_prompt_var)
    optimizer = tg.TGD(parameters=[system_prompt_var], engine=engine)

    def make_loss_fn(example):
        def fn(prediction):
            pred_dict = _extract_prediction_dict(prediction.value) or {}
            embedding_cosine_map: dict[str, float] = {}
            if any(get_match_flags(r).get("embeddingSimilarity") for r in output_leaves):
                pairs: list[tuple[str, str]] = []
                for rule in output_leaves:
                    if not get_match_flags(rule).get("embeddingSimilarity"):
                        continue
                    run_val = str(pred_dict.get(str(rule.get("outputKey") or "").strip(), "") or "")
                    for col in rule.get("gtColumns") or []:
                        pairs.append((run_val, _resolve_gt_value(col, example)))
                embedding_cosine_map = build_embedding_cosine_map_via_local_model(pairs)
            rule_matches_row = _make_rule_matches_row([example], [pred_dict], embedding_cosine_map)
            ok = evaluate_score_tree(output_root, 0, 0, {}, {}, [], {}, rule_matches_row)
            if ok:
                return "Correct: the output matched the expected result."
            expected = {fk: _resolve_gt_value(gt_column_by_field.get(fk, fk), example) for fk in output_field_keys}
            shown = pred_dict if pred_dict else prediction.value
            return f"Incorrect. The output was {shown!r}, but the expected result was {expected!r}."

        return fn

    def run_pass_and_score() -> tuple[float, list]:
        losses = []
        scores = []
        for ex in examples:
            if is_cancelled():
                raise RuntimeError("Review cancelled")
            question_text = _format_question({k: str(ex.row_input.get(k, "")) for k in input_keys}, response_format_hint)
            question_var = tg.Variable(question_text, requires_grad=False, role_description="input to the task")
            try:
                prediction_var = task_model(question_var)
            except Exception as e:
                _print(f"[TextGrad] forward pass failed: {e}")
                continue
            loss_fn = StringBasedFunction(make_loss_fn(ex), function_purpose="Check the prediction against the expected result")
            loss_var = loss_fn(inputs={"prediction": prediction_var})
            losses.append(loss_var)
            scores.append(1.0 if loss_var.value.startswith("Correct") else 0.0)
        mean = sum(scores) / len(scores) if scores else 0.0
        return mean, losses

    append_event({"type": "stage", "stage_id": "prepare", "kind": "done", "payload": {}})
    if is_cancelled():
        return

    best_text = seed_text
    best_score = -1.0
    seed_score = 0.0

    append_event({"type": "stage", "stage_id": "optimize", "kind": "start", "payload": {"num_steps": num_steps}})
    try:
        for step in range(num_steps):
            if is_cancelled():
                return
            current_snapshot = system_prompt_var.value
            try:
                mean, losses = run_pass_and_score()
            except RuntimeError:
                return
            if step == 0:
                seed_score = mean
            if mean > best_score:
                best_score = mean
                best_text = current_snapshot
            _print(f"[TextGrad] step {step + 1}/{num_steps} score={mean:.3f} best={best_score:.3f}")
            append_event({"type": "stage", "stage_id": "optimize", "kind": "iteration", "payload": {
                "iteration": step + 1, "num_steps": num_steps, "score": mean, "best_score": best_score,
            }})
            if best_score >= 1.0 or not losses:
                break
            optimizer.zero_grad()
            total_loss = tg.sum(losses)
            total_loss.backward(engine=engine)
            optimizer.step()
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[TextGrad] optimization failed: {e}")
        append_event({"type": "error", "detail": f"TextGrad optimization failed: {e}"})
        return

    if is_cancelled():
        return

    # Each step scores the prompt BEFORE that step's own update, so the very last update is never scored
    # in the loop above — check it too, otherwise a final improving step would be silently discarded.
    if system_prompt_var.value.strip() != best_text.strip():
        try:
            final_mean, _unused = run_pass_and_score()
        except RuntimeError:
            return
        if final_mean > best_score:
            best_score = final_mean
            best_text = system_prompt_var.value

    append_event({"type": "stage", "stage_id": "optimize", "kind": "done", "payload": {}})
    _print(f"\n{'=' * 80}\nTextGrad done — seed={seed_score:.3f} best={best_score:.3f}\n{'=' * 80}\n")

    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    if best_score <= seed_score or best_text.strip() == seed_text.strip():
        append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": False, "final_score": seed_score}})
        append_event({"type": "done"})
        return

    target_labels = sorted({label for ex in examples for label in ex.score_labels}) or [1]
    edit = PromptEditSuggestion(
        name=f"TextGrad: evolved \"{section_name}\"",
        phase1_addresses=["TextGrad applied textual gradient descent to this section"],
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
    d["issue_cluster_label"] = "textgrad"
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {"improved": True, "final_score": best_score}})
    append_event({"type": "suggestions", "suggestions": [d]})
    append_event({"type": "done"})
