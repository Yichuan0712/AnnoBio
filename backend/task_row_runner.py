"""Run a prompt template on one dataset input with the user's Generate model, in-process (no Run job).

Used by backend optimizers that must predict (the AnnoBio engine's worked-example search). It reproduces what a
Run / Verify request does for one input (main.py _do_run_work): the browser's placeholder substitution
(pipeline_runtime_adapters.compile_prompt_content), the output model built from the output schema
(run_output_schema), the Generate model's own parameters (`run_params`) and max tokens, retries on an empty
output, and table outputs unwrapped to one dict per row. Field names are sanitized the same way, so the outputs
use the same keys as the Run results the Evaluate scores.
"""
from __future__ import annotations

import time
from typing import Any, Callable

from llm import run_structured as llm_run_structured
from pipeline_runtime_adapters import compile_prompt_content
from run_output_schema import (build_output_model, build_table_output_model, run_structured_output_is_empty,
                               sanitize_field_name)


def output_fields_for(schema_fields: list[dict]) -> list[dict]:
    """[{display, key}] exactly as the Run job names its result keys."""
    out, seen = [], set()
    for field in schema_fields:
        display = field.get("key") or "field"
        name = sanitize_field_name(display)
        if name in seen:
            n = 1
            while f"{name}_{n}" in seen:
                n += 1
            name = f"{name}_{n}"
        seen.add(name)
        out.append({"display": display, "key": name})
    return out


def make_row_runner(*, provider: str, model: str, api_key: str, base_url: str, output_schema: dict,
                    run_settings: dict, project_session_id: str | None = None,
                    run_structured: Callable = llm_run_structured, sleep: Callable[[float], None] = time.sleep):
    """A function (template, values) -> list of output dicts for one input (one dict, or one per table row).

    Raises ValueError on a missing schema or an input that cannot be compiled, RuntimeError when the model keeps
    returning an empty output; provider errors propagate as they would from a Run."""
    fields = output_schema.get("fields") or []
    if not fields:
        raise ValueError("output_schema.fields is required")
    shape = (output_schema.get("return_shape") or "single").strip().lower()
    shape = shape if shape in ("single", "table") else "single"
    response_model = build_output_model(fields)
    if shape == "table":
        response_model = build_table_output_model(response_model)
    output_fields = output_fields_for(fields)
    max_tokens = int(run_settings.get("run_max_tokens") or 8192)
    params = dict(run_settings.get("run_params") or {})
    retries = min(5, max(0, int(run_settings.get("run_max_retries", 0) or 0)))

    def run(template: str, values: dict[str, Any]) -> list[dict]:
        prompt = compile_prompt_content(template, values or {}, project_session_id)
        for attempt in range(retries + 1):
            out, _used_fallback = run_structured(provider=provider, model=model, api_key=api_key, base_url=base_url,
                                                 prompt=prompt, response_model=response_model, max_tokens=max_tokens,
                                                 return_shape=shape, params=params)
            if shape == "table" and isinstance(out, dict) and "rows" in out:
                out = out["rows"]
            if run_structured_output_is_empty(out, shape, output_fields):
                if attempt < retries:
                    sleep(min(2 ** attempt, 8))
                    continue
                raise RuntimeError("Empty model output")
            if shape == "table" and isinstance(out, list):
                return [row if isinstance(row, dict) else {} for row in out]
            return [out if isinstance(out, dict) else {}]
        raise RuntimeError("Empty model output")
    run.output_fields = output_fields
    return run
