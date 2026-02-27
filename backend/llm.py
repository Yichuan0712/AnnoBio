"""
LLM client via LangChain. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).
Provider-agnostic: add new providers by registering in PROVIDER_REGISTRY below.
"""

import json
import os
import re
import sys

# ANSI: bold yellow for step names (match main.py)
_HL = "\033[1;33m"
_R = "\033[0m"
_SEP = "-" * 60

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI

try:
    from langchain_aws import ChatBedrock
except ImportError:
    ChatBedrock = None

try:
    from langchain_mistralai import ChatMistralAI
except ImportError:
    ChatMistralAI = None

# ---------------------------------------------------------------------------
# Provider: OpenAI
# ---------------------------------------------------------------------------

OPENAI_MODEL_MAP = {
    "gpt-5": "gpt-5",
    "gpt-5-mini": "gpt-5-mini",
    "gpt-5-nano": "gpt-5-nano",
}


def _build_openai(model: str, api_key: str, **kwargs) -> ChatOpenAI:
    model_id = OPENAI_MODEL_MAP.get(model) or model
    return ChatOpenAI(
        model=model_id,
        api_key=api_key,
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Provider: Anthropic (Claude)
# ---------------------------------------------------------------------------

ANTHROPIC_MODEL_MAP = {
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
}


def _build_anthropic(model: str, api_key: str, **kwargs) -> ChatAnthropic:
    model_id = ANTHROPIC_MODEL_MAP.get(model) or model
    return ChatAnthropic(
        model=model_id,
        api_key=api_key,
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Provider: Google (Gemini)
# ---------------------------------------------------------------------------

GOOGLE_MODEL_MAP = {
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
}


def _build_google(model: str, api_key: str, **kwargs) -> ChatGoogleGenerativeAI:
    model_id = GOOGLE_MODEL_MAP.get(model) or model
    return ChatGoogleGenerativeAI(
        model=model_id,
        api_key=api_key,
        max_output_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Provider: DeepSeek (OpenAI-compatible API)
# ---------------------------------------------------------------------------

DEEPSEEK_MODEL_MAP = {
    "deepseek-chat": "deepseek-chat",
    "deepseek-reasoner": "deepseek-reasoner",
}

DEEPSEEK_BASE_URL = "https://api.deepseek.com"


def _build_deepseek(model: str, api_key: str, **kwargs) -> ChatOpenAI:
    model_id = DEEPSEEK_MODEL_MAP.get(model) or model
    return ChatOpenAI(
        model=model_id,
        api_key=api_key,
        base_url=DEEPSEEK_BASE_URL,
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Provider: Mistral AI
# ---------------------------------------------------------------------------

MISTRAL_MODEL_MAP = {
    "mistral-large-2512": "mistral-large-2512",
}


def _build_mistral(model: str, api_key: str, **kwargs):
    if ChatMistralAI is None:
        raise ValueError(
            "Mistral requires langchain-mistralai. Install with: pip install langchain-mistralai"
        )
    model_id = MISTRAL_MODEL_MAP.get(model) or model
    return ChatMistralAI(
        model=model_id,
        api_key=api_key,
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Provider: Amazon Bedrock
# ---------------------------------------------------------------------------
# Region 固定 us-east-1（支持最全）。API key 栏可留空（用环境变量鉴权）或填 Bearer token。

BEDROCK_MODEL_MAP = {
    "openai.gpt-oss-20b-1:0": "openai.gpt-oss-20b-1:0",
    "openai.gpt-oss-120b-1:0": "openai.gpt-oss-120b-1:0",
}


def _build_bedrock(model: str, api_key: str, **kwargs):
    if ChatBedrock is None:
        raise ValueError(
            "Amazon Bedrock requires langchain-aws. Install with: pip install langchain-aws"
        )
    model_id = BEDROCK_MODEL_MAP.get(model) or model
    raw = (api_key or "").strip()
    if raw:
        if "=" in raw:
            raw = raw.split("=", 1)[-1]
        raw = raw.strip()
        if raw:
            os.environ["AWS_BEARER_TOKEN_BEDROCK"] = raw
    return ChatBedrock(
        model_id=model_id,
        region_name="us-east-1",
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


PROVIDER_REGISTRY = {
    "openai": _build_openai,
    "anthropic": _build_anthropic,
    "google": _build_google,
    "deepseek": _build_deepseek,
    "mistral": _build_mistral,
    "bedrock": _build_bedrock,
}


def get_chat_model(provider: str, model: str, api_key: str, **kwargs):
    """
    Build a LangChain chat model for the given provider. Use for simple invoke
    or .with_structured_output(schema) when you have user-defined output schema.
    """
    if provider not in PROVIDER_REGISTRY:
        raise ValueError(f"Unsupported provider: {provider}. Known: {list(PROVIDER_REGISTRY)}")
    return PROVIDER_REGISTRY[provider](model, api_key, **kwargs)


def _messages_to_langchain(messages: list[dict]) -> list[BaseMessage]:
    out = []
    for m in messages:
        role = (m.get("role") or "user").lower()
        content = m.get("content") or ""
        if role == "user":
            out.append(HumanMessage(content=content))
        elif role == "assistant":
            out.append(AIMessage(content=content))
        elif role == "system":
            out.append(SystemMessage(content=content))
        else:
            out.append(HumanMessage(content=content))
    return out


def chat(
    provider: str,
    model: str,
    api_key: str,
    messages: list[dict],
    max_tokens: int = 1024,
) -> str:
    """
    Call LLM via LangChain. Raises on error.
    provider: e.g. "openai" (must be in PROVIDER_REGISTRY).
    messages: [{"role": "user", "content": "..."}, ...]
    Returns the assistant message content.
    """
    llm = get_chat_model(provider=provider, model=model, api_key=api_key, max_tokens=max_tokens)
    lc_messages = _messages_to_langchain(messages)
    response = llm.invoke(lc_messages)
    return (response.content or "").strip()


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


def _run_structured_fallback(llm, prompt: str, response_model: type, return_shape: str = "single"):
    """Fallback when with_structured_output is not supported: ask for JSON in prompt and parse.
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
        print(_HL + _SEP + _R)
        print(_HL + "[Run] Fallback: prompt + JSON array schema (structured output not supported)" + _R)
        print(_HL + _SEP + _R)
        print(instruction)
        print(_HL + _SEP + _R)
        sys.stdout.flush()
        messages = [HumanMessage(content=full_prompt)]
        response = llm.invoke(messages)
        text = (response.content or "").strip()
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
    print(_HL + _SEP + _R)
    print(_HL + "[Run] Fallback: prompt + JSON schema (structured output not supported)" + _R)
    print(_HL + _SEP + _R)
    print(instruction)
    print(_HL + _SEP + _R)
    sys.stdout.flush()
    messages = [HumanMessage(content=full_prompt)]
    response = llm.invoke(messages)
    text = (response.content or "").strip()
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
    prompt: str,
    response_model: type,
    max_tokens: int = 8192,
    return_shape: str = "single",
):
    """
    Call LLM with structured output (Pydantic model). Returns (result_dict | result_list, used_fallback: bool).
    return_shape: 'single' -> one object per prompt; 'table' -> one array of objects per prompt (response_model must have "rows" field).
    If the provider does not support structured output, falls back to prompt + JSON parse.
    """
    llm = get_chat_model(provider=provider, model=model, api_key=api_key, max_tokens=max_tokens)
    try:
        structured_llm = llm.with_structured_output(response_model)
        messages = [HumanMessage(content=prompt)]
        result = structured_llm.invoke(messages)
        out = result.model_dump() if hasattr(result, "model_dump") else result.dict()
        return (out, False)
    except Exception as e:
        err_msg = (getattr(e, "message", None) or str(e)).lower()
        if any(
            x in err_msg
            for x in (
                "structured output",
                "response_format",
                "unavailable",
                "not supported",
                "invalid_request_error",
            )
        ):
            out = _run_structured_fallback(llm, prompt, response_model, return_shape=return_shape)
            return (out, True)
        raise
