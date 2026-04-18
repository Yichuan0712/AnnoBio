from pathlib import Path
import json
import os
import re
import sys
import threading
import time
import uuid
from typing import Any, List, Optional

# Ensure UTF-8 for subprocess / CLI starts (Electron also sets PYTHONUTF8 when spawning).
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from safe_stdio import ensure_console_utf8_windows, safe_print as _safe_print

ensure_console_utf8_windows()

# Prefer UTF-8 for stdio on Windows so prompts with U+2011 etc. do not raise on print().
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError, AttributeError):
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError, AttributeError):
        pass

# ANSI codes for terminal highlight (all yellow; supported on Windows 10+ and Unix)
_HL = "\033[1;33m"   # bold yellow
_R = "\033[0m"       # reset
_SEP = "=" * 60      # unified separator for LLM prompt/output logs

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, create_model

from llm import chat as llm_chat, run_structured as llm_run_structured

app = FastAPI()

# Allow CORS for Electron renderer (Vite dev server localhost:5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _reconfigure_stdio_after_uvicorn() -> None:
    """Uvicorn may install StreamHandlers before our module-level reconfigure; fix Windows GBK consoles."""
    import logging

    def _recfg(stream) -> None:
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError, AttributeError):
                pass

    _recfg(sys.stdout)
    _recfg(sys.stderr)
    for log_name in ("uvicorn", "uvicorn.error", "uvicorn.access", ""):
        for handler in logging.getLogger(log_name).handlers:
            if isinstance(handler, logging.StreamHandler):
                _recfg(handler.stream)


# Credential storage path (not committed to git)
DATA_DIR = Path(__file__).resolve().parent / "data"
CREDENTIALS_FILE = DATA_DIR / "credentials.json"
RUN_JOBS_FILE = DATA_DIR / "run_jobs.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "default_run_credential_id": "",
    "default_review_credential_id": "",
    "run_max_tokens": 8192,
    "review_max_tokens": 32768,
    "run_max_retries": 2,
    # Cap: distinct worksheet inputs that have at least one unmatched Score comparison row (not raw row count).
    "review_max_failed_rows": 30,
    # Thompson-sampling trials per finetune run (4–200).
    "finetune_max_trials": 40,
    # Show Reset & Debug buttons on suggestion cards.
    "debug_mode": False,
}


# Supported providers and models (maintained here; frontend fetches via GET /api/credentials/models)
PROVIDERS = [
    {"id": "openai", "name": "OpenAI"},
    {"id": "anthropic", "name": "Anthropic"},
    {"id": "google", "name": "Google"},
    {"id": "deepseek", "name": "DeepSeek"},
    {"id": "mistral", "name": "Mistral"},
    {"id": "bedrock", "name": "Amazon Bedrock"},
]
# name = display name in dropdown; matches API model id (GPT uses id, Anthropic uses actual API model id)
MODELS = [
    {"id": "gpt-5", "name": "gpt-5", "provider": "openai"},
    {"id": "gpt-5-mini", "name": "gpt-5-mini", "provider": "openai"},
    {"id": "gpt-5-nano", "name": "gpt-5-nano", "provider": "openai"},
    {"id": "claude-opus-4-6", "name": "claude-opus-4-6", "provider": "anthropic"},
    {"id": "claude-sonnet-4-6", "name": "claude-sonnet-4-6", "provider": "anthropic"},
    {"id": "gemini-2.5-pro", "name": "gemini-2.5-pro", "provider": "google"},
    {"id": "gemini-2.5-flash", "name": "gemini-2.5-flash", "provider": "google"},
    {"id": "gemini-2.5-flash-lite", "name": "gemini-2.5-flash-lite", "provider": "google"},
    {"id": "openai.gpt-oss-20b-1:0", "name": "openai.gpt-oss-20b-1:0", "provider": "bedrock"},
    {"id": "openai.gpt-oss-120b-1:0", "name": "openai.gpt-oss-120b-1:0", "provider": "bedrock"},
    {"id": "deepseek-chat", "name": "deepseek-chat", "provider": "deepseek"},
    {"id": "deepseek-reasoner", "name": "deepseek-reasoner", "provider": "deepseek"},
    {"id": "mistral-large-2512", "name": "mistral-large-2512", "provider": "mistral"},
]
ALLOWED_MODELS = {m["id"] for m in MODELS}
ALLOWED_PROVIDERS = {p["id"] for p in PROVIDERS}


def _log_backend_version():
    """Print on startup to confirm this file is loaded."""
    _safe_print(f"[backend] main.py loaded from: {Path(__file__).resolve()}")
    _safe_print(f"[backend] MODELS={len(MODELS)}, PROVIDERS={len(PROVIDERS)}")


_log_backend_version()


def _infer_provider(llm: str) -> str:
    """Infer provider from llm; fallback for legacy data without provider field."""
    for m in MODELS:
        if m["id"] == llm:
            return m["provider"]
    return "openai"


def _check_model_for_provider(provider: str, llm: str) -> None:
    """Validate (provider, llm) is a valid combination in MODELS; raise HTTPException otherwise."""
    for m in MODELS:
        if m["id"] == llm and m["provider"] == provider:
            return
    by_provider: dict[str, list[str]] = {}
    for m in MODELS:
        p = m["provider"]
        if p not in by_provider:
            by_provider[p] = []
        by_provider[p].append(m["id"])
    parts = [f"{p}: {sorted(ids)}" for p, ids in sorted(by_provider.items())]
    raise HTTPException(
        status_code=400,
        detail=f"model '{llm}' is not valid for provider '{provider}'. Valid by provider: " + "; ".join(parts),
    )


class CredentialCreate(BaseModel):
    """Not used for POST /api/credentials (we parse Request body by hand). Kept for OpenAPI docs only."""
    name: str | None = Field(default=None, description="Optional display name")
    llm: str = Field(..., description="Model id from MODELS (openai/anthropic/google)")
    api_key: str = Field(..., min_length=1, description="API key")
    provider: str = Field(default="openai", description="Provider id from PROVIDERS")


class CredentialRenameBody(BaseModel):
    name: str = Field(..., min_length=1, description="New name")


