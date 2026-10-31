"""
LLM client via LiteLLM. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).

Default path is OpenAI-compatible (optionally with a custom base_url). A few
providers still need explicit routing hints so LiteLLM can call their native
APIs directly. Structured output goes through llm_structured.py, which picks
the first of its four modes the model accepts and remembers it per model.
"""

import json
import re
import threading
import time
from typing import Any

import litellm
from litellm import completion
from litellm.utils import type_to_response_format_param

import llm_structured as structured
from safe_stdio import safe_print

# ANSI: bold yellow for step names (match main.py)
_HL = "\033[1;33m"
_R = "\033[0m"
_SEP = "=" * 60

litellm.telemetry = False
# LiteLLM prints "Give Feedback" / "Provider List" banners on every error, including the expected
# rejections in supported_run_params' offline checks; the errors themselves are still raised.
litellm.suppress_debug_info = True

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


_RETRYABLE_ERRORS = (
    litellm.RateLimitError,
    litellm.Timeout,
    litellm.APIConnectionError,
    litellm.ServiceUnavailableError,
    litellm.InternalServerError,
)


class HostedModelError(RuntimeError):
    """A refusal from the web app's free-model gateway (hub/hosted_model.py), such as a used-up
    daily allowance. Carries the gateway's own sentence, written for the user, instead of LiteLLM's
    "litellm.RateLimitError: RateLimitError: OpenAIException - " wrapping. Never retried."""


# Every gateway refusal names "the free model" or "free allowance", or carries the
# free_quota_exhausted code (hub/hosted_model.py).
_HOSTED_REFUSAL = re.compile(r"free_quota_exhausted|free (?:token )?(?:model|allowance)", re.IGNORECASE)
_LITELLM_PREFIX = re.compile(r"^(?:litellm\.\w+:\s*)?(?:\w+Error:\s*)?(?:\w+Exception\s*-\s*)?")


def _hosted_model_error(e: Exception) -> HostedModelError | None:
    if isinstance(e, HostedModelError):
        return e
    text = str(e)
    if not _HOSTED_REFUSAL.search(text):
        return None
    message = _LITELLM_PREFIX.sub("", text, count=1).strip()
    try:
        message = json.loads(message)["error"]["message"]
    except (ValueError, TypeError, KeyError):
        pass
    return HostedModelError(message)


def _is_retryable_error(e: Exception) -> bool:
    """True if error is transient (429, timeout, connection, 5xx), by LiteLLM's exception type or the
    status code, never by words in the message (a model's own text can contain "rate" or "timeout")."""
    if _hosted_model_error(e):
        return False
    if isinstance(e, _RETRYABLE_ERRORS):
        return True
    return getattr(e, "status_code", None) in (429, 500, 502, 503, 504)


def _retry_invoke(fn, max_retries: int = 3):
    """Retry fn() on retryable errors with exponential backoff (1s, 2s, 4s)."""
    last_e = None
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:
            hosted = _hosted_model_error(e)
            if hosted is not None:
                raise hosted from e
            last_e = e
            if attempt < max_retries and _is_retryable_error(e):
                delay = 1.0 * (2**attempt)
                safe_print(_HL + f"[LLM] Retry {attempt + 1}/{max_retries} after {delay:.0f}s: " + _R + str(e), flush=True)
                time.sleep(delay)
            else:
                raise
    raise last_e


# LiteLLM's adapters for these providers turn a content list into its text (DeepSeek's API reads text
# only), so image and PDF blocks would vanish and the model answer without them. Refuse instead.
_TEXT_ONLY_LITELLM_PROVIDERS = {"deepseek": "DeepSeek"}


def _refuse_dropped_attachments(kwargs: dict) -> None:
    prefix = str(kwargs.get("model") or "").split("/", 1)[0].lower()
    label = _TEXT_ONLY_LITELLM_PROVIDERS.get(prefix)
    if not label:
        return
    for message in kwargs.get("messages") or []:
        content = message.get("content")
        if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") not in (None, "text") for b in content):
            raise ValueError(
                f"{label}'s API reads text only, so the images or PDFs in this prompt would be dropped. "
                "Choose a model that reads them."
            )


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


_message_content_to_text = structured.content_text


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
    _refuse_dropped_attachments(kwargs)
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


def _normalize_tool_messages(messages: list[dict], include_reasoning: bool = False) -> list[dict]:
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
        if include_reasoning and role == "assistant" and m.get("reasoning_content") is not None:
            message["reasoning_content"] = m["reasoning_content"]
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
    kwargs["messages"] = _normalize_tool_messages(messages, include_reasoning=(provider == "deepseek" or "deepseek" in model.lower() or "/internal/hosted-model/" in base_url))
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
        reasoning = getattr(delta, "reasoning_content", None)
        if reasoning:
            yield {"type": "reasoning", "delta": str(reasoning)}
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


