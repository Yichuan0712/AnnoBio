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
}

LITELLM_PROVIDER_PREFIX = {
    "anthropic": "anthropic",
    "deepseek": "deepseek",
    "google": "gemini",
    "gemini": "gemini",
    "bedrock": "bedrock",
    "amazon-bedrock": "bedrock",
    "openrouter": "openrouter",
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
    provider_id = (provider or "").strip().lower()
    if provider_id == "openrouter":
        # OpenRouter model ids are themselves "vendor/model" (e.g. anthropic/claude-3.5-sonnet),
        # which collides with LiteLLM's own provider-prefix sniffing (it would try native
        # Anthropic routing instead of OpenRouter). Always wrap with LiteLLM's own openrouter/
        # prefix so it routes through OpenRouter's endpoint, regardless of what the user typed.
        inner = model_name
        if inner.lower().startswith("openrouter/"):
            inner = inner[len("openrouter/"):]
        return f"openrouter/{inner}"
    if "/" in model_name:
        return model_name
    prefix = LITELLM_PROVIDER_PREFIX.get(provider_id)
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


def _resolve_base_url(provider: str, base_url: str) -> str:
    provider_id = (provider or "").strip().lower()
    return (base_url or "").strip() or OPENAI_COMPATIBLE_BASE_URLS.get(provider_id, "")


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
    resolved_base_url = _resolve_base_url(provider_id, base_url)
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


def _debug_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _debug_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_debug_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _debug_jsonable(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "dict"):
        try:
            return _debug_jsonable(value.dict())
        except Exception:
            pass
    payload: dict[str, Any] = {}
    for attr in (
        "content",
        "additional_kwargs",
        "response_metadata",
        "usage_metadata",
        "tool_calls",
        "invalid_tool_calls",
        "id",
        "name",
    ):
        if hasattr(value, attr):
            try:
                payload[attr] = _debug_jsonable(getattr(value, attr))
            except Exception:
                payload[attr] = str(getattr(value, attr))
    if payload:
        return payload
    return str(value)


def _call_completion(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    messages: list[dict],
    max_tokens: int,
    response_format: Any | None = None,
    max_retries: int = 3,
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
    return _retry_invoke(lambda: completion(**kwargs), max_retries=max_retries)


def chat(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    messages: list[dict],
    max_tokens: int = 1024,
    max_retries: int = 3,
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
        max_retries=max_retries,
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


def build_langchain_chat_model(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int,
):
    """Build a LangChain chat model for providers with native structured output support."""
    provider_id = (provider or "").strip().lower()
    resolved_base_url = _resolve_base_url(provider_id, base_url)
    model_name = (model or "").strip()

    if provider_id in ("", "openai", "deepseek"):
        from langchain_openai import ChatOpenAI

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_key": api_key,
            "max_tokens": max_tokens,
        }
        if resolved_base_url:
            kwargs["base_url"] = resolved_base_url
        return ChatOpenAI(**kwargs)

    if provider_id == "anthropic":
        from langchain_anthropic import ChatAnthropic

        kwargs = {
            "model": model_name,
            "api_key": api_key,
            "max_tokens": max_tokens,
        }
        if resolved_base_url:
            kwargs["base_url"] = resolved_base_url
        return ChatAnthropic(**kwargs)

    if provider_id in ("google", "gemini"):
        from langchain_google_genai import ChatGoogleGenerativeAI

        kwargs = {
            "model": model_name,
            "api_key": api_key,
            "max_tokens": max_tokens,
        }
        if resolved_base_url:
            kwargs["base_url"] = resolved_base_url
        return ChatGoogleGenerativeAI(**kwargs)

    raise NotImplementedError(f"LangChain structured output is not enabled for provider '{provider_id or provider}'.")


def _build_langchain_structured_runnable(
    *,
    provider: str,
    chat_model: Any,
    response_model: type,
    base_url: str,
    include_raw: bool = False,
):
    provider_id = (provider or "").strip().lower()
    resolved_base_url = _resolve_base_url(provider_id, base_url)

    # OpenAI-compatible endpoints behind custom base_url often have better tool-calling
    # compatibility than json_schema compatibility.
    if provider_id == "deepseek" or (provider_id in ("", "openai") and resolved_base_url):
        return chat_model.with_structured_output(
            response_model,
            method="function_calling",
            include_raw=include_raw,
        )
    if provider_id in ("google", "gemini"):
        return chat_model.with_structured_output(
            response_model,
            method="json_schema",
            include_raw=include_raw,
        )
    if provider_id in ("", "openai"):
        return chat_model.with_structured_output(
            response_model,
            strict=True,
            include_raw=include_raw,
        )
    return chat_model.with_structured_output(response_model, include_raw=include_raw)


def _run_structured_via_litellm(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: Any,
    response_model: type,
    max_tokens: int,
    return_shape: str,
    return_debug: bool = False,
):
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
    raw_text = None
    if parsed is None:
        raw_text = _extract_completion_text(response)
        if return_shape == "table":
            data = json.loads(_extract_json_array_from_text(raw_text))
            if not isinstance(data, list):
                data = [data] if isinstance(data, dict) else []
            parsed = response_model.model_validate({"rows": data})
        else:
            data = json.loads(_extract_json_from_text(raw_text))
            parsed = response_model.model_validate(data)
    obj = parsed
    out = obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
    debug = {
        "path": "litellm_native",
        "raw_response": _debug_jsonable(response),
        "raw_text": raw_text,
    }
    return (out, debug) if return_debug else out


def _run_structured_via_langchain(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: Any,
    response_model: type,
    max_tokens: int,
    return_debug: bool = False,
):
    chat_model = build_langchain_chat_model(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        max_tokens=max_tokens,
    )
    structured_model = _build_langchain_structured_runnable(
        provider=provider,
        chat_model=chat_model,
        response_model=response_model,
        base_url=base_url,
        include_raw=return_debug,
    )
    obj = _retry_invoke(lambda: structured_model.invoke([{"role": "user", "content": prompt}] if isinstance(prompt, list) else prompt))
    debug = {"path": "langchain_structured", "raw_response": None, "raw_text": None}
    if return_debug:
        parsing_error = obj.get("parsing_error") if isinstance(obj, dict) else None
        if parsing_error:
            raise parsing_error
        raw_obj = obj.get("raw") if isinstance(obj, dict) else None
        parsed_obj = obj.get("parsed") if isinstance(obj, dict) else None
        debug["raw_response"] = _debug_jsonable(raw_obj)
        debug["raw_text"] = _message_content_to_text(getattr(raw_obj, "content", None))
        obj = parsed_obj
    if obj is None:
        raise ValueError("LangChain structured output returned no data")
    if hasattr(obj, "model_dump"):
        out = obj.model_dump()
        return (out, debug) if return_debug else out
    if hasattr(obj, "dict"):
        out = obj.dict()
        return (out, debug) if return_debug else out
    if isinstance(obj, dict):
        return (obj, debug) if return_debug else obj
    raise TypeError(f"Unexpected structured output type: {type(obj).__name__}")


def _should_use_langchain_structured(provider: str) -> bool:
    provider_id = (provider or "").strip().lower()
    return provider_id in ("", "openai", "anthropic", "google", "gemini", "deepseek")


def _should_fallback_to_prompt_json(error: Exception) -> bool:
    err_msg = (getattr(error, "message", None) or str(error)).lower()
    return any(
        token in err_msg
        for token in (
            "structured output",
            "with_structured_output",
            "response_format",
            "json_schema",
            "json mode",
            "function_calling",
            "tool calling",
            "tool_choice",
            "unavailable",
            "not supported",
            "invalid_request_error",
            "does not support",
            "unsupported",
            "no module named 'langchain_",
            "cannot import name",
        )
    )


def _run_structured_fallback(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: Any,
    response_model: type,
    max_tokens: int,
    return_shape: str = "single",
    return_debug: bool = False,
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
        full_prompt = prompt + [{"type": "text", "text": instruction}] if isinstance(prompt, list) else prompt + instruction
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
        out = obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
        debug = {"path": "prompt_json_fallback", "raw_response": None, "raw_text": text}
        return (out, debug) if return_debug else out
    # single
    instruction = (
        "\n\nRespond with a single valid JSON object that conforms to the following schema. "
        "Return only the JSON, no other text or markdown.\nSchema:\n"
        + json.dumps(schema, ensure_ascii=False, indent=2)
    )
    full_prompt = prompt + [{"type": "text", "text": instruction}] if isinstance(prompt, list) else prompt + instruction
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
    out = obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
    debug = {"path": "prompt_json_fallback", "raw_response": None, "raw_text": text}
    return (out, debug) if return_debug else out


def run_structured(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: Any,
    response_model: type,
    max_tokens: int = 8192,
    return_shape: str = "single",
    return_debug: bool = False,
):
    """
    Call LLM with structured output (Pydantic model).
    Returns (result_dict | result_list, used_fallback: bool), and when return_debug=True
    also returns a third item with raw-response debug information.
    return_shape: 'single' -> one object per prompt; 'table' -> one array of objects per prompt (response_model must have "rows" field).
    If the provider does not support native structured output, falls back to prompt + JSON parse.
    """
    try:
        if _should_use_langchain_structured(provider):
            result = _run_structured_via_langchain(
                provider=provider,
                model=model,
                api_key=api_key,
                base_url=base_url,
                prompt=prompt,
                response_model=response_model,
                max_tokens=max_tokens,
                return_debug=return_debug,
            )
        else:
            result = _run_structured_via_litellm(
                provider=provider,
                model=model,
                api_key=api_key,
                base_url=base_url,
                prompt=prompt,
                response_model=response_model,
                max_tokens=max_tokens,
                return_shape=return_shape,
                return_debug=return_debug,
            )
        if return_debug:
            out, debug = result
            return (out, False, debug)
        return (result, False)
    except Exception as e:
        if _should_fallback_to_prompt_json(e):
            result = _run_structured_fallback(
                provider=provider,
                model=model,
                api_key=api_key,
                base_url=base_url,
                prompt=prompt,
                response_model=response_model,
                max_tokens=max_tokens,
                return_shape=return_shape,
                return_debug=return_debug,
            )
            if return_debug:
                out, debug = result
                return (out, True, debug)
            return (result, True)
        raise