class SettingsPatch(BaseModel):
    """Partial settings update; only provided fields are updated."""
    default_run_credential_id: str | None = None
    default_review_credential_id: str | None = None
    run_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    review_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    run_max_retries: int | None = Field(default=None, ge=0, le=5)
    review_max_failed_rows: int | None = Field(
        default=None,
        ge=1,
        le=200,
        description="Cap Phase-1 review to this many distinct inputs that have at least one unmatched comparison row (not a raw comparison-row count).",
    )
    finetune_max_trials: int | None = Field(
        default=None,
        ge=4,
        le=200,
        description="Maximum Thompson-sampling trials per compositional finetune run (4–200).",
    )
    debug_mode: bool | None = None


class CredentialResponse(BaseModel):
    id: str
    name: str
    llm: str
    provider: str
    api_key_masked: str


class CredentialDetailResponse(BaseModel):
    """Single credential with full api_key for in-app display only."""

    id: str
    name: str
    llm: str
    provider: str
    api_key: str


class RunRequest(BaseModel):
    credential_id: str
    prompts: list[str] = Field(..., min_length=1, description="One prompt per row (placeholders already substituted)")
    output_schema: dict = Field(..., description="return_shape + fields: [{ key, type, description?, allow_none? }]")
    run_node_id: str | None = Field(default=None, description="Frontend Run node id for correlation when polling")


# ---------- Review (prompt analysis from score comparison) ----------
class ReviewComparisonRow(BaseModel):
    row_index: int
    input_row_index: int | None = Field(
        default=None,
        description="0-based input worksheet row when 1 input maps to multiple run outputs; used to group Phase 1 review",
    )
    matched: bool
    run_output: dict = Field(default_factory=dict, description="Model output for this row")
    expected: str = Field(default="", description="Expected value(s) from ground truth (human-readable; legacy)")
    ground_truth_output: dict = Field(
        default_factory=dict,
        description="Ground truth values keyed by score-rule outputKey (same JSON keys as run_output for compared fields)",
    )
    comparison_types: list[str] | None = Field(
        default=None,
        description="Per-rule labels from the UI; each entry is `outputKey: …` (same outputKey as scoring / ground_truth_output keys)",
    )
    row_input: dict | None = Field(
        default=None,
        description="Placeholder name → substituted value for this run (keys match `{name}` in prompt sections; only inputs that appear in the template)",
    )
    gt_only: bool = Field(
        default=False,
        description="True when this row is an unpaired ground-truth expectation with no run result (missing extraction in Review)",
    )
    source_gt_row_index: int | None = Field(
        default=None,
        description="0-based ground truth table row index when gt_only; paired rows may repeat paired GT index",
    )
    score_table_row: int | None = Field(
        default=None,
        description="1-based row number in Score detail comparison table (# column), unfiltered order",
    )


class ReviewRequest(BaseModel):
    credential_id: str
    review_session_id: str | None = Field(default=None, description="Frontend session id for cancellation; pass reviewNodeId")
    prompt_sections: list[dict] = Field(..., description="List of {name, content} for each section")
    run_results: list[dict] = Field(default_factory=list, description="List of {row_index, output}")
    output_fields: list[dict] = Field(default_factory=list, description="List of {key, display}; used when output_schema not provided")
    output_schema: dict | None = Field(default=None, description="Same as run: return_shape + fields [{ key, type, description?, allow_none? }]; when set, used instead of output_return_shape + output_fields for prompts")
    output_return_shape: str = Field(default="single", description="Fallback when output_schema not provided")
    comparison_rows: list[ReviewComparisonRow] = Field(default_factory=list, description="Per-row match result and context")
    all_rows_matched: bool | None = Field(default=None, description="If True, frontend reports every comparison row matched")


class ReviewSuggestion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(..., description="Short name summarizing this change (e.g. 'Clarify output format')")
    phase1_addresses: list[str] = Field(
        default_factory=list,
        description="Phase 1 findings this edit targets (from automated review; empty for chat-added edits)",
    )
    old_sentence: str = Field(..., description="Exact sentence in the section to replace (one sentence only)")
    new_sentence: str = Field(..., description="Replacement for that one sentence")
    reason: str = Field(..., description="Why this change is suggested")
    target_score_row_indices: list[int] = Field(
        ...,
        min_length=1,
        validation_alias=AliasChoices("target_score_row_indices", "target_input_row_indices"),
        description="0-based comparison row_index in stored/API payloads; automated review prompts use 1-based Score #",
    )


class ReviewResult(BaseModel):
    summary: str = Field(..., description="Brief overall analysis")
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete edit suggestions")
    data_refinement: list[dict] = Field(default_factory=list, description="GT question summary: [{row_indices, reason}]")


def _sanitize_field_name(key: str) -> str:
    """Turn schema key into valid Pydantic field name (alphanumeric + underscore)."""
    s = re.sub(r"[^\w]", "_", str(key).strip())
    return s or "field"


def _build_output_model(fields: list[dict]) -> type[BaseModel]:
    """Build a Pydantic model from app output_schema.fields (key, type, description, allow_none)."""
    type_map = {
        "str": (str, ...),
        "float": (float, ...),
        "list_str": (list[str], ...),
        "list_float": (list[float], ...),
    }
    field_defs: dict[str, Any] = {}
    for f in fields:
        key = f.get("key") or "field"
        name = _sanitize_field_name(key)
        if name in field_defs:
            n = 1
            while f"{name}_{n}" in field_defs:
                n += 1
            name = f"{name}_{n}"
        raw_type = (f.get("type") or "str").strip().lower()
        desc = (f.get("description") or "").strip() or None
        allow_none = f.get("allow_none") or f.get("allowNone") is True
        if raw_type not in type_map:
            raw_type = "str"
        typ, _ = type_map[raw_type]
        if allow_none:
            typ = Optional[typ]
            field_defs[name] = (typ, Field(default=None, description=desc or key))
        else:
            field_defs[name] = (typ, Field(..., description=desc or key))
    return create_model("StructuredOutput", **field_defs)


