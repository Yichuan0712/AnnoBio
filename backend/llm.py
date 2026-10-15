"""
LLM client via LiteLLM. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).

Default path is OpenAI-compatible (optionally with a custom base_url). A few
providers still need explicit routing hints so LiteLLM can call their native
APIs directly.
"""

import json
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
    resolved_api_key = api_key
    kwargs: dict[str, Any] = {}
    if provider_id in ("bedrock", "amazon-bedrock"):
        # litellm's bedrock client treats `api_key` as the AWS_BEARER_TOKEN_BEDROCK value
        # directly (falling back to that env var only when api_key is None) — passed explicitly
        # per-call here rather than as a process-wide env var, since a shared backend process
        # would otherwise have one request's Bedrock call clobber another's concurrently
        # in-flight credentials.
        raw = (api_key or "").strip()
        if "=" in raw:
            raw = raw.split("=", 1)[-1].strip()
        resolved_api_key = raw
        kwargs["aws_region_name"] = "us-east-1"
    kwargs.update({
        "model": _resolve_model_name(provider_id, model),
        "api_key": resolved_api_key,
        "max_tokens": max_tokens,
    })
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


def _normalize_tool_messages(messages: list[dict]) -> list[dict]:
    """OpenAI-format messages for a tool-calling conversation. Unlike _normalize_messages this keeps
    assistant `tool_calls` and tool-result `tool_call_id`, which LiteLLM translates per provider."""
    out: list[dict] = []
    for m in messages:
        role = str(m.get("role") or "user").lower()
        if role == "tool":
            out.append({
                "role": "tool",
                "tool_call_id": str(m.get("tool_call_id") or ""),
                "content": str(m.get("content") or ""),
            })
            continue
        message: dict[str, Any] = {"role": role, "content": m.get("content") or ""}
        if role == "assistant" and m.get("tool_calls"):
            message["tool_calls"] = [
                {
                    "id": str(call.get("id") or ""),
                    "type": "function",
                    "function": {
                        "name": str((call.get("function") or {}).get("name") or ""),
                        "arguments": str((call.get("function") or {}).get("arguments") or "{}"),
                    },
                }
                for call in m["tool_calls"]
            ]
            # Several providers reject an empty-string content next to tool_calls.
            if not message["content"]:
                message["content"] = None
        out.append(message)
    return out


def stream_chat_with_tools(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    messages: list[dict],
    tools: list[dict],
    max_tokens: int,
    max_retries: int = 3,
):
    """
    Stream one assistant response from a tool-calling conversation. Yields event dicts:
      {"type": "text", "delta": str}
      {"type": "tool_calls", "tool_calls": [{"id", "name", "arguments"}]}  (once, fully assembled)
      {"type": "done", "finish_reason": str}
    Transient errors are retried only until the first chunk arrives, so a retry never repeats
    output the caller has already received. Raises on failure.
    """
    kwargs = _make_completion_kwargs(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        max_tokens=max_tokens,
    )
    kwargs["messages"] = _normalize_tool_messages(messages)
    if tools:
        kwargs["tools"] = tools
    kwargs["stream"] = True

    def open_stream():
        stream = completion(**kwargs)
        iterator = iter(stream)
        first = next(iterator, None)
        return first, iterator

    first, iterator = _retry_invoke(open_stream, max_retries=max_retries)

    tool_calls: dict[int, dict[str, str]] = {}
    finish_reason = ""

    def chunks():
        if first is not None:
            yield first
        yield from iterator

    for chunk in chunks():
        choices = getattr(chunk, "choices", None) or []
        if not choices:
            continue
        choice = choices[0]
        if getattr(choice, "finish_reason", None):
            finish_reason = str(choice.finish_reason)
        delta = getattr(choice, "delta", None)
        if delta is None:
            continue
        text = getattr(delta, "content", None)
        if text:
            yield {"type": "text", "delta": _message_content_to_text(text)}
        for call in getattr(delta, "tool_calls", None) or []:
            index = getattr(call, "index", None)
            if index is None:
                index = len(tool_calls)
            slot = tool_calls.setdefault(int(index), {"id": "", "name": "", "arguments": ""})
            if getattr(call, "id", None):
                slot["id"] = str(call.id)
            function = getattr(call, "function", None)
            if function is not None:
                if getattr(function, "name", None):
                    slot["name"] = str(function.name)
                if getattr(function, "arguments", None):
                    slot["arguments"] += str(function.arguments)

    if tool_calls:
        assembled = []
        for index in sorted(tool_calls):
            slot = tool_calls[index]
            if not slot["name"]:
                continue
            assembled.append({
                "id": slot["id"] or f"call_{index}_{int(time.time() * 1000)}",
                "name": slot["name"],
                "arguments": slot["arguments"] or "{}",
            })
        if assembled:
            yield {"type": "tool_calls", "tool_calls": assembled}
    yield {"type": "done", "finish_reason": finish_reason}


