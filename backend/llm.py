"""
LLM client via LiteLLM. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).

Default path is OpenAI-compatible (optionally with a custom base_url). A few
providers still need explicit routing hints so LiteLLM can call their native
APIs directly.
"""

import json
import os
import re
import time
from typing import Any

import litellm
from litellm import completion

from safe_stdio import safe_print

# ANSI: bold yellow for step names (match main.py)
_HL = "\033[1;33m"
_R = "\033[0m"
_SEP = "=" * 60

litellm.telemetry = False

# OpenAI-compatible providers can be reached through one client, using an
# optional custom base_url or a provider default.
OPENAI_COMPATIBLE_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "mistral": "https://api.mistral.ai/v1",
}

LITELLM_PROVIDER_PREFIX = {
    "anthropic": "anthropic",
    "deepseek": "deepseek",
    "google": "gemini",
    "gemini": "gemini",
    "mistral": "mistral",
    "bedrock": "bedrock",
    "amazon-bedrock": "bedrock",
}


def _is_retryable_error(e: Exception) -> bool:
    """True if error is transient (429, timeout, connection, 5xx)."""
    msg = (getattr(e, "message", None) or str(e)).lower()
    if any(x in msg for x in ("429", "rate limit", "rate", "timeout", "timed out", "connection", "network", "500", "502", "503", "service unavailable")):
        return True
    if getattr(e, "status_code", None) in (429, 500, 502, 503):
        return True
    return False


def _retry_invoke(fn, max_retries: int = 3):
    """Retry fn() on retryable errors with exponential backoff (1s, 2s, 4s)."""
    last_e = None
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:
            last_e = e
            if attempt < max_retries and _is_retryable_error(e):
                delay = 1.0 * (2**attempt)
                safe_print(_HL + f"[LLM] Retry {attempt + 1}/{max_retries} after {delay:.0f}s: " + _R + str(e), flush=True)
                time.sleep(delay)
            else:
                raise
    raise last_e


def _normalize_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        role = (m.get("role") or "user").lower()
        content = m.get("content") or ""
        if not isinstance(content, (str, list, dict)):
            content = str(content)
        out.append({"role": role, "content": content})
    return out


def _resolve_model_name(provider: str, model: str) -> str:
    model_name = (model or "").strip()
    if "/" in model_name:
        return model_name
    prefix = LITELLM_PROVIDER_PREFIX.get((provider or "").strip().lower())
    if prefix:
        return f"{prefix}/{model_name}"
    return model_name


def _prepare_provider_env(provider: str, api_key: str) -> None:
    provider_id = (provider or "").strip().lower()
    if provider_id in ("bedrock", "amazon-bedrock"):
        raw = (api_key or "").strip()
        if raw:
            if "=" in raw:
                raw = raw.split("=", 1)[-1]
            raw = raw.strip()
            if raw:
                os.environ["AWS_BEARER_TOKEN_BEDROCK"] = raw
        os.environ.setdefault("AWS_REGION_NAME", "us-east-1")


def _make_completion_kwargs(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int,
    response_format: Any | None = None,
) -> dict[str, Any]:
    provider_id = (provider or "").strip().lower()
    resolved_base_url = (base_url or "").strip() or OPENAI_COMPATIBLE_BASE_URLS.get(provider_id, "")
    kwargs: dict[str, Any] = {
        "model": _resolve_model_name(provider_id, model),
        "api_key": api_key,
        "max_tokens": max_tokens,
    }
    if resolved_base_url:
        kwargs["api_base"] = resolved_base_url
    if response_format is not None:
        kwargs["response_format"] = response_format
    return kwargs


def _message_content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "text" and isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "\n".join(p for p in parts if p).strip()
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def _extract_completion_text(response: Any) -> str:
    try:
        choices = getattr(response, "choices", None) or []
        if not choices:
            return ""
        msg = getattr(choices[0], "message", None) or {}
        content = getattr(msg, "content", None)
        if content is None and isinstance(msg, dict):
            content = msg.get("content")
        return _message_content_to_text(content).strip()
    except Exception:
        return ""


def _call_completion(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    messages: list[dict],
    max_tokens: int,
    response_format: Any | None = None,
) -> Any:
    _prepare_provider_env(provider, api_key)
    kwargs = _make_completion_kwargs(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        max_tokens=max_tokens,
        response_format=response_format,
    )
    kwargs["messages"] = _normalize_messages(messages)
    return _retry_invoke(lambda: completion(**kwargs))


def chat(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    messages: list[dict],
    max_tokens: int = 1024,
) -> str:
    """
    Call LLM via LiteLLM. Raises on error.
    messages: [{"role": "user", "content": "..."}, ...]
    Returns the assistant message content.
    """
    response = _call_completion(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        messages=messages,
        max_tokens=max_tokens,
    )
    return _extract_completion_text(response)


