"""
DSPy MIPROv2-based Review Finetune: optimizes instruction + few-shot demos for a span-rewrite
ChainOfThought module; objective = same pass-rate metric as the app (finetune_pass_rate_eval).
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from finetune_pass_rate_eval import compute_pass_rate

logger = logging.getLogger(__name__)


def _litellm_model_id(provider: str, model: str) -> str:
    p = (provider or "openai").strip().lower()
    m = (model or "").strip()
    if not m:
        raise ValueError("Model id is required for MIPROv2 LM")
    if p == "openai":
        return f"openai/{m}"
    if p == "anthropic":
        return f"anthropic/{m}"
    if p == "google":
        return f"gemini/{m}"
    if p == "deepseek":
        return f"deepseek/{m}"
    if p == "mistral":
        return f"mistral/{m}"
    if p == "bedrock":
        raise ValueError("Amazon Bedrock credentials are not supported for DSPy MIPROv2 in this build; use OpenAI, Anthropic, Google, DeepSeek, or Mistral.")
    raise ValueError(f"Unsupported provider for MIPROv2 LM: {p}")


def _openai_reasoning_model_id_for_dspy(model: str) -> bool:
    """DSPy requires temperature=1.0 or None and max_tokens>=16000 or None for these OpenAI models."""
    m = (model or "").strip().lower()
    return (
        m.startswith("gpt-5")
        or m.startswith("o1")
        or m.startswith("o3")
        or m.startswith("o4")
    )


def _miprov2_dspy_lm_kwargs(
    finetune_provider: str,
    finetune_model: str,
    finetune_max_tokens: int,
) -> dict[str, Any]:
    tok = int(finetune_max_tokens or 8192)
    if (finetune_provider or "").strip().lower() == "openai" and _openai_reasoning_model_id_for_dspy(finetune_model):
        return {"temperature": 1.0, "max_tokens": max(16000, tok)}
    return {"max_tokens": min(tok, 8192)}


def run_miprov2_finetune(
    *,
    finetune_provider: str,
    finetune_model: str,
    finetune_api_key: str,
    finetune_max_tokens: int,
    run_provider: str,
    run_model: str,
    run_api_key: str,
    run_max_tokens: int,
    old_sentence: str,
    new_sentence: str,
    originals: list[dict[str, Any]],
    all_suggestions: list[dict[str, Any]],
    sug_index: int,
    expanded_comparison_rows: list[dict[str, Any]],
    run_results: list[dict[str, Any]],
    output_fields: list[Any],
    output_schema: dict[str, Any],
    score_mapping_json: Any,
    run_ws: dict[str, Any],
    gt_content: dict[str, Any],
    auto: str = "light",
) -> dict[str, Any]:
    try:
        import dspy
        from dspy import MIPROv2
    except ImportError as e:
        raise RuntimeError(
            "dspy-ai is not installed. Add it with: pip install 'dspy-ai>=3.0.0,<3.2'"
        ) from e

    lm_model = _litellm_model_id(finetune_provider, finetune_model)
    lm_kw = _miprov2_dspy_lm_kwargs(finetune_provider, finetune_model, finetune_max_tokens)
    lm = dspy.LM(
        lm_model,
        api_key=finetune_api_key,
        **lm_kw,
    )
    dspy.configure(lm=lm)

    eval_kw: dict[str, Any] = {
        "provider": run_provider,
        "model": run_model,
        "api_key": run_api_key,
        "run_max_tokens": run_max_tokens,
        "originals": originals,
        "all_suggestions": all_suggestions,
        "sug_index": sug_index,
        "expanded_rows": expanded_comparison_rows,
        "run_results": run_results,
        "output_fields": output_fields,
        "output_schema": output_schema,
        "score_mapping_json": score_mapping_json,
        "run_ws": run_ws,
        "gt_content": gt_content,
    }

    def metric_fn(gold: Any, pred: Any, trace: Any | None = None, pred_name: Any | None = None, **kwargs) -> float:
        del trace, pred_name, kwargs
        rewritten = getattr(pred, "rewritten", None)
        if rewritten is None and isinstance(pred, dict):
            rewritten = pred.get("rewritten")
        if rewritten is None:
            return 0.0
        text = str(rewritten).strip()
        if not text:
            return 0.0
        try:
            rate, ok, _err = compute_pass_rate(**eval_kw, candidate_rewrite=text)
            return float(rate) if ok else 0.0
        except Exception as ex:
            logger.warning("MIPROv2 metric eval failed: %s", ex)
            return 0.0

    student = dspy.ChainOfThought("old_fragment, proposal -> rewritten")

    teleprompter = MIPROv2(
        metric=metric_fn,
        auto=auto,
        num_threads=1,
        max_errors=5,
        verbose=False,
        track_stats=True,
    )

    ex = dspy.Example(
        old_fragment=old_sentence,
        proposal=new_sentence,
        rewritten=new_sentence,
    ).with_inputs("old_fragment", "proposal")
    trainset = [copy.copy(ex), copy.copy(ex), copy.copy(ex)]

    optimized = teleprompter.compile(
        student,
        trainset=trainset,
        valset=[copy.copy(ex)],
        minibatch=False,
    )

    final = optimized(old_fragment=old_sentence, proposal=new_sentence)
    best = str(getattr(final, "rewritten", "") or "").strip()
    if not best:
        best = new_sentence

    rate, ok, err = compute_pass_rate(**eval_kw, candidate_rewrite=best)

    return {
        "best_text": best,
        "best_pass_rate": float(rate) if ok else 0.0,
        "eval_ok": ok,
        "eval_error": err or None,
        "optimizer": "miprov2",
        "auto": auto,
    }
