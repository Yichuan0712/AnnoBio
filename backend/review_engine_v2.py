"""Optimize with engine v2 (python/ENGINE_V2_DESIGN.md 6.0l; the default review method from 2026-11-07).

Same job contract as every review method (review_methods.py) and the same event stream as the built-in pipeline,
so the Optimize panel, Verify, "Click to Optimize", Accept/Revert, Apply and the Agent work unchanged:
  plan -> diagnosis_row (one per diagnosed input) -> suggestions -> done.
What the engine does with the evaluation the user already ran (no task-model call for the analysis):
  * one Example per input (its placeholder values, its ground-truth rows), observed with the run outputs and the
    Score node's verdicts; the input passes only when every scoring row matched (the app's rule);
  * the user's matching rules (comparison_types: per-field rule labels or the custom match() code) go to the
    optimization model in Evaluation.feedback, the per-row verdicts in Evaluation.details;
  * exploration intensity (`engine_exploration`, 探索强度): low / medium / high diagnoses 4 / 8 / 16 failed inputs
    and proposes 1 / 2 / 4 whole-prompt rewrite cards - the rewrite the formal experiments used (low = their
    settings: four failed inputs per rewrite, one rewrite per round);
  * few-shot optimization (`engine_few_shot`, 启用 few-shot 优化): the worked-example card (engine.search_demos),
    when the request carries the task model and the Evaluate's scoring (review_engine_hooks.py).
"""
from __future__ import annotations

import json
from typing import Any, Callable

from pydantic import Field, create_model

from annobio_optimize import Evaluation, Example, Observation
from annobio_optimize.engine import EngineConfig, EngineStopped, Session
from llm import run_structured as llm_run_structured

EXPLORATION = {"low": (4, 1), "medium": (8, 2), "high": (16, 4)}  # failed inputs diagnosed, rewrites proposed
DEFAULT_EXPLORATION = "low"
EVIDENCE_EXAMPLES = 4  # full evidence shown per rewrite (the formal experiments' max_evidence_examples)