def _build_table_output_model(row_model: type[BaseModel]) -> type[BaseModel]:
    """Build a Pydantic model with one field 'rows': list[row_model] for return_shape=table."""
    return create_model("TableOutput", rows=(List[row_model], Field(default_factory=list)))


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_settings() -> dict:
    """Load settings from disk; return defaults if missing or invalid."""
    _ensure_data_dir()
    if not SETTINGS_FILE.exists():
        return dict(DEFAULT_SETTINGS)
    try:
        raw = SETTINGS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        out = dict(DEFAULT_SETTINGS)
        for k in DEFAULT_SETTINGS:
            if k in data:
                out[k] = data[k]
        return out
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULT_SETTINGS)


def _save_settings(data: dict) -> None:
    """Save settings to disk."""
    _ensure_data_dir()
    out = dict(DEFAULT_SETTINGS)
    for k in DEFAULT_SETTINGS:
        if k in data:
            out[k] = data[k]
    SETTINGS_FILE.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_credentials() -> list[dict]:
    _ensure_data_dir()
    if not CREDENTIALS_FILE.exists():
        return []
    try:
        raw = CREDENTIALS_FILE.read_text(encoding="utf-8")
        return json.loads(raw)
    except (json.JSONDecodeError, OSError):
        return []


def _save_credentials(items: list[dict]) -> None:
    _ensure_data_dir()
    CREDENTIALS_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


def _mask_key(key: str) -> str:
    if len(key) <= 8:
        return "****"
    return key[:4] + "..." + key[-4:]


def _unique_name_for_model(items: list[dict], model: str) -> str:
    """Return model, or 'model 2', 'model 3', ... if name exists."""
    existing = {item.get("name", "").strip() for item in items}
    if model not in existing:
        return model
    n = 2
    while f"{model} {n}" in existing:
        n += 1
    return f"{model} {n}"


def _credential_provider(item: dict) -> str:
    """Get provider from stored item; infer from llm if missing (legacy compatibility)."""
    return item.get("provider") or _infer_provider(item.get("llm", ""))


@app.get("/health")
def health():
    """Health check; returns models/providers count to confirm backend version."""
    return {"ok": True, "models": len(MODELS), "providers": len(PROVIDERS)}


@app.get("/api/debug/backend-info")
def debug_backend_info():
    """Debug: confirm this is the current repo version. New version should have 11 model_ids."""
    return {
        "main_file": str(Path(__file__).resolve()),
        "models_count": len(MODELS),
        "model_ids": [m["id"] for m in MODELS],
        "providers_count": len(PROVIDERS),
    }


@app.get("/api/credentials/models")
def list_credential_models():
    """Return supported providers and models for frontend dropdown."""
    return {"providers": list(PROVIDERS), "models": list(MODELS)}


class EmbeddingPairSimRequest(BaseModel):
    pairs: list[list[str]] = Field(default_factory=list)


class EmbeddingPairSimResponse(BaseModel):
    cosines: list[float]
    model: str


@app.post("/api/embeddings/pair-similarities", response_model=EmbeddingPairSimResponse)
def api_embeddings_pair_similarities(body: EmbeddingPairSimRequest):
    """Batch cosine similarity using local FastEmbed (Sentence-Transformers MiniLM ONNX — fast CPU model)."""
    pairs = body.pairs
    if len(pairs) > 2048:
        raise HTTPException(status_code=400, detail="Too many pairs (max 2048 per request)")
    for i, ab in enumerate(pairs):
        if not isinstance(ab, list) or len(ab) != 2:
            raise HTTPException(status_code=400, detail=f"pairs[{i}] must be [string, string]")
        for j, t in enumerate(ab):
            if not isinstance(t, str):
                raise HTTPException(status_code=400, detail=f"pairs[{i}][{j}] must be a string")
            if len(t) > 16000:
                raise HTTPException(status_code=400, detail="Each string must be at most 16000 characters")
    try:
        from embedding_service import compute_pair_cosine_similarities, get_loaded_model_id

        cos = compute_pair_cosine_similarities(pairs)
        return EmbeddingPairSimResponse(cosines=cos, model=get_loaded_model_id())
    except Exception as e:
        _safe_print(f"[embeddings] {e}")
        raise HTTPException(
            status_code=503,
            detail="Embedding model unavailable. Install backend dependencies (fastembed, numpy) and ensure the model can download.",
        ) from e


@app.get("/api/credentials", response_model=list[CredentialResponse])
def list_credentials():
    """List all credentials; API key returned masked."""
    items = _load_credentials()
    return [
        CredentialResponse(
            id=item["id"],
            name=item.get("name", "Unnamed"),
            llm=item["llm"],
            provider=_credential_provider(item),
            api_key_masked=_mask_key(item["api_key"]),
        )
        for item in items
    ]


@app.post("/api/credentials", response_model=CredentialResponse)
async def add_credential(request: Request):
    """Add a credential. Uses raw JSON parsing to avoid Pydantic cache limiting models."""
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    llm = (body.get("llm") or body.get("model") or "").strip()
    api_key = (body.get("api_key") or "").strip()
    if not llm:
        raise HTTPException(status_code=400, detail="llm is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="api_key is required")
    provider = (body.get("provider") or "").strip() or _infer_provider(llm)
    if provider not in ALLOWED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"provider must be one of {sorted(ALLOWED_PROVIDERS)}")
    if llm in ALLOWED_MODELS:
        _check_model_for_provider(provider, llm)
    items = _load_credentials()
    new_id = str(uuid.uuid4())
    name = (body.get("name") or "").strip() if body.get("name") else ""
    if not name:
        name = _unique_name_for_model(items, llm)
    new_item = {
        "id": new_id,
        "name": name,
        "llm": llm,
        "api_key": api_key,
        "provider": provider,
    }
    items.append(new_item)
    _save_credentials(items)
    return CredentialResponse(
        id=new_id,
        name=new_item["name"],
        llm=new_item["llm"],
        provider=new_item["provider"],
        api_key_masked=_mask_key(new_item["api_key"]),
    )


@app.get("/api/credentials/{credential_id}", response_model=CredentialDetailResponse)
def get_credential(credential_id: str):
    """Return one credential with full api_key (for display when user reveals key)."""
    items = _load_credentials()
    for item in items:
        if item.get("id") == credential_id:
            return CredentialDetailResponse(
                id=item["id"],
                name=item.get("name", "Unnamed"),
                llm=item["llm"],
                provider=_credential_provider(item),
                api_key=item["api_key"],
            )
    raise HTTPException(status_code=404, detail="Credential not found")


