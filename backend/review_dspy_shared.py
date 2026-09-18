"""
Shared DSPy-bridging helpers for review methods that wrap a real `dspy` teleprompter
(review_miprov2.py, review_bootstrap_fewshot.py) — building the dynamic `dspy.Signature` for a target
prompt section optimized IN ISOLATION, wiring this app's example data and matching engine into DSPy's
`dspy.Example` / metric conventions, and constructing a `dspy.LM` from this app's own credential system.

See review_miprov2.py's module docstring for the "why in isolation" architecture note — the target
section becomes the Signature's `instructions`, its own `{placeholder}` keys become `dspy.InputField`s,
and other prompt sections are not shown to the optimizer at all. Every method built on this module
inherits that same scope choice; it isn't re-litigated per method.
"""

from __future__ import annotations

import re
from typing import Any, Callable

import dspy

from llm import _prepare_provider_env, _resolve_base_url, _resolve_model_name
from review_gepa import _make_rule_matches_row, _resolve_gt_value
from score_match_primitives import build_concept_id_map, build_embedding_cosine_map_via_local_model, get_match_flags, medical_concept_source
from score_run_gt_pairing import evaluate_score_tree
from safe_stdio import safe_print as _print

MAX_DEMOS_IN_SUGGESTION = 4

# Same placeholder syntax as prompt_template.py: `{key}` not immediately preceded by `{` or followed by `}`.
_PLACEHOLDER_RE = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")

DSPY_TYPE_MAP: dict[str, type] = {
    "str": str,
    "float": float,
    "list_str": list[str],
    "list_float": list[float],
}


def extract_placeholder_keys(text: str) -> list[str]:
    seen: list[str] = []
    for m in _PLACEHOLDER_RE.finditer(text or ""):
        k = m.group(1)
        if k not in seen:
            seen.append(k)
    return seen


def build_signature(*, instructions: str, input_keys: list[str], output_schema: dict, signature_name: str = "AppSection") -> type[dspy.Signature]:
    fields: dict[str, tuple[type, Any]] = {}
    for k in input_keys:
        fields[k] = (str, dspy.InputField())
    for f in output_schema.get("fields") or []:
        key = str(f.get("key") or "").strip()
        if not key:
            continue
        typ = DSPY_TYPE_MAP.get(str(f.get("type") or "str").strip().lower(), str)
        desc = str(f.get("description") or "").strip() or key
        fields[key] = (typ, dspy.OutputField(description=desc))
    if not fields:
        fields["_unused"] = (str, dspy.OutputField())
    return dspy.make_signature(fields, instructions=instructions, signature_name=signature_name)


class SectionModule(dspy.Module):
    def __init__(self, signature: type[dspy.Signature]):
        super().__init__()
        self.predict = dspy.Predict(signature)

    def forward(self, **kwargs):
        return self.predict(**kwargs)


def build_dspy_lm(*, provider: str, model: str, api_key: str, base_url: str, max_tokens: int) -> dspy.LM:
    """Same provider->litellm-model-string mapping llm.py's own chat()/run_structured() use, so a DSPy
    optimizer's internal calls hit the same endpoint this review job's credential is configured for."""
    _prepare_provider_env(provider, api_key)
    resolved_base = _resolve_base_url(provider, base_url)
    kwargs: dict[str, Any] = {}
    if resolved_base:
        kwargs["api_base"] = resolved_base
    return dspy.LM(model=_resolve_model_name(provider, model), api_key=api_key, max_tokens=max_tokens, **kwargs)


def format_demos_block(demos: list[Any], input_keys: list[str], output_field_keys: list[str]) -> str:
    if not demos:
        return ""
    blocks: list[str] = []
    for i, demo in enumerate(demos[:MAX_DEMOS_IN_SUGGESTION], start=1):
        get = demo.get if hasattr(demo, "get") else (lambda k, d=None: getattr(demo, k, d))
        lines = [f"Example {i}:"]
        for k in input_keys:
            lines.append(f"  {k}: {get(k, '')}")
        for k in output_field_keys:
            lines.append(f"  {k}: {get(k, '')}")
        blocks.append("\n".join(lines))
    return "\n\nExamples:\n" + "\n\n".join(blocks)


