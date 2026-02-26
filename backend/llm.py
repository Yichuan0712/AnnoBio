"""
LLM client via LangChain. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).
Provider-agnostic: add new providers by registering in PROVIDER_REGISTRY below.
"""

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI

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


PROVIDER_REGISTRY = {
    "openai": _build_openai,
    "anthropic": _build_anthropic,
    "google": _build_google,
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


def run_structured(provider: str, model: str, api_key: str, prompt: str, response_model: type, max_tokens: int = 8192):
    """
    Call LLM with structured output (Pydantic model). Returns the parsed object as dict.
    Default max_tokens=8192 so long structured responses are not truncated (truncation breaks JSON parsing).
    """
    llm = get_chat_model(provider=provider, model=model, api_key=api_key, max_tokens=max_tokens)
    structured_llm = llm.with_structured_output(response_model)
    messages = [HumanMessage(content=prompt)]
    result = structured_llm.invoke(messages)
    return result.model_dump() if hasattr(result, "model_dump") else result.dict()