@app.patch("/api/credentials/{credential_id}", response_model=CredentialResponse)
def rename_credential(credential_id: str, body: CredentialRenameBody):
    """Rename a credential by id. Rejects if name is already used by another credential."""
    items = _load_credentials()
    new_name = body.name.strip()
    for item in items:
        if item.get("id") != credential_id and (item.get("name") or "").strip() == new_name:
            raise HTTPException(status_code=400, detail="Name already in use")
    for item in items:
        if item.get("id") == credential_id:
            item["name"] = new_name
            _save_credentials(items)
            return CredentialResponse(
                id=item["id"],
                name=item["name"],
                llm=item["llm"],
                provider=_credential_provider(item),
                api_key_masked=_mask_key(item["api_key"]),
            )
    raise HTTPException(status_code=404, detail="Credential not found")


@app.post("/api/credentials/{credential_id}/test")
def test_credential(credential_id: str):
    """Verify API key by sending a minimal prompt to the LLM."""
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = cred.get("provider", "openai")
    try:
        llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            messages=[{"role": "user", "content": "Reply with exactly: OK"}],
            max_tokens=50,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


# ---------- Chat (Review Assistant) ----------
class ChatMessage(BaseModel):
    role: str = Field(..., description="user | assistant | system")
    content: str = Field(default="", description="Message content")


class ChatRequest(BaseModel):
    credential_id: str = Field(..., description="Credential id (uses reviewer settings)")
    messages: list[ChatMessage] = Field(..., min_length=1, description="Conversation history; last message should be user")


@app.post("/api/chat")
def chat(body: ChatRequest):
    """Simple chat using the given credential. Uses review_max_tokens from settings."""
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == body.credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = cred.get("provider", "openai")
    settings = _load_settings()
    max_tokens = settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    msgs = [{"role": m.role, "content": m.content or ""} for m in body.messages]
    try:
        content = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            messages=msgs,
            max_tokens=max_tokens,
        )
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/credentials/{credential_id}")
def delete_credential(credential_id: str):
    """Delete a credential by id."""
    items = _load_credentials()
    new_items = [x for x in items if x.get("id") != credential_id]
    if len(new_items) == len(items):
        raise HTTPException(status_code=404, detail="Credential not found!")
    _save_credentials(new_items)
    return {"ok": True}


# ---------- Settings ----------
@app.get("/api/settings")
def get_settings():
    """Return current settings (default model, max_tokens, etc.)."""
    return _load_settings()


@app.patch("/api/settings")
def patch_settings(body: SettingsPatch):
    """Partially update settings; only update provided fields."""
    data = _load_settings()
    updates = body.model_dump(exclude_none=True)
    for k, v in updates.items():
        if k in DEFAULT_SETTINGS:
            data[k] = v
    _save_settings(data)
    return data


# ---------- Run (execute prompts with structured output) ----------
# Run progress is persisted to RUN_JOBS_FILE (data/run_jobs.json). Load on startup, save after every update.
# If the client stops polling (e.g. user force-quits), the worker abandons the run within RUN_ABANDON_TIMEOUT_SEC.
# job: { status, run_node_id?, completed?, total?, results?, output_fields?, error? }
# by_node: run_node_id -> run_id (latest run per node)
# _run_last_activity: run_id -> last time we saw activity (poll or cancel); worker exits when no activity for RUN_ABANDON_TIMEOUT_SEC
RUN_ABANDON_TIMEOUT_SEC = 12  # if no GET/cancel for this run in 12s, treat client as gone and stop

_run_jobs: dict[str, dict] = {}
_run_jobs_by_node: dict[str, str] = {}
_run_last_activity: dict[str, float] = {}  # run_id -> time.time(); updated on every poll or cancel
_run_jobs_lock = threading.Lock()
_run_cancelled: set[str] = set()  # run_ids client asked to cancel; worker checks each row

_review_jobs: dict[str, dict] = {}  # review_id -> { status, events, review_node_id, error? }
_review_jobs_by_node: dict[str, str] = {}  # review_node_id -> review_id
_review_jobs_lock = threading.Lock()
_review_cancelled: set[str] = set()  # review_ids client asked to cancel; worker checks each step


def _touch_run_activity(run_id: str) -> None:
    """Call while holding _run_jobs_lock (or from a single-threaded request)."""
    _run_last_activity[run_id] = time.time()


def _persist_run_jobs() -> None:
    """Write run jobs and by_node index to disk so progress survives restart."""
    with _run_jobs_lock:
        snapshot = dict(_run_jobs)
    by_node: dict[str, str] = {}
    for rid, job in snapshot.items():
        nid = job.get("run_node_id")
        if nid:
            by_node[nid] = rid
    payload = {"jobs": snapshot, "by_node": by_node}
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        RUN_JOBS_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[Run] persist failed: {e}", file=sys.stderr)


def _load_run_jobs() -> None:
    """Load persisted run jobs on startup. Do not load _run_last_activity (client is gone)."""
    if not RUN_JOBS_FILE.exists():
        return
    try:
        raw = RUN_JOBS_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        jobs = data.get("jobs") or {}
        by_node = data.get("by_node") or {}
        with _run_jobs_lock:
            _run_jobs.clear()
            _run_jobs.update(jobs)
            _run_jobs_by_node.clear()
            _run_jobs_by_node.update(by_node)
            _run_last_activity.clear()
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[Run] load persisted jobs failed: {e}", file=sys.stderr)


_load_run_jobs()


def _run_field_value_non_empty(v: object) -> bool:
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, list):
        return any(_run_field_value_non_empty(x) for x in v)
    if isinstance(v, dict):
        return bool(v) and any(_run_field_value_non_empty(x) for x in v.values())
    return True