def _row(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    return raw.model_dump() if hasattr(raw, "model_dump") else raw.dict()


def _schema_model(name: str, schema: dict):
    """A pydantic model for one of the engine's response schemas (objects, arrays, strings, enums)."""
    def field_type(sub: dict, label: str):
        kind = sub.get("type")
        if kind == "object":
            return _schema_model(label, sub)
        if kind == "array":
            return list[field_type(sub.get("items", {"type": "string"}), label + "Item")]
        if kind == "number":
            return float
        if kind == "integer":
            return int
        if kind == "boolean":
            return bool
        return str
    fields = {key: (field_type(sub, f"{name}_{key}"), Field(...)) for key, sub in schema.get("properties", {}).items()}
    return create_model(name, **fields)


def make_model_callback(provider: str, model: str, api_key: str, base_url: str, max_tokens: int):
    """engine.Session's `model`: the request's instruction, schema and payload in one prompt, structured output."""
    def call(request):
        prompt = (request.instruction + "\nresponse_schema=" + json.dumps(request.response_schema, ensure_ascii=False)
                  + "\npayload=" + json.dumps(request.payload, ensure_ascii=False))
        response_model = _schema_model(f"Engine_{request.stage}", request.response_schema)
        out, _used_fallback = llm_run_structured(provider=provider, model=model, api_key=api_key, base_url=base_url,
                                                 prompt=prompt, response_model=response_model, max_tokens=max_tokens)
        if hasattr(out, "model_dump"):
            out = out.model_dump()
        return out
    return call


def matching_rules_text(rows: list[dict]) -> str:
    """The Score node's matching rules as the optimization model should read them."""
    rules: list[str] = []
    for row in rows:
        for rule in row.get("comparison_types") or []:
            if rule and rule not in rules:
                rules.append(str(rule))
    if not rules:
        return ""
    return "How the Score node decides a match (the user's matching rules):\n" + "\n".join(f"- {r}" for r in rules)


def build_inputs(comparison_rows: list) -> tuple[list[Example], list[Observation], dict[str, list[int]], dict[str, int]]:
    """One Example per dataset input (comparison rows grouped by input_row_index), with its observation."""
    groups: dict[int, list[dict]] = {}
    for raw in comparison_rows:
        row = _row(raw)
        key = row.get("input_row_index")
        groups.setdefault(int(key if key is not None else row["row_index"]), []).append(row)
    examples, observations, rows_of, number_of = [], [], {}, {}
    for key in sorted(groups):
        rows = groups[key]
        example_id = f"input-{key + 1}"
        references = [r.get("ground_truth_output") or {} for r in rows if not _empty(r.get("ground_truth_output"))]
        outputs = [r.get("run_output") or {} for r in rows if not r.get("gt_only") and not _empty(r.get("run_output"))]
        inputs = rows[0].get("row_input") or {}
        matched = sum(1 for r in rows if r.get("matched"))
        details = [{"run_output": r.get("run_output") or {}, "expected": r.get("ground_truth_output") or {},
                    "matched": bool(r.get("matched")), **({"missing_from_output": True} if r.get("gt_only") else {})}
                   for r in rows]
        examples.append(Example(example_id, inputs, references))
        observations.append(Observation(example_id, outputs, Evaluation(
            matched / len(rows), feedback=matching_rules_text(rows), details=details,
            matched_count=matched, total_count=len(rows))))
        rows_of[example_id] = [int(r["row_index"]) for r in rows]
        number_of[example_id] = key + 1
    return examples, observations, rows_of, number_of


def _empty(value) -> bool:
    return value is None or value == {} or value == [] or value == ""


def _suggestion(card, rows_of: dict[str, list[int]], index: int) -> dict:
    targets = sorted({row for example_id in card.target_example_ids for row in rows_of.get(example_id, [])})
    addresses = [a[:500] for a in card.addresses[:3] if a and a.strip()] or ["Failed inputs of this Optimize"]
    return {"name": (card.title or f"Rewrite {index}")[:200], "phase1_addresses": addresses,
            "old_sentence": card.old_text, "new_sentence": card.new_text, "reason": card.rationale,
            "target_score_row_indices": targets, "row_indices": targets, "engine_card_id": card.id,
            "engine_card_kind": card.kind}


def run_engine_v2(*, provider: str, model: str, api_key: str, base_url: str, body, max_tokens: int,
                  max_failed_inputs: int, is_cancelled: Callable[[], bool], append_event: Callable[[dict], None],
                  settings: dict | None = None, llm_call=None) -> None:
    settings = settings or {}
    failed_cap, proposals = EXPLORATION.get(str(settings.get("engine_exploration") or DEFAULT_EXPLORATION),
                                            EXPLORATION[DEFAULT_EXPLORATION])
    examples, observations, rows_of, number_of = build_inputs(list(body.comparison_rows or []))
    prompt = body.prompt or ""
    if not examples or not prompt.strip():
        append_event({"type": "plan", "summary": "Nothing to analyze.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return
    model_call = llm_call or make_model_callback(provider, model, api_key, base_url, max_tokens)
    config = EngineConfig(max_failed_examples=failed_cap, max_evidence_examples=EVIDENCE_EXAMPLES)
    emitted: set[str] = set()
    session: Session | None = None

    def emit_new_issues():
        for issue in (session.issues if session is not None else []):
            if issue.id in emitted:
                continue
            emitted.add(issue.id)
            append_event({"type": "diagnosis_row", "input_index": number_of[issue.example_id],
                          "row_indices": rows_of[issue.example_id], "done": len(emitted), "total": total,
                          "opinion": {"card_title": issue.title, "issue_summary": issue.summary,
                                      "rough_modification_opinion": issue.advice,
                                      "problem_category_hint": issue.category, "gt_suspect_note": issue.reference_note}})

    def on_event(event):
        if event.stage in ("diagnose", "propose"):
            emit_new_issues()

    def unused_predict(_prompt, _inputs):  # the analysis reuses the user's run; Verify runs in the frontend
        raise RuntimeError("engine v2 analysis does not run the task model")

    session = Session(model=model_call, predict=unused_predict, evaluate=lambda e, p: Evaluation(0.0), prompt=prompt,
                      examples=examples, observations=observations, config=config, on_event=on_event,
                      is_cancelled=is_cancelled)
    failed = session.failed()
    total = min(len(failed), failed_cap)
    append_event({"type": "plan", "summary": f"{len(failed)} of {len(examples)} inputs failed; diagnosing {total}.",
                  "diagnosis_total": total})
    if not failed:
        append_event({"type": "done"})
        return
    try:
        cards = []
        for _ in range(max(1, proposals)):
            for card in session.analyze("rewrite"):
                cards.append(card)
        emit_new_issues()
        suggestions = [_suggestion(card, rows_of, i + 1) for i, card in enumerate(cards)]
        if suggestions:
            append_event({"type": "suggestions", "suggestions": suggestions})
        run_row, score_input = settings.get("_run_row"), settings.get("_score_input")
        if settings.get("engine_few_shot", True) and run_row is not None and score_input is not None:
            card = example_card(prompt=prompt, examples=examples, observations=observations, rows_of=rows_of,
                                model_call=model_call, run_row=run_row, score_input=score_input,
                                is_cancelled=is_cancelled)
            if card is not None:
                append_event({"type": "suggestions", "suggestions": [card]})
    except EngineStopped:
        return
    append_event({"type": "done"})


# ---------------------------------------------------------------- worked examples (engine.search_demos, 6.0m)

MIN_INPUTS_FOR_EXAMPLES = 6
MAX_POOL = MAX_SCORING = 32           # the experiment's two batches of 16 each
LONG_INPUT_CHARS = 10000              # inputs this long (e.g. full papers) get one example per set, as RoBBR did


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def render_examples(prompt: str, demos: list) -> str:
    """The experiment's examples block (harness.with_demos; with an EXPLANATION when the set is explained)."""
    explained = any(note for _, _, note in demos)
    blocks = []
    for index, (example, output, note) in enumerate(demos, 1):
        middle = f"EXPLANATION\n{(note or '').strip()}\n" if explained else ""
        blocks.append(f"EXAMPLE {index}\nINPUT_JSON\n{_json(example.inputs)}\n{middle}OUTPUT_JSON\n{output.strip()}")
    header = ("WORKED_EXAMPLES (solved examples with explanations; for the final INPUT_JSON return only the "
              "required JSON, without an explanation)" if explained
              else "WORKED_EXAMPLES (solved examples; answer only the final INPUT_JSON)")
    return prompt + "\n\n" + header + "\n\n" + "\n\n".join(blocks) + "\n\nEND_OF_WORKED_EXAMPLES"


def _as_output(outputs: list) -> str:
    """One input's outputs as the JSON text an example shows (one object, or the rows of a table)."""
    return _json(outputs[0] if len(outputs) == 1 else outputs)


def example_card(*, prompt: str, examples: list[Example], observations: list[Observation], rows_of: dict,
                 model_call, run_row, score_input, is_cancelled, seed: int = 0) -> dict | None:
    """The best of six worked-example sets (engine.search_demos) as one suggestion card, or None.

    run_row(template, values) -> output dicts of one input (the user's Generate model, task_row_runner);
    score_input(example_id, outputs) -> (matched_count, total_count) by the Evaluate's own rules (backend scoring).
    The examples come from half of the evaluated inputs, the scoring from the other half; the prompt's own run
    is the one the user already scored, so it is not run again. The card appends the examples after the
    prompt's closing line; the user verifies it like any other card."""
    import random

    from annobio_optimize.engine import search_demos
    from annobio_optimize.engine.session import _closing_anchor

    scorable = getattr(score_input, "scorable", None)  # inputs Verify can score (an input_row_index)
    if scorable is not None:
        examples = [e for e in examples if e.id in scorable]
    if len(examples) < MIN_INPUTS_FOR_EXAMPLES:
        return None
    order = sorted(examples, key=lambda e: e.id)
    random.Random(seed).shuffle(order)
    half = len(order) // 2
    pool_ex, scoring_ex = order[:half][:MAX_POOL], order[half:][:MAX_SCORING]
    by_id = {o.example_id: o for o in observations}

    def search_example(example: Example) -> Example:  # one GT row shows as an object, several as a list
        refs = example.reference or []
        return Example(example.id, example.inputs, refs[0] if len(refs) == 1 else refs)

    def search_observation(example: Example) -> Observation:
        seen = by_id[example.id]
        return Observation(example.id, _as_output(seen.prediction or [{}]), seen.evaluation)

    def predict(text: str, inputs: dict) -> str:
        try:
            return _as_output(run_row(text, inputs) or [{}])
        except Exception as exc:  # a failed run scores as unmatched, as an error row does in a Run
            return _json({"_error": str(exc)[:200]})

    feedback = {e.id: by_id[e.id].evaluation.feedback for e in examples}

    def evaluate(example: Example, prediction: str) -> Evaluation:
        try:
            outputs = json.loads(prediction)
        except (TypeError, ValueError):
            outputs = {}
        outputs = [] if isinstance(outputs, dict) and "_error" in outputs else (outputs if isinstance(outputs, list) else [outputs])
        matched, total = score_input(example.id, outputs)
        return Evaluation(matched / total if total else 0.0, feedback=feedback.get(example.id, ""),
                          matched_count=matched, total_count=total)

    lengths = sorted(len(_json(e.inputs)) for e in examples)
    cap = 1 if lengths[len(lengths) // 2] > LONG_INPUT_CHARS else 3
    pool = [search_example(e) for e in pool_ex]
    scoring = [search_example(e) for e in scoring_ex]
    result = search_demos(model=model_call, predict=predict, evaluate=evaluate, render=render_examples, prompt=prompt,
                          pool=pool, scoring=scoring, cap=cap, seed=seed, is_cancelled=is_cancelled,
                          pool_observations=[search_observation(e) for e in pool_ex],
                          scoring_observations=[search_observation(e) for e in scoring_ex])
    best = result.best_candidate()
    if best is None:
        return None
    start = _closing_anchor(prompt)
    anchor = prompt[start:]
    block = best.prompt[len(prompt):]
    failed_scoring = [e.id for e in scoring_ex if by_id[e.id].evaluation.matched_count != by_id[e.id].evaluation.total_count]
    targets = sorted({row for example_id in (failed_scoring or [e.id for e in scoring_ex])
                      for row in rows_of.get(example_id, [])})
    source = {"failures": "failed inputs", "labeled": "inputs with their reference answers",
              "bootstrapped": "inputs the prompt already got right"}[best.source]
    with_notes = ", with explanations" if best.explained else ""
    base = result.base_full_score if result.base_full_score is not None else 0.0
    count = len(best.example_ids)
    reason = (f"Best of {len(result.candidates)} worked-example sets on {len(scoring_ex)} held-out inputs: "
              f"{best.full_score:.2f} with these examples vs {base:.2f} without. "
              f"{count} example{'s' if count != 1 else ''} from {source}{with_notes}.")
    return {"name": "Add worked examples", "phase1_addresses": [f"Worked examples from {source}"[:500]],
            "old_sentence": anchor, "new_sentence": anchor + block, "reason": reason,
            "target_score_row_indices": targets, "row_indices": targets, "engine_card_kind": "demos",
            "engine_demo_set": best.name, "engine_demo_example_ids": list(best.example_ids)}