# JSON helpers live in llm_structured.py; these names stay for the modules that import them from here.
_first_json_value = structured.first_json_value
_extract_json_from_text = structured.extract_json_object
_extract_json_array_from_text = structured.extract_json_array


def structured_mode_key(provider: str, model: str, base_url: str) -> tuple[str, str, str]:
    """Which model a remembered structured-output mode belongs to: the same provider, routed model
    name and endpoint, however the credential spelled them."""
    provider_id = (provider or "").strip().lower()
    return (provider_id, _resolve_model_name(provider_id, model), _resolve_base_url(provider_id, base_url))


# The mode that works for each model (llm_structured.ModeMemory), found by runs and kept on the
# credentials: main.py seeds it from them at startup and sets on_change to store what runs find.
structured_modes = structured.ModeMemory()


def remember_structured_mode(provider: str, model: str, base_url: str, mode: str | None) -> None:
    """Set a model's mode from what its credential has stored."""
    structured_modes.set(structured_mode_key(provider, model, base_url), mode)


def _coerce_prompt_json_strings(data: Any, properties: dict) -> None:
    """A reply in a mode that does not enforce the schema may put null, true/false or a number in a
    string field; store those as text. A missing field stays missing, so validation catches it and
    the model is asked to correct it."""
    if not isinstance(data, dict):
        return
    for key, prop in properties.items():
        if prop.get("type") != "string" or key not in data:
            continue
        value = data[key]
        if value is None:
            data[key] = ""
        elif isinstance(value, bool):
            data[key] = "true" if value else "false"
        elif isinstance(value, (int, float)):
            data[key] = str(value)


def _response_validator(response_model: type, schema: dict, array_key: str | None):
    """validate(data) for llm_structured.run: scalar-to-text coercion of string fields, then the
    Pydantic model; returns the plain dict."""
    flat = structured.inline_refs(schema)
    if array_key:
        row_properties = ((flat.get("properties") or {}).get(array_key) or {}).get("items", {}).get("properties", {})
    else:
        row_properties = flat.get("properties") or {}

    def validate(data: Any) -> dict:
        rows = (data.get(array_key) if isinstance(data, dict) else None) if array_key else [data]
        for row in rows or []:
            _coerce_prompt_json_strings(row, row_properties)
        obj = response_model.model_validate(data)
        return obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()

    return validate


# Generation parameters (model_params.py) a model's provider rejected, by structured_mode_key: they
# are left out of its later calls instead of failing each one. Not stored; a restart tries them again.
_rejected_params: dict[tuple[str, str, str], set[str]] = {}
_rejected_params_lock = threading.Lock()


def _rejected_param(error: Exception, sent: dict) -> str | None:
    """The generation parameter this error says the provider does not take, if it names one."""
    status = getattr(error, "status_code", None)
    if type(error).__name__ != "UnsupportedParamsError" and status not in (400, 422):
        return None
    text = (getattr(error, "message", None) or str(error)).lower()
    return next((name for name in sent if name in text), None)