def _run_structured_output_is_empty(out: object, return_shape: str, output_fields: list[dict]) -> bool:
    """True if model returned no substantive values for schema fields (used when persisting run rows, not Score filtering)."""
    keys = [str(f.get("key") or "").strip() for f in (output_fields or []) if f.get("key")]
    if return_shape == "table":
        if not isinstance(out, list) or len(out) == 0:
            return True
        for row in out:
            if not isinstance(row, dict):
                continue
            if keys:
                if any(_run_field_value_non_empty(row.get(k)) for k in keys):
                    return False
            elif any(_run_field_value_non_empty(v) for v in row.values()):
                return False
        return True
    if not isinstance(out, dict):
        return True
    if keys:
        return not any(_run_field_value_non_empty(out.get(k)) for k in keys)
    return not any(_run_field_value_non_empty(v) for v in out.values())


def _do_run_work(
    run_id: str,
    credential_id: str,
    prompts: list[str],
    output_schema: dict,
) -> None:
    """Background worker: run prompts row by row. Stops when cancelled or when client has not polled for RUN_ABANDON_TIMEOUT_SEC."""
    try:
        items = _load_credentials()
        cred = None
        for item in items:
            if item.get("id") == credential_id:
                cred = item
                break
        if not cred:
            with _run_jobs_lock:
                nid = _run_jobs.get(run_id, {}).get("run_node_id")
                _run_jobs[run_id] = {"status": "done", "error": "Credential not found", "run_node_id": nid}
            _persist_run_jobs()
            return
        provider = cred.get("provider", "openai")
        model = cred.get("llm", "")
        api_key = cred.get("api_key", "")
        if provider not in ALLOWED_PROVIDERS:
            with _run_jobs_lock:
                nid = _run_jobs.get(run_id, {}).get("run_node_id")
                _run_jobs[run_id] = {"status": "done", "error": "Unsupported provider", "run_node_id": nid}
            _persist_run_jobs()
            return
        if not api_key:
            with _run_jobs_lock:
                nid = _run_jobs.get(run_id, {}).get("run_node_id")
                _run_jobs[run_id] = {"status": "done", "error": "Missing API key", "run_node_id": nid}
            _persist_run_jobs()
            return

        fields = output_schema.get("fields") or []
        if not fields:
            with _run_jobs_lock:
                nid = _run_jobs.get(run_id, {}).get("run_node_id")
                _run_jobs[run_id] = {"status": "done", "error": "output_schema.fields is required", "run_node_id": nid}
            _persist_run_jobs()
            return
        shape_raw = (output_schema.get("return_shape") or "single").strip().lower()
        return_shape = shape_raw if shape_raw in ("single", "table") else "single"
        if return_shape == "table":
            RowModel = _build_output_model(fields)
            ResponseModel = _build_table_output_model(RowModel)
        else:
            ResponseModel = _build_output_model(fields)

        output_fields = []
        _seen: set[str] = set()
        for f in fields:
            display = f.get("key") or "field"
            name = _sanitize_field_name(display)
            if name in _seen:
                n = 1
                while f"{name}_{n}" in _seen:
                    n += 1
                name = f"{name}_{n}"
            _seen.add(name)
            output_fields.append({"display": display, "key": name})

        total = len(prompts)
        run_settings = _load_settings()
        run_max_tokens = run_settings.get("run_max_tokens") or DEFAULT_SETTINGS["run_max_tokens"]
        with _run_jobs_lock:
            _run_jobs[run_id]["total"] = total
            _run_jobs[run_id]["completed"] = 0
            _run_jobs[run_id]["results"] = []
            _run_jobs[run_id]["output_fields"] = output_fields
        results_by_input: dict[int, list[dict]] = {}

        run_max_retries = min(5, max(0, int(run_settings.get("run_max_retries", 0))))

        def process_one(row_index: int, prompt: str) -> tuple[int, list[dict]]:
            with _run_jobs_lock:
                if run_id in _run_cancelled:
                    return (row_index, [{"input_row_index": row_index, "output": None, "error": "Cancelled"}])
            items: list[dict] = []
            err_msg: str | None = None
            for attempt in range(run_max_retries + 1):
                with _run_jobs_lock:
                    if run_id in _run_cancelled:
                        return (row_index, [{"input_row_index": row_index, "output": None, "error": "Cancelled"}])
                items = []
                err_msg = None
                try:
                    _safe_print("\n" + _HL + _SEP + _R)
                    _safe_print(_HL + f"[Run] Row {row_index} PROMPT SENT TO LLM:" + _R)
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(prompt)
                    _safe_print(_HL + _SEP + _R + "\n")
                    out, used_fallback = llm_run_structured(
                        provider=provider,
                        model=model,
                        api_key=api_key,
                        prompt=prompt,
                        response_model=ResponseModel,
                        max_tokens=run_max_tokens,
                        return_shape=return_shape,
                    )
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(_HL + f"[Run] Row {row_index} LLM OUTPUT:" + _R)
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
                    _safe_print(_HL + _SEP + _R + "\n")
                    if return_shape == "table" and isinstance(out, dict) and "rows" in out:
                        out = out["rows"]
                    if _run_structured_output_is_empty(out, return_shape, output_fields):
                        err_msg = "Empty model output"
                        if attempt < run_max_retries:
                            _safe_print(
                                _HL + f"[Run] Row {row_index} empty output, retry {attempt + 1}/{run_max_retries}" + _R + "\n"
                            )
                            continue
                        items = []
                        items.append({"input_row_index": row_index, "output": None, "error": err_msg})
                        break
                    if return_shape == "table" and isinstance(out, list):
                        for row in out:
                            items.append({"input_row_index": row_index, "output": row if isinstance(row, dict) else {}, "error": None})
                    else:
                        items.append({"input_row_index": row_index, "output": out, "error": None})
                    break
                except Exception as e:
                    err_msg = str(e)
                if attempt < run_max_retries:
                    _safe_print(_HL + f"[Run] Row {row_index} error, retry {attempt + 1}/{run_max_retries}: {err_msg}" + _R + "\n")
                else:
                    items.append({"input_row_index": row_index, "output": None, "error": err_msg or "Error"})
            return (row_index, items)

        cancelled_early = False

        def _row_done_write_progress(row_index: int, items: list[dict]) -> None:
            nonlocal cancelled_early
            with _run_jobs_lock:
                if run_id in _run_cancelled:
                    cancelled_early = True
                elif (time.time() - _run_last_activity.get(run_id, 0)) > RUN_ABANDON_TIMEOUT_SEC:
                    cancelled_early = True
            results_by_input[row_index] = items
            if cancelled_early:
                return
            max_contiguous = 0
            for i in range(total):
                if i in results_by_input:
                    max_contiguous = i + 1
                else:
                    break
            merged = []
            for i in range(max_contiguous):
                items_i = results_by_input.get(i) or []
                if not items_i:
                    merged.append({"row_index": len(merged), "input_row_index": i, "output": None, "error": None})
                else:
                    for r in items_i:
                        merged.append({"row_index": len(merged), "input_row_index": i, "output": r["output"], "error": r["error"]})
            completed = max_contiguous
            with _run_jobs_lock:
                _run_jobs[run_id]["results"] = merged
                _run_jobs[run_id]["completed"] = completed
            _persist_run_jobs()

        # One LLM in-flight per run job (rows processed in order). Separate run jobs (e.g. different nodes) may still run at once.
        for i, prompt in enumerate(prompts):
            row_index, items = process_one(i, prompt)
            _row_done_write_progress(row_index, items)
            if cancelled_early:
                break

        with _run_jobs_lock:
            if run_id in _run_cancelled:
                _run_cancelled.discard(run_id)
            # 同上：只加入连续前缀
            max_contiguous = 0
            for i in range(total):
                if i in results_by_input:
                    max_contiguous = i + 1
                else:
                    break
            merged = []
            for i in range(max_contiguous):
                items_i = results_by_input.get(i) or []
                if not items_i:
                    merged.append({"row_index": len(merged), "input_row_index": i, "output": None, "error": None})
                else:
                    for r in items_i:
                        merged.append({"row_index": len(merged), "input_row_index": i, "output": r["output"], "error": r["error"]})
            completed = max_contiguous
            nid = _run_jobs.get(run_id, {}).get("run_node_id")
            _run_jobs[run_id] = {
                "status": "cancelled" if cancelled_early else "done",
                "results": merged,
                "output_fields": output_fields,
                "run_node_id": nid,
                "completed": completed,
                "total": total,
            }
        _persist_run_jobs()
    except Exception as e:
        _safe_print(_HL + "[Run] Error: " + _R + str(e))
        with _run_jobs_lock:
            nid = _run_jobs.get(run_id, {}).get("run_node_id")
            _run_jobs[run_id] = {"status": "done", "error": str(e), "run_node_id": nid}
        _persist_run_jobs()


