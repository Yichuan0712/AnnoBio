"""Edit the web's private model credentials and role selections here.

Same fields as desktop credentials: provider, model, base_url and an API key. Reference the
key's environment variable instead of committing its value. Only Hub receives these keys.
Add a credential below, then select its name independently in ROLE_MODELS. Rebuild/restart
Hub after editing. No frontend or per-user workspace changes are needed.
"""
import os


MODEL_CREDENTIALS = {
    "default": {
        "provider": "deepseek",
        "model": "deepseek-reasoner",
        "base_url": "https://api.deepseek.com/v1",
        "api_key_env": "ANNOBIO_HOSTED_API_KEY",
    },
    # Example using a separate platform-owned OpenRouter key:
    # "router": {
    #     "provider": "openrouter",
    #     "model": "anthropic/claude-sonnet-4.6",
    #     "base_url": "",  # provider default
    #     "api_key_env": "ANNOBIO_HOSTED_OPENROUTER_API_KEY",
    # },
}

ROLE_MODELS = {
    "generate": "default",
    "optimize": "default",
    "agent": "default",
}

PROVIDERS = {"openai", "openrouter", "deepseek", "anthropic", "gemini", "bedrock"}
DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "deepseek": "https://api.deepseek.com/v1",
}


def credential_for_role(role: str) -> dict:
    if role not in ROLE_MODELS:
        raise ValueError("Unknown hosted-model task.")
    item = dict(MODEL_CREDENTIALS[ROLE_MODELS[role]])
    # Existing server .env settings remain supported; blank values use the code configuration.
    prefix = f"ANNOBIO_HOSTED_{role.upper()}_"
    for field, suffix in (("provider", "PROVIDER"), ("model", "MODEL"), ("base_url", "API_BASE"), ("api_key_env", "API_KEY_ENV")):
        override = os.environ.get(prefix + suffix, "").strip()
        if override:
            item[field] = override
    if ROLE_MODELS[role] == "default":
        item["base_url"] = os.environ.get("ANNOBIO_HOSTED_API_BASE", "").strip() or item.get("base_url", "")
    provider = str(item.get("provider", "")).lower().strip()
    provider = {"google": "gemini", "amazon-bedrock": "bedrock"}.get(provider, provider)
    model = str(item.get("model", "")).strip()
    if provider not in PROVIDERS or not model:
        raise ValueError("Invalid hosted-model provider or model.")
    base = str(item.get("base_url", "")).strip().rstrip("/") or DEFAULT_BASE_URLS.get(provider, "")
    # Tokenizer choice follows each credential, so switching one role does not keep using
    # DeepSeek's tokenizer for unrelated providers. All preflight counts remain estimates.
    tokenizer = item.get("tokenizer") or ("deepseek" if provider == "deepseek" or "deepseek" in model.lower() else "cl100k_base")
    return {**item, "provider": provider, "model": model, "base_url": base,
            "api_key": os.environ.get(item.get("api_key_env", ""), ""),
            "tokenizer": os.environ.get("ANNOBIO_HOSTED_TOKENIZER_MODEL", "").strip() or tokenizer}
