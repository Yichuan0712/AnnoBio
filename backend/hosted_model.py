"""Public managed-model identity and private account-scoped gateway resolution (hosted only)."""
import os
import httpx

CREDENTIAL_ID = "annobio-free"
MODEL_NAME = "AnnoBio AI"


def enabled() -> bool:
    return os.environ.get("ANNOBIO_HOSTED_MODE") == "1"


def is_builtin(value) -> bool:
    return enabled() and (value.get("id") if isinstance(value, dict) else value) == CREDENTIAL_ID


def credential() -> dict:
    return {"id": CREDENTIAL_ID, "model": MODEL_NAME, "llm": MODEL_NAME, "provider": "annobio", "base_url": "",
            "api_key": "", "builtin": True, "last_check_ok": True,
            "agent_check": {"model": MODEL_NAME, "ok": True, "detail": "Included web model"}}


def credentials(stored: list[dict]) -> list[dict]:
    if not enabled():
        return stored
    return [credential(), *(item for item in stored if item.get("id") != CREDENTIAL_ID and item.get("provider") == "openrouter")]


def settings(values: dict, items: list[dict]) -> dict:
    if not enabled():
        return values
    offered = {item.get("id") for item in items}
    return {**values, **{key: values.get(key) if values.get(key) in offered else CREDENTIAL_ID
        for key in ("default_run_credential_id", "default_review_credential_id", "default_agent_credential_id")}}


def resolve(item: dict, role: str) -> dict:
    if not is_builtin(item):
        return item
    if role not in {"generate", "optimize", "agent"}:
        raise ValueError("Unknown hosted-model task.")
    token = os.environ.get("ANNOBIO_HOSTED_TOKEN", "")
    gateway = os.environ.get("ANNOBIO_HOSTED_GATEWAY_URL", "").rstrip("/")
    if not token or not gateway:
        raise ValueError("The free model is not configured yet. Connect OpenRouter in LLM settings to continue.")
    # Explicit LiteLLM routing is required for this opaque model name, including DSPy calls.
    return {**item, "provider": "openai", "model": "openai/annobio-free", "base_url": f"{gateway}/{role}/v1", "api_key": token}


def usage() -> dict:
    if not enabled():
        return {"enabled": False}
    gateway = os.environ.get("ANNOBIO_HOSTED_GATEWAY_URL", "").rstrip("/")
    token = os.environ.get("ANNOBIO_HOSTED_TOKEN", "")
    if not gateway or not token:
        return {"enabled": True, "credential_id": CREDENTIAL_ID, "name": MODEL_NAME, "available": False}
    try:
        response = httpx.get(gateway + "/usage", headers={"Authorization": f"Bearer {token}"}, timeout=10)
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        return {"enabled": True, "credential_id": CREDENTIAL_ID, "name": MODEL_NAME, "available": False, "error": "Could not load the free token allowance."}
