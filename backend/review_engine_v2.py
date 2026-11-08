"""Optimize with engine v2 (python/ENGINE_V2_DESIGN.md 6.0l; the default review method from 2026-11-07).

Same job contract as every review method (review_methods.py) and the same event stream as the built-in pipeline,
so the Optimize panel, Verify, "Click to Optimize", Accept/Revert, Apply and the Agent work unchanged:
  plan -> diagnosis_row (one per diagnosed input) -> suggestions -> done.
What the engine does with the evaluation the user already ran (no task-model call for the analysis):
  * one Example per input (its placeholder values, its ground-truth rows), observed with the run outputs and the
    Score node's verdicts; the input passes only when every scoring row matched (the app's rule);
  * the user's matching rules (comparison_types: per-field rule labels or the custom match() code) go to the
    optimization model in Evaluation.feedback, the per-row verdicts in Evaluation.details;
  * diagnosis of up to `engine_failed_inputs` failed inputs (每次分析的错题数), then `engine_num_proposals`
    whole-prompt rewrite cards (每次给出的修改方案数) - the rewrite the formal experiments used;
  * the worked-example card (提供例子方案; engine.search_demos) needs the task model and backend scoring and is
    added in a later step (docs/design/SCORING_BACKEND_PLAN.md step 3).
"""
from __future__ import annotations

import json
from typing import Any, Callable

from pydantic import Field, create_model

from annobio_optimize import Evaluation, Example, Observation
from annobio_optimize.engine import EngineConfig, EngineStopped, Session
from llm import run_structured as llm_run_structured

DEFAULT_FAILED_INPUTS = 10
DEFAULT_PROPOSALS = 3
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
    failed_cap = int(settings.get("engine_failed_inputs", DEFAULT_FAILED_INPUTS))
    proposals = int(settings.get("engine_num_proposals", DEFAULT_PROPOSALS))
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
    except EngineStopped:
        return
    append_event({"type": "done"})