def _structured_call(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    prompt: Any,
    response_model: type,
    max_tokens: int,
    return_shape: str,
    structured_mode: str | None,
    params: dict | None = None,
    max_retries: int = 3,
) -> dict:
    base_kwargs = _make_completion_kwargs(
        provider=provider, model=model, api_key=api_key, base_url=base_url, max_tokens=max_tokens,
    )
    key = structured_mode_key(provider, model, base_url)

    def send(request: dict) -> Any:
        while True:
            with _rejected_params_lock:
                rejected = set(_rejected_params.get(key, ()))
            sent = {name: value for name, value in (params or {}).items() if name not in rejected}
            kwargs = {**base_kwargs, **sent, **request, "messages": _normalize_messages(request["messages"])}
            _refuse_dropped_attachments(kwargs)
            try:
                return _retry_invoke(lambda: completion(**kwargs), max_retries=max_retries)
            except Exception as e:
                name = _rejected_param(e, sent)
                if name is None:
                    raise
                with _rejected_params_lock:
                    _rejected_params.setdefault(key, set()).add(name)
                safe_print(_HL + f"[LLM] {key[1]} does not take {name}; left out from now on: " + _R + str(e)[:300], flush=True)

    schema = type_to_response_format_param(response_model)["json_schema"]["schema"]
    array_key = "rows" if return_shape == "table" else None
    return structured.run(
        send,
        messages=[{"role": "user", "content": prompt}],
        schema=schema,
        validate=_response_validator(response_model, schema, array_key),
        start_mode=structured_mode,
        array_key=array_key,
        max_tokens=max_tokens,
    )


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
    structured_mode: str | None = None,
    params: dict | None = None,
):
    """
    Call LLM with structured output (Pydantic model).
    Returns (result_dict, used_fallback: bool), and when return_debug=True also returns a third item
    with the mode used and raw-response debug information.
    return_shape: 'single' -> one object per prompt; 'table' -> one array of objects per prompt
    (response_model must have a "rows" field).
    Starts at `structured_mode` when given, else at the mode remembered for this model, and moves down
    through llm_structured.MODES while the provider rejects one. used_fallback is True for the modes
    that only ask for the schema in the prompt (json_object, prompt).
    params: generation parameters (model_params.py) sent with every call; one the provider rejects is
    left out of this model's calls from then on.
    """
    key = structured_mode_key(provider, model, base_url)
    result = _structured_call(
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        prompt=prompt,
        response_model=response_model,
        max_tokens=max_tokens,
        return_shape=return_shape,
        structured_mode=structured_mode or structured_modes.get(key),
        params=params,
    )
    mode = result["mode"]
    if result["tried"]:
        rejected = "; ".join(f"{t['mode']}: {t['error'][:200]}" for t in result["tried"])
        safe_print(_HL + f"[LLM] Structured output via {mode} for {key[1]} (rejected {rejected})" + _R, flush=True)
    structured_modes.learn(key, mode, result["tried"][-1]["error"] if result["tried"] else "")
    out = result["output"]
    used_fallback = mode in ("json_object", "prompt")
    if not return_debug:
        return (out, used_fallback)
    debug = {
        "path": mode,
        "repaired": result["repaired"],
        "tried": result["tried"],
        "raw_response": _debug_jsonable(result["response"]),
        "raw_text": result["raw_text"],
    }
    return (out, used_fallback, debug)


# Parameters a provider accepts but ignores, which LiteLLM cannot tell: DeepSeek's docs say
# deepseek-reasoner takes the sampling parameters without effect, and LiteLLM turns every
# reasoning_effort for DeepSeek into the same "thinking on".
_IGNORED_PARAMS = {
    ("deepseek", "deepseek-reasoner"): {"temperature", "top_p", "presence_penalty", "frequency_penalty", "reasoning_effort"},
    ("deepseek", None): {"reasoning_effort"},
}


def supported_run_params(provider: str, model: str, base_url: str, *, openrouter_parameters: list[str] | None = None,
                         custom_endpoint: bool = False) -> list[str]:
    """
    The generation parameters (model_params.PARAM_SPECS) this model takes, found without any network
    call. Candidates come from OpenRouter's catalog for OpenRouter models (`openrouter_parameters`, its
    supported_parameters) and from LiteLLM's list for the provider otherwise; each is then tried with
    LiteLLM's mock_response, which rejects what LiteLLM knows the model refuses (gpt-5 takes no top_p and
    only temperature=1, Claude takes no seed). A custom endpoint's parameters are unknown: none.
    """
    from model_params import PARAM_SPECS

    if custom_endpoint:
        return []
    provider_id = (provider or "").strip().lower()
    kwargs = _make_completion_kwargs(provider=provider, model=model, api_key="dry-run", base_url=base_url, max_tokens=16)
    if provider_id == "openrouter":
        if openrouter_parameters is None:
            return []
        listed = set(openrouter_parameters)
        if "reasoning" in listed:
            listed.add("reasoning_effort")  # LiteLLM sends reasoning_effort, which OpenRouter maps to reasoning
        candidates = [name for name in PARAM_SPECS if name in listed]
    else:
        try:
            listed = set(litellm.get_supported_openai_params(model=kwargs["model"]) or [])
        except Exception:
            return []
        candidates = [name for name in PARAM_SPECS if name in listed]
    model_name = (model or "").strip().lower().rsplit("/", 1)[-1]
    ignored = _IGNORED_PARAMS.get((provider_id, model_name), set()) | _IGNORED_PARAMS.get((provider_id, None), set())
    supported = []
    for name in candidates:
        if name in ignored:
            continue
        try:
            completion(**kwargs, messages=[{"role": "user", "content": "x"}], mock_response="ok",
                       **{name: PARAM_SPECS[name]["probe"]})
        except Exception:
            continue
        supported.append(name)
    return supported
