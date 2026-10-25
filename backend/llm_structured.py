"""
Structured output from any chat-completions model, in whichever of four ways the model accepts.

A model is asked for JSON matching a schema in the first of these modes it accepts:

  json_schema  response_format json_schema (strict); the provider enforces the schema
  tool         one forced tool call whose parameters are the schema
  json_object  response_format json_object plus the schema in the prompt; valid JSON, schema not enforced
  prompt       the schema in the prompt only

A mode the provider rejects (a "capability" error, see classify_error) moves on to the next one; any
other error is raised as it is, so an outage or a bad key is never mistaken for a missing feature. A
reply that fails to parse or validate gets one correction turn in the same mode before it counts as
an error. A reply cut off at max tokens is always an error: its JSON is incomplete.

This module uses only the standard library and talks to no provider itself: the caller passes `send`,
which takes an OpenAI-format request and returns an OpenAI-format response (an object or a dict).
That keeps it usable both by the backend (LiteLLM) and, copied verbatim, by exported pipelines.
"""

from __future__ import annotations

import copy
import json
import re
import threading
from typing import Any, Callable

MODES = ("json_schema", "tool", "json_object", "prompt")
TOOL_NAME = "submit_output"


class TruncatedReply(ValueError):
    """The reply stopped at max tokens, so its JSON is incomplete."""


class StructuredOutputError(ValueError):
    """The reply still did not parse or validate after the correction turn. `ignored` is True when
    neither reply held any JSON: the endpoint accepted the mode's parameters but ignored them."""

    def __init__(self, message: str, *, ignored: bool = False):
        super().__init__(message)
        self.ignored = ignored


class NoJsonReply(ValueError):
    """The reply held no JSON value at all."""


# ---------- reading replies ----------