def _extract_json_from_text(text: str) -> str:
    """Extract a JSON object from text that may be wrapped in <reasoning>, markdown, etc."""
    text = text.strip()
    # Prefer markdown code block
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    # Else find first { and its matching }
    start = text.find("{")
    if start == -1:
        return text
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def _extract_json_array_from_text(text: str) -> str:
    """Extract a JSON array from text (markdown code block or first [...])."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    start = text.find("[")
    if start == -1:
        return "[]"
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return text[start:]


def _resolve_ref(schema: dict, ref: str) -> dict:
    """Resolve JSON Schema $ref like '#/$defs/StructuredOutput' against schema."""
    if not ref.startswith("#/"):
        return {}
    parts = ref[2:].split("/")
    cur = schema
    for p in parts:
        cur = cur.get(p) if isinstance(cur, dict) else {}
    return cur if isinstance(cur, dict) else {}


def _run_structured_fallback(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: str,
    response_model: type,
    max_tokens: int,
    return_shape: str = "single",
):
    """Fallback when native structured output is not supported: ask for JSON in prompt and parse.
    return_shape: 'single' -> one JSON object; 'table' -> JSON array of objects (each item same schema).
    """
    schema = response_model.model_json_schema()
    if return_shape == "table":
        item_schema = schema.get("properties", {}).get("rows", {}).get("items", schema)
        if item_schema.get("$ref"):
            item_schema = _resolve_ref(schema, item_schema["$ref"]) or item_schema
        instruction = (
            "\n\nRespond with a single valid JSON array of objects. Each object must conform to the following schema. "
            "Return only the JSON array, no other text or markdown.\nSchema for each item:\n"
            + json.dumps(item_schema, ensure_ascii=False, indent=2)
        )
        full_prompt = prompt + instruction
        safe_print("\n" + _HL + _SEP + _R)
        safe_print(_HL + "[Run] Fallback: prompt + JSON array schema (structured output not supported)" + _R)
        safe_print(_HL + _SEP + _R)
        safe_print(instruction)
        safe_print(_HL + _SEP + _R + "\n", flush=True)
        text = chat(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=[{"role": "user", "content": full_prompt}],
            max_tokens=max_tokens,
        )
        json_str = _extract_json_array_from_text(text)
        data = json.loads(json_str)
        if not isinstance(data, list):
            data = [data] if isinstance(data, dict) else []
        item_props = item_schema.get("properties", {})
        for row in data:
            if not isinstance(row, dict):
                continue
            for key, prop in item_props.items():
                if prop.get("type") == "string" and row.get(key) is None:
                    row[key] = ""
        obj = response_model.model_validate({"rows": data})
        return obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
    # single
    instruction = (
        "\n\nRespond with a single valid JSON object that conforms to the following schema. "
        "Return only the JSON, no other text or markdown.\nSchema:\n"
        + json.dumps(schema, ensure_ascii=False, indent=2)
    )
    full_prompt = prompt + instruction
    safe_print("\n" + _HL + _SEP + _R)
    safe_print(_HL + "[Run] Fallback: prompt + JSON schema (structured output not supported)" + _R)
    safe_print(_HL + _SEP + _R)
    safe_print(instruction)
    safe_print(_HL + _SEP + _R + "\n", flush=True)
    text = chat(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        messages=[{"role": "user", "content": full_prompt}],
        max_tokens=max_tokens,
    )
    json_str = _extract_json_from_text(text)
    data = json.loads(json_str)
    for key, prop in schema.get("properties", {}).items():
        if prop.get("type") == "string" and data.get(key) is None:
            data[key] = ""
    obj = response_model.model_validate(data)
    return obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()


def run_structured(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: str,
    response_model: type,
    max_tokens: int = 8192,
    return_shape: str = "single",
):
    """
    Call LLM with structured output (Pydantic model). Returns (result_dict | result_list, used_fallback: bool).
    return_shape: 'single' -> one object per prompt; 'table' -> one array of objects per prompt (response_model must have "rows" field).
    If the provider does not support native structured output, falls back to prompt + JSON parse.
    """
    try:
        response = _call_completion(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            response_format=response_model,
        )
        msg = None
        choices = getattr(response, "choices", None) or []
        if choices:
            msg = getattr(choices[0], "message", None)
        parsed = getattr(msg, "parsed", None) if msg is not None else None
        if parsed is None:
            parsed = getattr(response, "parsed", None)
        if parsed is None:
            text = _extract_completion_text(response)
            if return_shape == "table":
                data = json.loads(_extract_json_array_from_text(text))
                if not isinstance(data, list):
                    data = [data] if isinstance(data, dict) else []
                parsed = response_model.model_validate({"rows": data})
            else:
                data = json.loads(_extract_json_from_text(text))
                parsed = response_model.model_validate(data)
        obj = parsed
        out = obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
        return (out, False)
    except Exception as e:
        err_msg = (getattr(e, "message", None) or str(e)).lower()
        if any(
            x in err_msg
            for x in (
                "structured output",
                "response_format",
                "json_schema",
                "unavailable",
                "not supported",
                "invalid_request_error",
                "does not support",
                "unsupported",
            )
        ):
            out = _run_structured_fallback(
                provider=provider,
                model=model,
                api_key=api_key,
                base_url=base_url,
                prompt=prompt,
                response_model=response_model,
                max_tokens=max_tokens,
                return_shape=return_shape,
            )
            return (out, True)
        raise