_TOOLS_UNSUPPORTED_MARKERS = (
    "does not support tools",
    "does not support tool",
    "tool use is not supported",
    "tools are not supported",
    "tool calling is not supported",
    "function calling is not supported",
    "does not support function",
    "no endpoints found that support tool use",
    "tool_choice",
    "tools is not supported",
    "unsupported parameter: 'tools'",
)


def is_tools_unsupported_error(error: Exception | str) -> bool:
    """True when a provider error says the model cannot take `tools` (as opposed to auth, quota...)."""
    text = (getattr(error, "message", None) or str(error)).lower()
    return any(marker in text for marker in _TOOLS_UNSUPPORTED_MARKERS)


def probe_tool_calling(*, provider: str, model: str, api_key: str, base_url: str) -> dict[str, Any]:
    """
    Check for real whether this model calls tools, which the Agent depends on: offer one tool and ask
    for it to be called. Registries (LiteLLM's, OpenRouter's) only hint at this, and say nothing about
    custom endpoints. Returns {"ok": True | False | None, "detail": str}; None means the check itself
    failed (auth, network, quota) and says nothing about tool support.
    """
    kwargs = _make_completion_kwargs(
        provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=2048,
    )
    kwargs["messages"] = [
        {"role": "system", "content": "You are testing a tool. Respond only by calling the provided tool."},
        {"role": "user", "content": "Call the ping tool with message set to \"ready\"."},
    ]
    kwargs["tools"] = [{
        "type": "function",
        "function": {
            "name": "ping",
            "description": "Replies pong.",
            "parameters": {
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
            },
        },
    }]
    try:
        response = _retry_invoke(lambda: completion(**kwargs), max_retries=1)
    except Exception as e:
        if is_tools_unsupported_error(e):
            return {"ok": False, "detail": f"The provider rejected tool calling for this model: {e}"}
        return {"ok": None, "detail": f"The check could not reach the model: {e}"}
    choices = getattr(response, "choices", None) or []
    message = getattr(choices[0], "message", None) if choices else None
    calls = getattr(message, "tool_calls", None) or []
    if any(getattr(getattr(call, "function", None), "name", "") == "ping" for call in calls):
        return {"ok": True, "detail": "The model called the test tool."}
    text = _extract_completion_text(response)
    return {
        "ok": False,
        "detail": "The model answered in text instead of calling the test tool, so it cannot drive the Agent's tools"
        + (f" (it replied: {text[:120]})" if text else "") + ".",
    }


def _first_json_value(text: str, opener: str) -> str | None:
    """The JSON value starting at the first `opener`, ended by the JSON parser itself, so a bracket
    inside a string does not end it early. When it never completes, the rest of the text, so that
    parsing it reports why."""
    start = text.find(opener)
    if start == -1:
        return None
    try:
        _, end = json.JSONDecoder().raw_decode(text, start)
    except ValueError:
        return text[start:]
    return text[start:end]


def _extract_json_from_text(text: str) -> str:
    """Extract a JSON object from text that may be wrapped in <reasoning>, markdown, etc."""
    text = text.strip()
    # Prefer markdown code block
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    found = _first_json_value(text, "{")
    return text if found is None else found


def _extract_json_array_from_text(text: str) -> str:
    """Extract a JSON array from text (markdown code block or first [...])."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    found = _first_json_value(text, "[")
    return "[]" if found is None else found


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


def _prompt_json_reply(*, provider: str, model: str, api_key: str, base_url: str, prompt: Any, max_tokens: int) -> str:
    """The reply to a prompt that asks for JSON. A reply cut off at max tokens is an error: its JSON is
    incomplete, and reasoning models spend part of that budget thinking."""
    response = _call_completion(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
    )
    choices = getattr(response, "choices", None) or []
    if choices and str(getattr(choices[0], "finish_reason", "") or "") == "length":
        raise ValueError(
            f"The model's reply reached the max tokens limit ({max_tokens}) before its JSON was complete. "
            "Raise Max tokens in Settings."
        )
    return _extract_completion_text(response)


def _coerce_prompt_json_strings(data: Any, properties: dict) -> None:
    """A reply to a prompt that asks for JSON is not held to the schema, so a string field may come
    back null, true/false or a number; store those as text."""
    if not isinstance(data, dict):
        return
    for key, prop in properties.items():
        if prop.get("type") != "string":
            continue
        value = data.get(key)
        if value is None:
            data[key] = ""
        elif isinstance(value, bool):
            data[key] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            data[key] = str(value)


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
        text = _prompt_json_reply(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            prompt=full_prompt,
            max_tokens=max_tokens,
        )
        json_str = _extract_json_array_from_text(text)
        data = json.loads(json_str)
        if not isinstance(data, list):
            data = [data] if isinstance(data, dict) else []
        item_props = item_schema.get("properties", {})
        for row in data:
            _coerce_prompt_json_strings(row, item_props)
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
    text = _prompt_json_reply(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        prompt=full_prompt,
        max_tokens=max_tokens,
    )
    json_str = _extract_json_from_text(text)
    data = json.loads(json_str)
    _coerce_prompt_json_strings(data, schema.get("properties", {}))
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