def _get(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def content_text(content: Any) -> str:
    """The text of a message's content, whether a string, a list of content blocks or a dict."""
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


def first_json_value(text: str, opener: str) -> str | None:
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


def extract_json_object(text: str) -> str:
    """A JSON object from text that may be wrapped in <reasoning>, markdown, etc."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    found = first_json_value(text, "{")
    return text if found is None else found


def extract_json_array(text: str) -> str:
    """A JSON array from text (markdown code block or first [...])."""
    text = text.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if m:
        return m.group(1).strip()
    found = first_json_value(text, "[")
    return "[]" if found is None else found


def parse_reply(value: Any, array_key: str | None = None) -> Any:
    """The JSON value of a reply. With `array_key` (a table: {array_key: [rows]}), a bare array or a
    single unwrapped row is accepted and wrapped."""
    if isinstance(value, (dict, list)):
        data = value
    else:
        text = str(value or "").strip()
        m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
        if m:
            text = m.group(1).strip()
        openers = [i for i in (text.find("{"), text.find("[") if array_key else -1) if i != -1]
        if not openers:
            raise NoJsonReply("The reply contained no JSON." + (f" It said: {text[:200]}" if text else ""))
        found = first_json_value(text, text[min(openers)])
        data = json.loads(found)
    if array_key:
        if isinstance(data, list):
            data = {array_key: data}
        elif isinstance(data, dict) and array_key not in data:
            data = {array_key: [data]}
    return data


def read_reply(mode: str, response: Any) -> tuple[Any, str, str]:
    """(value, raw text, finish_reason) of a response: the tool call's arguments in tool mode, else the
    message content (or a provider's already-parsed object)."""
    choices = _get(response, "choices") or []
    if not choices:
        return "", "", ""
    choice = choices[0]
    finish = str(_get(choice, "finish_reason") or "")
    message = _get(choice, "message") or {}
    if mode == "tool":
        calls = _get(message, "tool_calls") or []
        chosen = next((c for c in calls if _get(_get(c, "function"), "name") == TOOL_NAME), calls[0] if calls else None)
        if chosen is not None:
            arguments = _get(_get(chosen, "function"), "arguments")
            if isinstance(arguments, (dict, list)):
                return arguments, json.dumps(arguments, ensure_ascii=False), finish
            return str(arguments or ""), str(arguments or ""), finish
    parsed = _get(message, "parsed")
    text = content_text(_get(message, "content")).strip()
    if parsed is not None:
        if hasattr(parsed, "model_dump"):
            parsed = parsed.model_dump()
        if isinstance(parsed, (dict, list)):
            return parsed, text, finish
    return text, text, finish


# ---------- building requests ----------


def _drop_defaults(node: Any) -> Any:
    """The schema without "default" keywords, which strict json_schema validators reject. Walks schema
    positions only, so a property that is itself named "default" is kept."""
    if not isinstance(node, dict):
        return node
    out = {k: v for k, v in node.items() if k != "default"}
    if isinstance(out.get("properties"), dict):
        out["properties"] = {name: _drop_defaults(sub) for name, sub in out["properties"].items()}
    for key in ("$defs", "definitions"):
        if isinstance(out.get(key), dict):
            out[key] = {name: _drop_defaults(sub) for name, sub in out[key].items()}
    for key in ("items", "additionalProperties", "not"):
        if isinstance(out.get(key), dict):
            out[key] = _drop_defaults(out[key])
    for key in ("anyOf", "oneOf", "allOf", "prefixItems"):
        if isinstance(out.get(key), list):
            out[key] = [_drop_defaults(sub) for sub in out[key]]
    return out


def inline_refs(schema: dict) -> dict:
    """The schema with every local "#/$defs/..." reference replaced by its definition, for tools and
    prompts, which do not all resolve references."""
    defs = {**(schema.get("definitions") or {}), **(schema.get("$defs") or {})}

    def resolve(node: Any, depth: int) -> Any:
        if isinstance(node, list):
            return [resolve(item, depth) for item in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and depth < 32:
            name = ref.rsplit("/", 1)[-1]
            if name in defs:
                merged = {**defs[name], **{k: v for k, v in node.items() if k != "$ref"}}
                return resolve(merged, depth + 1)
        return {k: resolve(v, depth) for k, v in node.items() if k not in ("$defs", "definitions")}

    return resolve(copy.deepcopy(schema), 0)


def schema_instruction(schema: dict) -> str:
    return (
        "\n\nRespond with only one valid JSON object that conforms to the following JSON Schema, "
        "with no other text or markdown.\nJSON Schema:\n"
        + json.dumps(inline_refs(schema), ensure_ascii=False, indent=2)
    )


def _with_text_appended(messages: list[dict], text: str) -> list[dict]:
    """A copy of messages with text added to the last user message; content blocks (images, PDFs)
    are kept as they are and the text goes in a block of its own."""
    out = [dict(m) for m in messages]
    for message in reversed(out):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                message["content"] = [*content, {"type": "text", "text": text}]
            else:
                message["content"] = content_text(content) + text
            return out
    out.append({"role": "user", "content": text.lstrip()})
    return out


def _schema_name(schema: dict) -> str:
    name = re.sub(r"[^A-Za-z0-9_-]", "_", str(schema.get("title") or "structured_output"))
    return name[:64] or "structured_output"


def build_request(mode: str, messages: list[dict], schema: dict) -> dict:
    """The request fields for one mode: messages plus the mode's response_format or tools."""
    if mode == "json_schema":
        return {
            "messages": messages,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": _schema_name(schema), "strict": True, "schema": _drop_defaults(schema)},
            },
        }
    if mode == "tool":
        return {
            "messages": messages,
            "tools": [{
                "type": "function",
                "function": {
                    "name": TOOL_NAME,
                    "description": "Submit the answer as structured data.",
                    "parameters": inline_refs(schema),
                },
            }],
            "tool_choice": {"type": "function", "function": {"name": TOOL_NAME}},
        }
    if mode == "json_object":
        return {
            "messages": _with_text_appended(messages, schema_instruction(schema)),
            "response_format": {"type": "json_object"},
        }
    if mode == "prompt":
        return {"messages": _with_text_appended(messages, schema_instruction(schema))}
    raise ValueError(f"Unknown structured output mode: {mode}")


# ---------- errors ----------

# Errors about the input itself are never a reason to try another mode: switching would not help,
# and the prompt-only modes must not be reached by dropping an image the model refused. Phrases, not
# single words, so a model named "...-vision" is not mistaken for an image error.
_INPUT_ERROR_MARKERS = (
    "image input", "image content", "image_url", "images are not", "vision is not", "pdf input",
    "file input", "file_data", "context length", "context window", "maximum context", "too long",
    "too many tokens",
)
# A rejection counts only when it names one of the features the modes differ in; "not supported" alone
# is also what "User location is not supported" or "The model `x` is not supported" say.
_FEATURE_MARKERS = (
    "response_format", "response format", "json_schema", "json schema", "json_object", "json mode",
    "structured output", "tool_choice", "tools", "tool use", "tool call", "function call", "function_call",
    "functions",
)


def classify_error(exc: BaseException) -> str:
    """"capability" when the provider rejected this way of asking for structured output, so the next
    mode may work; "fatal" for everything else (auth, quota, rate limit, outage, bad input)."""
    name = type(exc).__name__
    status = _get(exc, "status_code")
    text = str(_get(exc, "message") or exc).lower()
    if name == "UnsupportedParamsError":
        return "capability"  # LiteLLM itself refused a parameter of this mode before sending
    if any(marker in text for marker in _INPUT_ERROR_MARKERS):
        return "fatal"
    # OpenRouter answers 404 "No endpoints found that support ..." when no route takes a parameter of
    # this mode (but "No endpoints found matching your data policy" is about the account).
    if status == 404 and "no endpoints found that support" in text:
        return "capability"
    rejected = status in (400, 422) or (status is None and name == "BadRequestError")
    if rejected and any(marker in text for marker in _FEATURE_MARKERS):
        return "capability"
    return "fatal"


# ---------- remembering what works ----------


class ModeMemory:
    """The mode that works for each model (keyed by the caller), so later calls start there instead of
    failing through the modes again. A run only ever lowers a model's mode; `set` (from a check made
    on purpose) may also raise it. `on_change(key, mode, detail)` is told when a run changes it."""

    def __init__(self, on_change: Callable[[Any, str, str], None] | None = None):
        self._lock = threading.Lock()
        self._modes: dict[Any, str] = {}
        self.on_change = on_change

    def get(self, key: Any) -> str | None:
        with self._lock:
            return self._modes.get(key)

    def set(self, key: Any, mode: str | None) -> None:
        with self._lock:
            if mode in MODES:
                self._modes[key] = mode
            else:
                self._modes.pop(key, None)

    def learn(self, key: Any, mode: str, detail: str = "") -> None:
        # on_change runs under the lock, so two runs lowering the same model report in the order
        # they changed it; changes are rare (a model's first use, or a mode rejected).
        with self._lock:
            current = self._modes.get(key)
            if current is not None and MODES.index(mode) <= MODES.index(current):
                return
            self._modes[key] = mode
            if self.on_change is not None:
                try:
                    self.on_change(key, mode, detail)
                except Exception:
                    pass  # remembering is best effort; the call itself succeeded


# ---------- running ----------


def _correction_request(mode: str, request: dict, raw_text: str, error: Exception) -> dict:
    retry = "Call the tool again with corrected arguments." if mode == "tool" else "Reply again with only the corrected JSON."
    messages = [
        *request["messages"],
        {"role": "assistant", "content": raw_text or "(empty reply)"},
        {"role": "user", "content": f"Your reply could not be used: {error}. {retry}"},
    ]
    return {**request, "messages": messages}


def _truncated(max_tokens: int | None) -> TruncatedReply:
    limit = f" ({max_tokens})" if max_tokens else ""
    return TruncatedReply(
        f"The model's reply reached the max tokens limit{limit} before its JSON was complete. "
        "Raise Max tokens in Settings."
    )


def run(
    send: Callable[[dict], Any],
    *,
    messages: list[dict],
    schema: dict,
    validate: Callable[[Any], Any],
    start_mode: str | None = None,
    array_key: str | None = None,
    max_tokens: int | None = None,
    probe: bool = False,
) -> dict:
    """
    Ask for structured output, starting at `start_mode` (default: the first mode) and moving down
    while the provider rejects the mode. `validate(data)` returns the result or raises; its error
    text is shown to the model in the correction turn. With probe=True (checking a model on
    purpose), a reply that still fails validation also moves on to the next mode, which finds
    endpoints that accept a mode's parameters but ignore them.

    Returns {"output", "mode", "repaired", "response", "raw_text", "tried": [{"mode", "error"}]}.
    """
    start = MODES.index(start_mode) if start_mode in MODES else 0
    tried: list[dict] = []
    for mode in MODES[start:]:
        request = build_request(mode, messages, schema)
        try:
            response = send(request)
        except Exception as e:
            if classify_error(e) == "capability" and mode != MODES[-1]:
                tried.append({"mode": mode, "error": str(e)[:500]})
                continue
            raise
        try:
            output, raw_text, repaired, response = _validated(
                send, mode, request, response, validate, array_key, max_tokens,
            )
        except StructuredOutputError as e:
            # A model checked on purpose must follow the mode; a run moves on only from a mode
            # whose replies held no JSON at all, never from one row the model answered wrongly.
            if (probe or e.ignored) and mode != MODES[-1]:
                tried.append({"mode": mode, "error": str(e)[:500]})
                continue
            raise
        return {
            "output": output, "mode": mode, "repaired": repaired,
            "response": response, "raw_text": raw_text, "tried": tried,
        }
    raise StructuredOutputError("No structured output mode worked.")  # unreachable: the last mode raises


def _validated(send, mode, request, response, validate, array_key, max_tokens):
    """(output, raw text, repaired, response): validate the reply, with one correction turn."""
    _refuse_on_refusal(response)
    value, raw_text, finish = read_reply(mode, response)
    if finish == "length":
        raise _truncated(max_tokens)
    try:
        return validate(parse_reply(value, array_key)), raw_text, False, response
    except Exception as first_error:
        correction = _correction_request(mode, request, raw_text, first_error)
        first_had_json = not isinstance(first_error, NoJsonReply)
    response = send(correction)
    _refuse_on_refusal(response)
    value, raw_text, finish = read_reply(mode, response)
    if finish == "length":
        raise _truncated(max_tokens)
    try:
        return validate(parse_reply(value, array_key)), raw_text, True, response
    except Exception as e:
        raise StructuredOutputError(
            f"The model's reply did not match the expected output: {e}",
            ignored=not first_had_json and isinstance(e, NoJsonReply),
        ) from e


def _refuse_on_refusal(response: Any) -> None:
    """A refusal (OpenAI's message.refusal) is the model's answer, not a sign the mode is unsupported."""
    choices = _get(response, "choices") or []
    refusal = _get(_get(choices[0], "message") or {}, "refusal") if choices else None
    if refusal:
        raise StructuredOutputError(f"The model refused: {refusal}")
