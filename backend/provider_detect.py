"""
Best-effort detection of which LLM provider a credential (model id + base_url + api_key)
belongs to, plus a live model list fetched directly from that provider's own API.

This exists because LiteLLM's bundled model registry is a static snapshot (goes stale
between package upgrades) and has no live-endpoint support for some providers at all
(OpenRouter among them, verified empirically against the installed litellm version) -- so
we ask each provider directly instead of guessing from string patterns alone.
"""

import asyncio

import httpx

from llm import chat as _llm_chat

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"

_TIMEOUT = 8.0


async def _fetch_openai_style(client: httpx.AsyncClient, url: str, api_key: str | None) -> list[dict]:
    """Any endpoint that speaks the OpenAI `/models` shape: {"data": [{"id": ...}, ...]}."""
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    resp = await client.get(url, headers=headers, timeout=_TIMEOUT)
    resp.raise_for_status()
    items = (resp.json() or {}).get("data") or []
    return [{"id": it["id"], "label": it.get("name") or it["id"]} for it in items if it.get("id")]


async def _fetch_anthropic(client: httpx.AsyncClient, api_key: str) -> list[dict]:
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    resp = await client.get(ANTHROPIC_MODELS_URL, headers=headers, timeout=_TIMEOUT)
    resp.raise_for_status()
    items = (resp.json() or {}).get("data") or []
    return [{"id": it["id"], "label": it.get("display_name") or it["id"]} for it in items if it.get("id")]


async def _fetch_gemini(client: httpx.AsyncClient, api_key: str) -> list[dict]:
    resp = await client.get(GEMINI_MODELS_URL, params={"key": api_key}, timeout=_TIMEOUT)
    resp.raise_for_status()
    items = (resp.json() or {}).get("models") or []
    out = []
    for it in items:
        model_id = (it.get("name") or "").split("/")[-1]
        if model_id:
            out.append({"id": model_id, "label": it.get("displayName") or model_id})
    return out


def _native_probe_order(api_key: str) -> list[str]:
    """Key prefixes are a strong hint of which native provider to try first."""
    if api_key.startswith("sk-ant-"):
        return ["anthropic", "openai", "gemini"]
    if api_key.startswith("AIza"):
        return ["gemini", "openai", "anthropic"]
    return ["openai", "anthropic", "gemini"]


async def detect_provider(model: str, base_url: str, api_key: str) -> dict:
    """
    Returns {"provider": str, "models": [{"id", "label"}], "ok": bool, "error": str | None}.
    provider is "" when nothing could be confirmed -- caller should fall back to manual entry,
    it must never block saving the credential.
    """
    model = (model or "").strip()
    base_url = (base_url or "").strip().rstrip("/")
    api_key = (api_key or "").strip()

    async with httpx.AsyncClient() as client:
        # OpenRouter's model ids are themselves "vendor/model" (e.g. anthropic/claude-3.5-sonnet)
        # and its key format (sk-or-v1-...) is distinctive, so these signals are unambiguous --
        # check them first, before they get misread as a native-provider hint.
        is_openrouter = (
            "openrouter.ai" in base_url.lower()
            or model.lower().startswith("openrouter/")
            or api_key.startswith("sk-or-v1-")
        )
        if is_openrouter:
            # OpenRouter's list endpoint is public (no key required), so this only confirms
            # "this looks like OpenRouter" -- it can't validate the key itself.
            try:
                models = await _fetch_openai_style(client, OPENROUTER_MODELS_URL, None)
                return {"provider": "openrouter", "models": models, "ok": True, "error": None}
            except Exception as e:
                return {"provider": "openrouter", "models": [], "ok": False, "error": str(e)}

        # An explicit custom base_url means the user is pointing at a specific server
        # (self-hosted, Ollama, a proxy, ...) -- ask that server for its own model list.
        if base_url:
            try:
                models = await _fetch_openai_style(client, f"{base_url}/models", api_key)
                return {"provider": "openai", "models": models, "ok": True, "error": None}
            except Exception as e:
                return {"provider": "", "models": [], "ok": False, "error": str(e)}

        # No base_url -- try native providers' own endpoints with the given key, in an order
        # guided by the key's shape. First one that returns a real model list wins.
        if api_key:
            last_error: str | None = None
            fetchers = {
                "openai": lambda: _fetch_openai_style(client, OPENAI_MODELS_URL, api_key),
                "anthropic": lambda: _fetch_anthropic(client, api_key),
                "gemini": lambda: _fetch_gemini(client, api_key),
            }
            for provider in _native_probe_order(api_key):
                try:
                    models = await fetchers[provider]()
                    if models:
                        return {"provider": provider, "models": models, "ok": True, "error": None}
                except Exception as e:
                    last_error = str(e)
                    continue
            return {"provider": "", "models": [], "ok": False, "error": last_error}

    return {"provider": "", "models": [], "ok": False, "error": "Not enough information to detect a provider"}