def build_gt_column_by_field(output_leaves: list[dict]) -> dict[str, str]:
    gt_column_by_field: dict[str, str] = {}
    for rule in output_leaves:
        key = str(rule.get("outputKey") or "").strip()
        cols = rule.get("gtColumns") or []
        if key and key not in gt_column_by_field and cols:
            gt_column_by_field[key] = cols[0]
    return gt_column_by_field


def build_dspy_examples(*, examples: list[Any], input_keys: list[str], output_field_keys: list[str], gt_column_by_field: dict[str, str]) -> list[Any]:
    dspy_examples = []
    for ex in examples:
        data: dict[str, Any] = {k: str(ex.row_input.get(k, "")) for k in input_keys}
        for fk in output_field_keys:
            data[fk] = _resolve_gt_value(gt_column_by_field.get(fk, fk), ex)
        dex = dspy.Example(**data).with_inputs(*input_keys)
        dex.app_example = ex
        dspy_examples.append(dex)
    return dspy_examples


def make_metric(*, output_root: dict, output_leaves: list[dict], output_field_keys: list[str]) -> Callable:
    def metric(dspy_example, prediction, trace=None) -> float:
        app_example = getattr(dspy_example, "app_example", None)
        if app_example is None:
            return 0.0
        output = {k: getattr(prediction, k, None) for k in output_field_keys}
        embedding_cosine_map: dict[str, float] = {}
        if any(get_match_flags(r).get("embeddingSimilarity") for r in output_leaves):
            pairs: list[tuple[str, str]] = []
            for rule in output_leaves:
                if not get_match_flags(rule).get("embeddingSimilarity"):
                    continue
                run_val = str(output.get(str(rule.get("outputKey") or "").strip(), "") or "")
                for col in rule.get("gtColumns") or []:
                    pairs.append((run_val, _resolve_gt_value(col, app_example)))
            embedding_cosine_map = build_embedding_cosine_map_via_local_model(pairs)
        concept_id_map: dict[str, dict | None] = {}
        concept_rules = [r for r in output_leaves if medical_concept_source(get_match_flags(r))]
        if concept_rules:
            by_source: dict[str, list[str]] = {}
            for rule in concept_rules:
                src = medical_concept_source(get_match_flags(rule))
                run_val = str(output.get(str(rule.get("outputKey") or "").strip(), "") or "")
                by_source.setdefault(src, []).append(run_val)
                for col in rule.get("gtColumns") or []:
                    by_source[src].append(_resolve_gt_value(col, app_example))
            for src, src_terms in by_source.items():
                concept_id_map.update(build_concept_id_map(src_terms, source=src))
        rule_matches_row = _make_rule_matches_row([app_example], [output], embedding_cosine_map, concept_id_map)
        ok = evaluate_score_tree(output_root, 0, 0, {}, {}, [], {}, rule_matches_row)
        return 1.0 if ok else 0.0

    return metric


def make_mean_score_fn(
    *,
    dspy_examples: list[Any],
    input_keys: list[str],
    metric: Callable,
    lm: dspy.LM,
    is_cancelled: Callable[[], bool],
    log_prefix: str,
) -> Callable:
    def mean_score(program: Any) -> float:
        total = 0.0
        n = 0
        with dspy.context(lm=lm):
            for dex in dspy_examples:
                if is_cancelled():
                    raise RuntimeError("Review cancelled")
                try:
                    pred = program(**{k: dex[k] for k in input_keys})
                    total += metric(dex, pred)
                except Exception as e:
                    _print(f"[{log_prefix}] example eval failed: {e}")
                n += 1
        return total / n if n else 0.0

    return mean_score
