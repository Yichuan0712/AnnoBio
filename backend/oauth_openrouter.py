"""
OpenRouter OAuth PKCE login for the "New credential" flow.

The backend's own HTTP server is the OAuth redirect target (no Electron-side
loopback server or protocol handler needed): the browser lands directly on
GET /api/credentials/openrouter/callback, which runs in-process next to
credentials.json. The frontend polls GET /api/credentials/openrouter/status/{state},
the same pattern already used for Run/Review jobs.

Docs: https://openrouter.ai/docs/use-cases/oauth-pkce
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
import uuid
from typing import Any
from urllib.parse import quote

import httpx
from fastapi.responses import HTMLResponse

_SESSION_TTL_SECONDS = 600
_SESSIONS: dict[str, dict[str, Any]] = {}

_AUTHORIZE_URL = "https://openrouter.ai/auth"
_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys"
_MODELS_URL = "https://openrouter.ai/api/v1/models"
_DEFAULT_MODEL = "openrouter/auto"

_CATALOG_TTL_SECONDS = 300
_catalog_cache: dict[str, Any] = {"fetched_at": 0.0, "models": []}


def _prune_expired() -> None:
    now = time.time()
    stale = [s for s, sess in _SESSIONS.items() if now - sess["created_at"] > _SESSION_TTL_SECONDS]
    for s in stale:
        _SESSIONS.pop(s, None)


def _page(title: str, message: str) -> HTMLResponse:
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font-family:system-ui,sans-serif;background:#0b0b0c;color:#eee;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}}
.card{{text-align:center;max-width:420px;padding:24px}}</style></head>
<body><div class="card"><h2>{title}</h2><p>{message}</p></div></body></html>"""
    return HTMLResponse(content=html)


def start_oauth(backend_host: str, backend_port: int, public_base_url: str = "") -> dict[str, str]:
    _prune_expired()
    state = uuid.uuid4().hex
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    _SESSIONS[state] = {
        "verifier": verifier,
        "status": "pending",
        "credential_id": None,
        "error": None,
        "created_at": time.time(),
    }
    # Desktop: this backend's own loopback address is where the browser can reach it. Behind a
    # Hub (see hub/proxy.py), it isn't — the container has no public address of its own, only
    # the Hub's own domain does, which then routes /api/* back to this same container based on
    # the researcher's session. public_base_url carries that public domain in that case.
    base = public_base_url.rstrip("/") if public_base_url else f"http://{backend_host}:{backend_port}"
    callback_url = f"{base}/api/credentials/openrouter/callback?state={state}"
    auth_url = (
        f"{_AUTHORIZE_URL}?callback_url={quote(callback_url, safe='')}"
        f"&code_challenge={challenge}&code_challenge_method=S256"
    )
    return {"auth_url": auth_url, "state": state}


def get_status(state: str) -> dict[str, Any]:
    _prune_expired()
    sess = _SESSIONS.get(state)
    if not sess:
        return {"status": "not_found"}
    return {"status": sess["status"], "credential_id": sess["credential_id"], "error": sess["error"]}


def handle_callback(state: str, code: str) -> HTMLResponse:
    sess = _SESSIONS.get(state)
    if not sess:
        return _page("Link expired", "This OpenRouter connection request expired or was already used. Go back to AnnoBio and try again.")
    if sess["status"] != "pending":
        return _page("Already handled", "This OpenRouter connection was already processed. You can close this tab.")
    try:
        resp = httpx.post(
            _TOKEN_URL,
            json={"code": code, "code_verifier": sess["verifier"], "code_challenge_method": "S256"},
            timeout=20.0,
        )
        resp.raise_for_status()
        key = (resp.json() or {}).get("key") or ""
        if not key:
            raise ValueError("OpenRouter did not return a key")
    except Exception as e:
        sess["status"] = "error"
        sess["error"] = str(e)
        return _page("Connection failed", "Could not complete the OpenRouter connection. Go back to AnnoBio and try again.")

    from main import _load_credentials, _save_credentials, _mask_key  # lazy: avoid circular import

    items = _load_credentials()
    new_id = str(uuid.uuid4())
    items.append(
        {
            "id": new_id,
            "model": _DEFAULT_MODEL,
            "api_key": key,
            "base_url": "",
            "provider": "openrouter",
        }
    )
    _save_credentials(items)
    sess["status"] = "done"
    sess["credential_id"] = new_id
    return _page("Connected", "AnnoBio is now connected to your OpenRouter account. You can close this tab.")


def get_catalog() -> list[dict[str, Any]]:
    """OpenRouter's public model catalog (no auth required); cached briefly in-process."""
    now = time.time()
    if now - _catalog_cache["fetched_at"] < _CATALOG_TTL_SECONDS and _catalog_cache["models"]:
        return _catalog_cache["models"]
    resp = httpx.get(_MODELS_URL, timeout=15.0)
    resp.raise_for_status()
    raw = (resp.json() or {}).get("data") or []
    models = []
    for m in raw:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        # Batch-only variants 404 on the normal chat completions endpoint this app uses --
        # they need OpenRouter's separate /api/beta batch API, which isn't wired up here.
        if ":batch" in m["id"].lower():
            continue
        arch = m.get("architecture") or {}
        pricing = m.get("pricing") or {}
        models.append(
            {
                "id": m["id"],
                "name": m.get("name") or m["id"],
                "context_length": m.get("context_length"),
                "vision": "image" in (arch.get("input_modalities") or []),
                "prompt_price": pricing.get("prompt"),
                "completion_price": pricing.get("completion"),
            }
        )
    models.sort(key=lambda m: m["name"].lower())
    _catalog_cache["fetched_at"] = now
    _catalog_cache["models"] = models
    return models