def _verify_candidate_order(current_provider: str) -> list[str]:
    """
    "" means pass model/base_url through untouched (native OpenAI, Anthropic, Gemini,
    Ollama-with-a-user-typed-prefix, or a generic OpenAI-compatible base_url all resolve
    correctly this way). "openrouter" forces LiteLLM's own openrouter/ wrapper -- needed
    because OpenRouter's model ids are themselves "vendor/model" (e.g. openai/gpt-oss-20b,
    anthropic/claude-3.5-sonnet), which otherwise gets misread as a request to call that
    vendor's *native* API directly with the OpenRouter key, and fails or silently misbills.

    A credential that already has a known-good provider (google, anthropic, bedrock,
    deepseek, ...) must have that tried FIRST: those providers often need to be forced
    explicitly (e.g. a bare "gemini-2.5-flash-lite" defaults to Vertex AI/ADC in LiteLLM
    unless routed through the gemini/ prefix), so blindly starting from "" would break an
    already-correctly-configured credential.
    """
    order = []
    for c in (current_provider or "", "", "openrouter"):
        if c not in order:
            order.append(c)
    return order


async def verify_credential(model: str, base_url: str, api_key: str, current_provider: str = "") -> dict:
    """
    Determine which provider interpretation is correct by actually sending a minimal, real
    chat completion under each candidate and trusting whichever one truly succeeds -- string
    guessing (base_url domain, key prefix, model naming) is not reliable enough on its own,
    e.g. it cannot tell that "openai/gpt-oss-20b" is an OpenRouter id rather than a literal
    request to OpenAI's own API.

    current_provider (if the credential already has one stored) is tried first so a
    previously-working credential never gets re-broken by this check.

    Returns {"provider": str, "ok": bool, "error": str | None}. provider="" + ok=False means
    no candidate worked; the caller should surface the last real error, not silently guess.
    Retries are capped at 1 (instead of the usual 3) -- this is a routing check, not a
    production call, and burning ~7s of exponential backoff per wrong candidate makes the
    check painfully slow without making it more correct.
    """
    model = (model or "").strip()
    base_url = (base_url or "").strip()
    api_key = (api_key or "").strip()
    if not model or not api_key:
        return {"provider": "", "ok": False, "error": "model and api_key are required"}

    last_error: str | None = None
    for candidate in _verify_candidate_order(current_provider):
        try:
            await asyncio.to_thread(
                _llm_chat,
                provider=candidate,
                model=model,
                api_key=api_key,
                base_url=base_url,
                messages=[{"role": "user", "content": "hi"}],
                # Reasoning models (gpt-5, o1, o3, ...) spend tokens on hidden reasoning before
                # any visible output; max_tokens=1 starves them and fails with a "max_tokens
                # reached" error that looks identical to a real wrong-candidate failure.
                max_tokens=32,
                max_retries=1,
            )
            return {"provider": candidate, "ok": True, "error": None}
        except Exception as e:
            last_error = str(e)
            continue
    return {"provider": "", "ok": False, "error": last_error}