@app.post("/api/run")
def run_prompts(body: RunRequest):
    """Start run in background; returns 202 with run_id. Poll GET /api/run/result/{run_id}. Worker stops if client stops polling."""
    run_id = str(uuid.uuid4())
    with _run_jobs_lock:
        # At most one active worker per canvas Run node: supersede any still-running job for this node.
        # (Rows within a single job are already processed sequentially in _do_run_work.)
        nid = body.run_node_id
        if nid:
            prev_id = _run_jobs_by_node.get(nid)
            if prev_id:
                prev_job = _run_jobs.get(prev_id)
                if prev_job and prev_job.get("status") == "running":
                    _run_cancelled.add(prev_id)
        _run_jobs[run_id] = {"status": "running", "run_node_id": body.run_node_id}
        if body.run_node_id:
            _run_jobs_by_node[body.run_node_id] = run_id
        _touch_run_activity(run_id)
    _persist_run_jobs()
    thread = threading.Thread(
        target=_do_run_work,
        args=(run_id, body.credential_id, body.prompts, body.output_schema),
        daemon=True,
    )
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=202,
        content={
            "run_id": run_id,
            "run_node_id": body.run_node_id,
        },
    )


@app.get("/api/run/result/{run_id}")
def get_run_result(run_id: str):
    """Return 202 while running, 200 when done. Each poll updates last_activity so worker knows client is still there."""
    with _run_jobs_lock:
        job = _run_jobs.get(run_id)
        if job and job.get("status") == "running":
            _touch_run_activity(run_id)
        if not job:
            raise HTTPException(status_code=404, detail="Run not found")
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        results = (job.get("results") or [])[:]
        output_fields = job.get("output_fields") or []
        job_error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "status": "running",
                "completed": completed,
                "total": total,
                "results": results,
                "output_fields": output_fields,
            },
        )
    if status == "cancelled":
        return {
            "status": "cancelled",
            "results": results,
            "output_fields": output_fields,
            "completed": completed,
            "total": total,
        }
    if job_error:
        return {"status": "done", "error": job_error, "results": None, "output_fields": None}
    return {
        "status": "done",
        "results": results,
        "output_fields": output_fields,
        "completed": completed,
        "total": total,
    }


@app.post("/api/review/analyze")
def review_analyze(body: ReviewRequest):
    """Start review job in background; returns 202 with review_id. Poll GET /api/review/result/{review_id}. Pipeline: review_pipeline.py (per-row analysis → localized prompt edits)."""
    review_id = str(uuid.uuid4())
    review_node_id = body.review_session_id or ""
    with _review_jobs_lock:
        # At most one active worker per Review node (same idea as POST /api/run + run_node_id).
        if review_node_id:
            prev_id = _review_jobs_by_node.get(review_node_id)
            if prev_id:
                prev_job = _review_jobs.get(prev_id)
                if prev_job and prev_job.get("status") == "running":
                    _review_cancelled.add(prev_id)
        _review_jobs[review_id] = {"status": "running", "events": [], "review_node_id": review_node_id}
        if review_node_id:
            _review_jobs_by_node[review_node_id] = review_id
    thread = threading.Thread(target=_do_review_work, args=(review_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"review_id": review_id, "review_node_id": review_node_id})


@app.get("/api/review/result/{review_id}")
def get_review_result(review_id: str):
    """Return 202 while running, 200 when done. Each poll returns events so far."""
    with _review_jobs_lock:
        job = _review_jobs.get(review_id)
        if not job:
            raise HTTPException(status_code=404, detail="Review not found")
        status = job.get("status")
        events = (job.get("events") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=202, content={"status": "running", "events": events})
    if status == "cancelled":
        return {"status": "cancelled", "events": events}
    if error:
        return {"status": "done", "error": error, "events": events}
    return {"status": "done", "events": events}


