"""
LLM client via LangChain. Reusable by credentials test, agents, and runs
with user-defined output schema (structured output).
Provider-agnostic: add new providers by registering in PROVIDER_REGISTRY below.
"""

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

# ---------------------------------------------------------------------------
# Provider: OpenAI (add more providers here, e.g. Anthropic, Google)
# ---------------------------------------------------------------------------

# Supported OpenAI model ids (used directly as API model names)
OPENAI_MODEL_MAP = {
    "gpt-5": "gpt-5",
    "gpt-5-mini": "gpt-5-mini",
    "gpt-5-nano": "gpt-5-nano",
}


def _build_openai(model: str, api_key: str, **kwargs) -> ChatOpenAI:
    if model not in OPENAI_MODEL_MAP:
        raise ValueError(f"Unsupported OpenAI model: {model}")
    return ChatOpenAI(
        model=OPENAI_MODEL_MAP[model],
        api_key=api_key,
        max_tokens=kwargs.pop("max_tokens", 1024),
        **kwargs,
    )


# Register providers here when adding new ones, e.g.:
# def _build_anthropic(model: str, api_key: str, **kwargs): ...
# PROVIDER_REGISTRY["anthropic"] = _build_anthropic
PROVIDER_REGISTRY = {
    "openai": _build_openai,
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