@app.get("/api/review/result/by-node/{review_node_id}")
def get_review_result_by_node(review_node_id: str):
    """Return latest review state for this node."""
    with _review_jobs_lock:
        review_id = _review_jobs_by_node.get(review_node_id)
        if not review_id:
            raise HTTPException(status_code=404, detail="No review found for this node")
        job = _review_jobs.get(review_id)
        if not job:
            raise HTTPException(status_code=404, detail="Review not found")
        status = job.get("status")
        events = (job.get("events") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=202, content={"review_id": review_id, "status": "running", "events": events})
    if status == "cancelled":
        return {"review_id": review_id, "status": "cancelled", "events": events}
    if error:
        return {"review_id": review_id, "status": "done", "error": error, "events": events}
    return {"review_id": review_id, "status": "done", "events": events}


@app.post("/api/review/cancel/{review_id}")
def cancel_review(review_id: str):
    """Mark review as cancelled; worker stops after current step."""
    with _review_jobs_lock:
        if review_id not in _review_jobs:
            raise HTTPException(status_code=404, detail="Review not found")
        job = _review_jobs[review_id]
        if job.get("status") != "running":
            return {"ok": True, "status": job.get("status")}
        _review_cancelled.add(review_id)
    return {"ok": True, "status": "cancelling"}


@app.post("/api/review/cancel/by-node/{review_node_id}")
def cancel_review_by_node(review_node_id: str):
    """Mark review as cancelled by node id."""
    with _review_jobs_lock:
        review_id = _review_jobs_by_node.get(review_node_id)
        if not review_id:
            raise HTTPException(status_code=404, detail="No review found for this node")
        job = _review_jobs.get(review_id)
        if job and job.get("status") == "running":
            _review_cancelled.add(review_id)
            return {"ok": True, "status": "cancelling"}
        return {"ok": True, "status": job.get("status") if job else "done"}


@app.post("/api/run/cancel/{run_id}")
def cancel_run(run_id: str):
    """Mark run as cancelled; worker stops after current row. Also updates last_activity."""
    with _run_jobs_lock:
        if run_id not in _run_jobs:
            raise HTTPException(status_code=404, detail="Run not found")
        job = _run_jobs[run_id]
        if job.get("status") != "running":
            return {"ok": True, "status": job.get("status")}
        _run_cancelled.add(run_id)
        _touch_run_activity(run_id)
    return {"ok": True, "status": "cancelling"}


@app.get("/api/run/result/by-node/{run_node_id}")
def get_run_result_by_node(run_node_id: str):
    """Return latest run state for this node. Each poll updates last_activity for that run."""
    with _run_jobs_lock:
        run_id = _run_jobs_by_node.get(run_node_id)
        if not run_id:
            raise HTTPException(status_code=404, detail="No run found for this node")
        job = _run_jobs.get(run_id)
        if job and job.get("status") == "running":
            _touch_run_activity(run_id)
        if not job:
            raise HTTPException(status_code=404, detail="Run not found")
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        results = (job.get("results") or [])[:]
        output_fields = job.get("output_fields") or []
        job_error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "run_id": run_id,
                "status": "running",
                "completed": completed,
                "total": total,
                "results": results,
                "output_fields": output_fields,
            },
        )
    if status == "cancelled":
        return {
            "run_id": run_id,
            "status": "cancelled",
            "results": results,
            "output_fields": output_fields,
            "completed": completed,
            "total": total,
        }
    if job_error:
        return {"run_id": run_id, "status": "done", "error": job_error, "results": None, "output_fields": None}
    return {"run_id": run_id, "status": "done", "results": results, "output_fields": output_fields}


# ---------- Review analyze worker (delegates to review_pipeline.py) ----------
def _review_is_cancelled(review_id: str | None) -> bool:
    """Check if client requested cancellation for this review job."""
    if not review_id:
        return False
    with _review_jobs_lock:
        return review_id in _review_cancelled


def _do_review_work(review_id: str, body: ReviewRequest) -> None:
    """Validate credential; run review_pipeline.run_review_pipeline; finalize job status."""

    def append_event(ev: dict) -> None:
        with _review_jobs_lock:
            job = _review_jobs.get(review_id)
            if job and isinstance(job.get("events"), list):
                job["events"].append(ev)

    try:
        if _review_is_cancelled(review_id):
            return
        items = _load_credentials()
        cred = None
        for item in items:
            if item.get("id") == body.credential_id:
                cred = item
                break
        if not cred:
            append_event({"type": "error", "detail": "Credential not found"})
            with _review_jobs_lock:
                if review_id in _review_jobs:
                    _review_jobs[review_id]["status"] = "done"
                    _review_jobs[review_id]["error"] = "Credential not found"
            return
        api_key = cred.get("api_key", "")
        if not api_key:
            append_event({"type": "error", "detail": "Missing API key"})
            with _review_jobs_lock:
                if review_id in _review_jobs:
                    _review_jobs[review_id]["status"] = "done"
                    _review_jobs[review_id]["error"] = "Missing API key"
            return
        if _review_is_cancelled(review_id):
            return

        from review_pipeline import run_review_pipeline

        provider = cred.get("provider", "openai")
        model = cred.get("llm", "") or ""
        st = _load_settings()
        max_tokens = int(st.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"])
        try:
            max_failed = int(st.get("review_max_failed_rows") or DEFAULT_SETTINGS["review_max_failed_rows"])
        except (TypeError, ValueError):
            max_failed = DEFAULT_SETTINGS["review_max_failed_rows"]
        max_failed = max(1, min(200, max_failed))

        run_review_pipeline(
            provider=provider,
            model=model,
            api_key=api_key,
            body=body,
            max_tokens=max_tokens,
            max_failed_inputs=max_failed,
            is_cancelled=lambda: _review_is_cancelled(review_id),
            append_event=append_event,
        )

        if _review_is_cancelled(review_id):
            with _review_jobs_lock:
                if review_id in _review_jobs:
                    _review_jobs[review_id]["status"] = "cancelled"
            return
        with _review_jobs_lock:
            if review_id in _review_jobs:
                _review_jobs[review_id]["status"] = "done"
    except Exception as e:
        _safe_print(_HL + "[Review] Error: " + _R + str(e))
        append_event({"type": "error", "detail": str(e)})
        with _review_jobs_lock:
            if review_id in _review_jobs:
                _review_jobs[review_id]["status"] = "done"
                _review_jobs[review_id]["error"] = str(e)
    finally:
        with _review_jobs_lock:
            _review_cancelled.discard(review_id)


# ---------- Finetune: Compositional segments + candidates ----------

class FinetuneSegmentsRequest(BaseModel):
    credential_id: str = Field(..., description="Credential id (LLM used for generation)")
    old_sentence: str = Field(default="", description="Original sentence (context)")
    new_sentence: str = Field(..., description="Improved sentence to split into segments")
    improvement_rationale: str = Field(default="", description="Why this change was proposed")
    max_segments: int = Field(default=5, ge=1, le=8, description="Max number of segments (1–8)")


class FinetuneCandidatesRequest(BaseModel):
    credential_id: str = Field(..., description="Credential id (LLM used for generation)")
    old_sentence: str = Field(default="")
    new_sentence: str = Field(..., description="Full improved sentence")
    improvement_rationale: str = Field(default="")
    segment_text: str = Field(..., description="The focus segment to paraphrase")
    prefix: str = Field(default="", description="Text before the segment in new_sentence")
    suffix: str = Field(default="", description="Text after the segment in new_sentence")
    section_context: str = Field(default="", description="Full prompt section/paragraph containing the sentence (read-only context for the LLM)")
    num_candidates: int = Field(default=4, ge=1, le=8, description="Number of candidates (1–8)")
    segment_index: int = Field(default=0, ge=0, description="0-based index of this segment among all segments")
    total_segments: int = Field(default=1, ge=1, description="Total number of segments")


@app.post("/api/review/finetune-compositional/segments")
def finetune_segments(body: FinetuneSegmentsRequest):
    """Split an improved sentence into contiguous segments for compositional finetune."""
    from review_finetune_compositional import compositional_finetune_segments
    items = _load_credentials()
    cred = next((c for c in items if c.get("id") == body.credential_id), None)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = cred.get("provider", "openai")
    settings = _load_settings()
    max_tokens = settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    _safe_print(_HL + "[Finetune] POST /segments" + _R + f"  model={model}  new_sentence={body.new_sentence[:80]!r}")
    try:
        segments = compositional_finetune_segments(
            provider=provider,
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
            old_sentence=body.old_sentence,
            new_sentence=body.new_sentence,
            improvement_rationale=body.improvement_rationale,
            max_segments=body.max_segments,
        )
    except Exception as e:
        _safe_print(_HL + "[Finetune] /segments ERROR" + _R + f"  {e}")
        raise HTTPException(status_code=400, detail=str(e))
    _safe_print(_HL + "[Finetune] /segments OK" + _R + f"  → {len(segments)} segment(s): {segments}")
    return {"segments": segments}


@app.post("/api/review/finetune-compositional/candidates")
def finetune_candidates(body: FinetuneCandidatesRequest):
    """Generate paraphrase candidates for one segment of the improved sentence."""
    from review_finetune_compositional import compositional_finetune_segment_candidates
    items = _load_credentials()
    cred = next((c for c in items if c.get("id") == body.credential_id), None)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = cred.get("provider", "openai")
    settings = _load_settings()
    max_tokens = settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    _safe_print(_HL + "[Finetune] POST /candidates" + _R + f"  model={model}  segment={body.segment_text[:60]!r}")
    try:
        candidates = compositional_finetune_segment_candidates(
            provider=provider,
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
            old_sentence=body.old_sentence,
            new_sentence=body.new_sentence,
            improvement_rationale=body.improvement_rationale,
            segment_text=body.segment_text,
            prefix=body.prefix,
            suffix=body.suffix,
            section_context=body.section_context,
            num_candidates=body.num_candidates,
            segment_index=body.segment_index,
            total_segments=body.total_segments,
        )
    except Exception as e:
        _safe_print(_HL + "[Finetune] /candidates ERROR" + _R + f"  {e}")
        raise HTTPException(status_code=400, detail=str(e))
    _safe_print(_HL + "[Finetune] /candidates OK" + _R + f"  → {len(candidates)} candidate(s): {candidates}")
    return {"candidates": candidates}


class FinetuneLogResultRequest(BaseModel):
    segments: list[str] = Field(default_factory=list, description="Segment texts")
    lattice: list[list[str]] = Field(default_factory=list, description="lattice[seg][cand]")
    best_picks: list[int] = Field(default_factory=list, description="Winning candidate index per segment")
    best_text: str = Field(default="", description="Composed best sentence")
    best_rate: float = Field(default=0.0, description="Best observed pass rate (0–1)")
    trials_run: int = Field(default=0, description="Number of Thompson-sampling trials actually run")
    trials_total: int = Field(default=0, description="Max trials configured")


@app.post("/api/review/finetune-compositional/log-result")
def finetune_log_result(body: FinetuneLogResultRequest):
    """Log the final finetune result to the terminal for visibility. No persistence."""
    rate_pct = f"{body.best_rate * 100:.1f}%"
    _safe_print("")
    _safe_print(_HL + "[Finetune] ══════════════════ RESULT ══════════════════════════════" + _R)
    _safe_print(_HL + f"[Finetune]  Trials: {body.trials_run} / {body.trials_total}   Best pass rate: {rate_pct}" + _R)
    if body.segments and body.lattice and body.best_picks:
        _safe_print(_HL + "[Finetune] ── Winner per segment ────────────────────────────────" + _R)
        for i, (seg, cands, pick) in enumerate(zip(body.segments, body.lattice, body.best_picks)):
            chosen = cands[pick] if 0 <= pick < len(cands) else "?"
            orig_marker = "  ← original" if chosen == seg else ""
            _safe_print(f"[Finetune]   [{i}] cand[{pick}]{orig_marker}")
            _safe_print(f"[Finetune]        {chosen!r}")
    _safe_print(_HL + "[Finetune] ── Best sentence ──────────────────────────────────────" + _R)
    _safe_print(f"[Finetune]   {body.best_text!r}")
    _safe_print(_HL + "[Finetune] ══════════════════════════════════════════════════════════" + _R)
    _safe_print("")
    return {"ok": True}
