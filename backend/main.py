from pathlib import Path
import json
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, List, Literal, Optional

# ANSI codes for terminal highlight (all yellow; supported on Windows 10+ and Unix)
_HL = "\033[1;33m"   # bold yellow
_R = "\033[0m"       # reset
_SEP = "=" * 60      # unified separator for LLM prompt/output logs


def _safe_print(s: str) -> None:
    """Print to stdout without UnicodeEncodeError on Windows (GBK console)."""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        print(s)
    except UnicodeEncodeError:
        sys.stdout.write((s + "\n").encode(enc, errors="replace").decode(enc))

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, create_model

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

# Credential storage path (not committed to git)
DATA_DIR = Path(__file__).resolve().parent / "data"
CREDENTIALS_FILE = DATA_DIR / "credentials.json"
RUN_JOBS_FILE = DATA_DIR / "run_jobs.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "default_run_credential_id": "",
    "default_review_credential_id": "",
    "default_review_assistant_credential_id": "",
    "run_concurrency": 1,
    "review_concurrency": 1,
    "run_max_tokens": 8192,
    "review_max_tokens": 32768,
    "run_max_retries": 2,
    "review_max_failed_rows": 30,
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
    print(f"[backend] main.py loaded from: {Path(__file__).resolve()}")
    print(f"[backend] MODELS={len(MODELS)}, PROVIDERS={len(PROVIDERS)}")


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
    default_review_assistant_credential_id: str | None = None
    run_concurrency: int | None = Field(default=None, ge=1, le=4)
    review_concurrency: int | None = Field(default=None, ge=1, le=4)
    run_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    review_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    run_max_retries: int | None = Field(default=None, ge=0, le=5)
    review_max_failed_rows: int | None = Field(
        default=None,
        ge=1,
        le=200,
        description="Max unmatched rows to diagnose per Review batch (per-LLM-call row analysis)",
    )


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
    matched: bool
    run_output: dict = Field(default_factory=dict, description="Model output for this row")
    expected: str = Field(default="", description="Expected value(s) from ground truth")
    comparison_types: list[str] | None = Field(default=None, description="Per-rule comparison: e.g. ['field_key: Exact match', 'field_key: Result contains ground truth']")
    comment: str | None = Field(default=None, description="User comment if any")
    row_input: dict | None = Field(default=None, description="Input key-values used to fill the prompt for this row; used during screening when LLM requests it")


class ReviewRequest(BaseModel):
    credential_id: str
    review_session_id: str | None = Field(default=None, description="Frontend session id for cancellation; pass reviewNodeId")
    prompt_sections: list[dict] = Field(..., description="List of {name, content} for each section")
    run_results: list[dict] = Field(default_factory=list, description="List of {row_index, output}")
    output_fields: list[dict] = Field(default_factory=list, description="List of {key, display}; used when output_schema not provided")
    output_schema: dict | None = Field(default=None, description="Same as run: return_shape + fields [{ key, type, description?, allow_none? }]; when set, used instead of output_return_shape + output_fields for prompts")
    output_return_shape: str = Field(default="single", description="Fallback when output_schema not provided")
    comparison_rows: list[ReviewComparisonRow] = Field(default_factory=list, description="Per-row match result and context")
    all_rows_matched: bool | None = Field(default=None, description="If True, frontend says all rows matched; backend will force empty suggestions")


class ReviewSuggestion(BaseModel):
    name: str = Field(..., description="Short name summarizing this change (e.g. 'Clarify output format')")
    section_index: int = Field(..., ge=0, description="0-based index of the section to change")
    old_sentence: str = Field(..., description="Exact sentence in the section to replace (one sentence only)")
    new_sentence: str = Field(..., description="Replacement for that one sentence")
    reason: str = Field(..., description="Why this change is suggested")
    row_indices: list[int] = Field(default_factory=list, description="0-based row indices this suggestion aims to fix")


class DesignSuggestion(BaseModel):
    """Global design guidance only; not sentence-level edits. Shown without accept/revert."""
    name: str = Field(..., description="Short title (e.g. 'Consider splitting sections')")
    reason: str = Field(..., description="One or two sentences of design guidance")


class ReviewResult(BaseModel):
    summary: str = Field(..., description="Brief overall analysis")
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete edit suggestions")
    design_suggestions: list[DesignSuggestion] = Field(default_factory=list, description="Global design guidance only; no accept/revert in UI")
    data_refinement: list[dict] = Field(default_factory=list, description="GT question summary: [{row_indices, reason}]")


# Review pipeline — diagnosis phase: per-row LLM output
class PerRowDiagnosis(BaseModel):
    row_index: int = Field(..., description="0-based row index")
    root_cause: str = Field(..., description="Root cause analysis")
    gt_questioned: bool = Field(default=False, description="Whether GT is questioned")
    gt_reason: str | None = Field(default=None, description="Reason for questioning (if gt_questioned)")
    section_index_suggestions: list[int] = Field(default_factory=list, description="0-based section indices to change")
    micro_suggestion: str = Field(default="", description="Micro suggestion for this row")


# Review pipeline — repair phase: data refinement item
class DataRefinementItem(BaseModel):
    row_indices: list[int] = Field(default_factory=list, description="Row indices to fix (1-based for display)")
    reason: str = Field(default="", description="Aggregated reason for questioning")


# Review pipeline — repair phase: structured LLM output
class RepairSynthesisResult(BaseModel):
    suggestions: list[ReviewSuggestion] = Field(default_factory=list)
    data_refinement: list[DataRefinementItem] = Field(default_factory=list)


# Review pipeline — screening phase: routing only (no design_suggestions)
class ScreeningResult(BaseModel):
    route: Literal["REWRITE", "ANALYZE"] = Field(..., description="REWRITE = prompt broken, repair via full rewrite; ANALYZE = run diagnosis then repair")


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
    """Return current settings (default model, concurrency, max_tokens)."""
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
        print(f"[Run] persist failed: {e}", file=sys.stderr)


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
        print(f"[Run] load persisted jobs failed: {e}", file=sys.stderr)


_load_run_jobs()


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
        schema_repr = json.dumps(output_schema, ensure_ascii=False, indent=2)

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
        run_concurrency = run_settings.get("run_concurrency") or DEFAULT_SETTINGS["run_concurrency"]
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
                    if return_shape == "table" and isinstance(out, list):
                        for row in out:
                            items.append({"input_row_index": row_index, "output": row if isinstance(row, dict) else {}, "error": None})
                    else:
                        items.append({"input_row_index": row_index, "output": out, "error": None})
                    is_empty = not items or (out is None) or (isinstance(out, dict) and len(out) == 0)
                    if is_empty:
                        err_msg = "Empty output"
                    else:
                        break
                except Exception as e:
                    err_msg = str(e)
                if attempt < run_max_retries:
                    _safe_print(_HL + f"[Run] Row {row_index} {'empty' if err_msg == 'Empty output' else 'error'}, retry {attempt + 1}/{run_max_retries}: {err_msg}" + _R + "\n")
                else:
                    items.append({"input_row_index": row_index, "output": None, "error": err_msg or "Empty output"})
            return (row_index, items)

        cancelled_early = False
        with ThreadPoolExecutor(max_workers=run_concurrency) as ex:
            futures = {ex.submit(process_one, i, p): i for i, p in enumerate(prompts)}
            for future in as_completed(futures):
                row_index, items = future.result()
                with _run_jobs_lock:
                    if run_id in _run_cancelled:
                        cancelled_early = True
                    elif (time.time() - _run_last_activity.get(run_id, 0)) > RUN_ABANDON_TIMEOUT_SEC:
                        cancelled_early = True
                results_by_input[row_index] = items
                if cancelled_early:
                    for f in futures:
                        f.cancel()
                    break
                # 只加入从 0 开始的连续 input 前缀：1,2 完成但 3 未完成则只显示 1,2；4 完成也不显示
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
                        merged.append({"row_index": len(merged), "input_row_index": i, "output": None, "error": "Empty output"})
                    else:
                        for r in items_i:
                            merged.append({"row_index": len(merged), "input_row_index": i, "output": r["output"], "error": r["error"]})
                completed = max_contiguous
                with _run_jobs_lock:
                    _run_jobs[run_id]["results"] = merged
                    _run_jobs[run_id]["completed"] = completed
                _persist_run_jobs()

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
                    merged.append({"row_index": len(merged), "input_row_index": i, "output": None, "error": "Empty output"})
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
        content={"run_id": run_id, "run_node_id": body.run_node_id},
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
    """Start review in background (screening → diagnosis if ANALYZE → repair); returns 202 with review_id. Poll GET /api/review/result/{review_id}. Worker stops when cancelled."""
    review_id = str(uuid.uuid4())
    review_node_id = body.review_session_id or ""
    with _review_jobs_lock:
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


# ---------- Review: screening -> diagnosis -> repair (see _do_review_work) ----------
def _review_output_schema_lines(body: ReviewRequest) -> tuple[list[str], list[str]]:
    """Return (lines for prompt, list of field keys for constraints). When output_schema present use it; else derive keys from output_fields."""
    schema = body.output_schema if isinstance(body.output_schema, dict) else None
    if schema and (schema.get("fields") or schema.get("return_shape") is not None):
        shape = (schema.get("return_shape") or "single").strip().lower()
        if shape not in ("single", "table"):
            shape = "single"
        lines = [f"return_shape: {shape} (one object per run)" if shape == "single" else "return_shape: table (array of objects per run)"]
        keys = []
        for f in schema.get("fields") or []:
            key = (f.get("key") or "").strip()
            if not key:
                continue
            keys.append(key)
            typ = (f.get("type") or "str").strip()
            desc = (f.get("description") or "").strip()
            allow_none = f.get("allow_none") or f.get("allowNone") is True
            part = f"  - {key}: {typ}"
            if desc:
                part += f" — {desc}"
            if allow_none:
                part += " (allow_none)"
            lines.append(part)
        return lines, keys
    keys = [(f.get("key") or "").strip() for f in (body.output_fields or []) if f and (f.get("key") or "").strip()]
    return [], keys


def _review_all_matched(body: ReviewRequest) -> bool:
    """True if frontend says all rows matched, or we infer from comparison_rows (empty => True)."""
    if body.all_rows_matched is not None:
        return body.all_rows_matched
    comparison_rows = body.comparison_rows or []
    return all(r.matched for r in comparison_rows) if comparison_rows else True


# Screening phase is LLM-only (see _run_screening_llm).
RouteDecision = Literal["REWRITE", "ANALYZE"]


# Comparison rule labels (must match frontend MATCH_TYPE_LABELS) and their definitions for LLM prompts.
REVIEW_COMPARISON_RULES_BLOCK = """
- **Exact match**: Model output must equal the expected value exactly (after trimming). No extra or missing characters.
- **Result contains ground truth**: The model output string must contain the expected value (expected is a substring of run output).
- **Ground truth contains result**: The expected value string must contain the model output (run output is a substring of expected).
- **Numeric equality**: Both sides are normalized and compared as numbers; they must be numerically equal.
"""


def _review_compared_fields_and_rules(comparison_rows: list[ReviewComparisonRow]) -> tuple[list[str], str]:
    """From comparison_rows, return (list of compared output field names, full comparison rules text for prompt)."""
    for row in comparison_rows or []:
        if not row.comparison_types:
            continue
        fields: list[str] = []
        for ct in row.comparison_types:
            # Format is "outputKey: Label" e.g. "summary: Exact match"
            if ": " in ct:
                key = ct.split(": ", 1)[0].strip()
                if key and key not in fields:
                    fields.append(key)
        if fields:
            block = "## Compared fields (only these were used to decide matched / NOT MATCHED)\n"
            block += "When giving reasons or suggestions, only refer to these fields. Do not cite or reason about other keys in the model output; they were not part of the scoring.\n"
            block += "Fields: " + ", ".join(fields) + "\n\n"
            block += "## Comparison rules (how each field was judged)\n"
            block += REVIEW_COMPARISON_RULES_BLOCK.strip()
            return fields, block
    return [], ""


def _build_screening_prompt(body: ReviewRequest) -> str:
    """Screening phase: LLM prompt for routing only (REWRITE vs ANALYZE)."""
    lines = [
        "You are screening prompts for a review pipeline. Evaluate the prompt under review and output only the route.",
        "",
        "## Routing rules",
        "1. Instruction completeness: Choose REWRITE if the prompt is missing Role/Task, or is too short (e.g. one-liner, <50 chars, or <2 sections).",
        "2. Schema alignment: Choose REWRITE if the prompt mentions fewer than 30% of the output_schema field keys (so the model may not produce the expected fields).",
        "3. Otherwise choose ANALYZE.",
        "",
        "Route meanings:",
        "- REWRITE: Prompt is structurally broken; the pipeline will generate an expert template from scratch.",
        "- ANALYZE: Prompt is acceptable; the pipeline will run per-row diagnosis and then repair (synthesize targeted edit suggestions).",
        "",
        "## Input under review",
        "",
        "### Prompt sections",
    ]
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- Section {i}: {name} ---")
        lines.append(content)
        lines.append("")
    schema_lines, _ = _review_output_schema_lines(body)
    lines.append("### Output schema")
    if schema_lines:
        lines.extend(schema_lines)
    else:
        schema = body.output_schema if isinstance(body.output_schema, dict) else {}
        if not schema and body.output_fields:
            schema = {"fields": body.output_fields}
        lines.append(json.dumps(schema, ensure_ascii=False, indent=2) if schema else "(none)")
    lines.append("")
    lines.append("## Output format")
    lines.append("Respond with JSON only: {\"route\": \"REWRITE\" or \"ANALYZE\"}.")
    return "\n".join(lines)


def _run_screening_llm(body: ReviewRequest, provider: str, model: str, api_key: str, max_tokens: int) -> tuple[RouteDecision, list[DesignSuggestion]]:
    """Call LLM for screening (routing only). Returns (route, []) — design_suggestions always empty."""
    prompt = _build_screening_prompt(body)
    out, _ = llm_run_structured(
        provider=provider,
        model=model,
        api_key=api_key,
        prompt=prompt,
        response_model=ScreeningResult,
        max_tokens=max_tokens,
    )
    if not isinstance(out, dict):
        out = out.model_dump() if hasattr(out, "model_dump") else {}
    route = out.get("route") or "ANALYZE"
    if route not in ("REWRITE", "ANALYZE"):
        route = "ANALYZE"
    return route, []


# ---------- Diagnosis phase: per-row prompt ----------
def _build_diagnosis_prompt(row: ReviewComparisonRow, rules_block: str, schema_lines: list[str]) -> str:
    """Single failed row: Full Input + Full Output + GT + Matching Rules."""
    lines = [
        "You are a Prompt debugging expert. Analyze this single failed case to find the root cause.",
        "",
        "## Full Input (key-values used to fill the prompt for this row)",
        json.dumps(row.row_input or {}, ensure_ascii=False, indent=2),
        "",
        "## Model Output (Full Output)",
        json.dumps(row.run_output, ensure_ascii=False, indent=2),
        "",
        "## Ground Truth (Expected)",
        str(row.expected or ""),
        "",
    ]
    if row.comparison_types:
        lines.append("## Comparison types for this row")
        lines.append(", ".join(row.comparison_types))
        lines.append("")
    lines.append("## Matching Rules")
    lines.append(rules_block)
    lines.append("")
    if schema_lines:
        lines.append("## Output schema")
        lines.extend(schema_lines)
        lines.append("")
    lines.extend([
        "## Task",
        "1. Root cause: Why did the model fail? (unclear instruction, weak constraint, misleading input, etc.)",
        "2. GT questioned: If the model output seems more plausible than expected, set gt_questioned=true and explain in gt_reason.",
        "3. Micro suggestion: Give a brief improvement direction for this row (do NOT write exact new_sentence; describe what to clarify).",
        "",
        "Respond with JSON: {\"row_index\": <0-based>, \"root_cause\": \"...\", \"gt_questioned\": false, \"gt_reason\": null, \"section_index_suggestions\": [0, 1], \"micro_suggestion\": \"...\"}.",
    ])
    return "\n".join(lines)


# ---------- Repair phase: synthesis prompt (after diagnosis) ----------
def _build_repair_synthesis_prompt(body: ReviewRequest, diagnoses: list[PerRowDiagnosis]) -> str:
    """ANALYZE path: aggregate diagnoses, output suggestions + data_refinement."""
    all_matched = _review_all_matched(body)
    _, schema_keys = _review_output_schema_lines(body)
    section_names = [(s.get("name") or "").strip() for s in (body.prompt_sections or []) if s and (s.get("name") or "").strip()]
    lines = [
        "You have per-row diagnosis reports. Synthesize them into global edit suggestions.",
        "",
        "## Task",
        "1. Merge similar root causes (e.g. 20 rows all 'cannot identify negative sentiment' -> one suggestion).",
        "2. Identify global logic gaps.",
        "3. Output: suggestions (old_sentence -> new_sentence) and data_refinement (rows where GT may be wrong).",
        "4. row_indices (optional): Only include when a suggestion clearly targets specific failed rows. Use 0-based indices (Row 1 -> 0). Omit or use [] when the suggestion is general.",
        "",
        "**Do NOT put correct/expected answers into new_sentence.** Improve instructions, criteria, or wording only.",
        "",
        "## Critical: old_sentence",
        "Copy character-for-character from the section text. One sentence or one line per suggestion.",
        "",
        "## Critical: new_sentence",
        "Must not contain expected output. Change instructions or criteria only.",
        "**new_sentence is for the user's prompt (extraction/evaluation model), NOT for this review.** Do NOT add meta-instructions like 'merge root causes', 'identify global logic gaps', 'consolidate suggestions'—those describe the synthesis task, not the user's task.",
        "",
    ]
    if all_matched:
        lines.append("**All rows matched.** Output 1–2 optional small improvements.")
        lines.append("")
    _, rules_block = _review_compared_fields_and_rules(body.comparison_rows or [])
    if rules_block:
        lines.append(rules_block)
        lines.append("")
    lines.append("## Sections (copy exact substring for old_sentence)")
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- Section index {i}: {name} ---")
        lines.append(content)
        lines.append("")
    lines.append("## Per-row diagnoses (for synthesis)")
    for d in diagnoses:
        gt_note = f" | GT questioned: {d.gt_reason}" if d.gt_questioned and d.gt_reason else ""
        lines.append(f"Row {d.row_index + 1}: {d.root_cause} | sections: {d.section_index_suggestions} | micro: {d.micro_suggestion}{gt_note}")
    lines.append("")
    if schema_keys or section_names:
        lines.append("## Constraints")
        lines.append("Do NOT rename output schema field keys or section names.")
        lines.append("")
    lines.append("## Ground truth issues")
    lines.append(
        "For rows where gt_questioned=true, add one data_refinement item with row_indices (1-based, from the diagnoses above) and reason. "
        "Do not add data_refinement for prompt/extraction issues."
    )
    lines.append("")
    lines.append(
        "Respond with JSON: {\"suggestions\": [{\"name\": \"...\", \"section_index\": 0, \"old_sentence\": \"...\", \"new_sentence\": \"...\", \"reason\": \"...\", \"row_indices\": []}, ...], "
        "\"data_refinement\": [{\"row_indices\": [1, 3], \"reason\": \"...\"}, ...]}. Put actual 1-based row numbers from the diagnoses in row_indices, not literal 1,3. Use row_indices: [] for suggestions when not targeting specific rows."
    )
    return "\n".join(lines)


def _build_repair_rewrite_prompt(body: ReviewRequest) -> str:
    """REWRITE path: prompt is broken; generate expert template from scratch."""
    schema_lines, schema_keys = _review_output_schema_lines(body)
    lines = [
        "The user's prompt has serious structural problems (missing Role/Task or schema misalignment). "
        "Generate an expert-level prompt template from scratch based on the output_schema and the user's intent (inferred from the broken prompt).",
        "",
        "## Output schema",
    ]
    if schema_lines:
        lines.extend(schema_lines)
    else:
        lines.append(", ".join(schema_keys) if schema_keys else "(none)")
    lines.append("")
    lines.append("## Current (broken) prompt (for reference only)")
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- {i}: {name} ---")
        lines.append(content)
        lines.append("")
    lines.append("## Task")
    lines.append(
        "Output suggestions that replace entire sections. Use old_sentence as the full section content to replace, "
        "and new_sentence as the new expert template for that section. Include Role, Task, and clear instructions."
    )
    lines.append("")
    lines.append(
        "Respond with JSON: {\"suggestions\": [{\"name\": \"...\", \"section_index\": 0, \"old_sentence\": \"<full section>\", \"new_sentence\": \"<new section>\", \"reason\": \"...\"}, ...], \"data_refinement\": []}."
    )
    return "\n".join(lines)


def _review_is_cancelled(review_id: str | None) -> bool:
    """Check if client requested cancellation for this review job."""
    if not review_id:
        return False
    with _review_jobs_lock:
        return review_id in _review_cancelled


def _do_review_work(review_id: str, body: ReviewRequest) -> None:
    """Background worker: screening → diagnosis (if ANALYZE) → repair; appends events to job. Stops when cancelled."""
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
        model = cred.get("llm", "")
        api_key = cred.get("api_key", "")
        if not api_key:
            append_event({"type": "error", "detail": "Missing API key"})
            with _review_jobs_lock:
                if review_id in _review_jobs:
                    _review_jobs[review_id]["status"] = "done"
                    _review_jobs[review_id]["error"] = "Missing API key"
            return
        provider = cred.get("provider", "openai")
        review_settings = _load_settings()
        review_concurrency = review_settings.get("review_concurrency") or DEFAULT_SETTINGS["review_concurrency"]
        review_max_tokens = review_settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
        review_max_failed_rows = review_settings.get("review_max_failed_rows") or DEFAULT_SETTINGS["review_max_failed_rows"]
        try:
            review_max_failed_rows = int(review_max_failed_rows)
        except (TypeError, ValueError):
            review_max_failed_rows = DEFAULT_SETTINGS["review_max_failed_rows"]
        review_max_failed_rows = max(1, min(200, review_max_failed_rows))

        # Screening (LLM only)
        screening_prompt = _build_screening_prompt(body)
        route, design_suggestions = _run_screening_llm(body, provider, model, api_key, review_max_tokens)
        all_matched = _review_all_matched(body)
        design_list = [s.model_dump() if hasattr(s, "model_dump") else s for s in design_suggestions]
        _safe_print("\n" + _HL + _SEP + _R)
        _safe_print(_HL + "[Review] Screening PROMPT:" + _R)
        _safe_print(_HL + _SEP + _R)
        _safe_print(screening_prompt)
        _safe_print(_HL + _SEP + _R)
        _safe_print(_HL + "[Review] Screening OUTPUT:" + _R)
        _safe_print("route: " + route + ", design_suggestions: " + json.dumps(design_list, ensure_ascii=False, indent=2))
        _safe_print(_HL + _SEP + _R + "\n")
        if _review_is_cancelled(review_id):
            return
        append_event({"type": "design", "design_suggestions": design_list, "route": route})

        if route == "REWRITE":
            if _review_is_cancelled(review_id):
                return
            repair_prompt = _build_repair_rewrite_prompt(body)
            _safe_print("\n" + _HL + _SEP + _R)
            _safe_print(_HL + "[Review] Repair (rewrite) PROMPT SENT TO LLM:" + _R)
            _safe_print(_HL + _SEP + _R)
            _safe_print(repair_prompt)
            _safe_print(_HL + _SEP + _R + "\n")
            repair_result, _ = llm_run_structured(
                provider=provider, model=model, api_key=api_key, prompt=repair_prompt,
                response_model=RepairSynthesisResult, max_tokens=review_max_tokens,
            )
            _safe_print(_HL + _SEP + _R)
            _safe_print(_HL + "[Review] Repair (rewrite) LLM OUTPUT:" + _R)
            _safe_print(_HL + _SEP + _R)
            _safe_print(json.dumps(repair_result.model_dump() if hasattr(repair_result, "model_dump") else repair_result, ensure_ascii=False, indent=2, default=str))
            _safe_print(_HL + _SEP + _R + "\n")
            fs = repair_result if hasattr(repair_result, "suggestions") else RepairSynthesisResult(**(repair_result if isinstance(repair_result, dict) else {}))
            raw_suggestions = list(getattr(fs, "suggestions", []) or [])
            data_refinement = [x.model_dump() if hasattr(x, "model_dump") else x for x in (getattr(fs, "data_refinement", None) or [])]
            if _review_is_cancelled(review_id):
                return
            append_event({"type": "plan", "summary": "REWRITE: generating expert template.", "diagnosis_total": 0})
        else:
            unmatched = [r for r in (body.comparison_rows or []) if not r.matched]
            schema_lines, _ = _review_output_schema_lines(body)
            _, rules_block = _review_compared_fields_and_rules(body.comparison_rows or [])

            if all_matched:
                diagnoses = [PerRowDiagnosis(row_index=0, root_cause="all matched", gt_questioned=False, section_index_suggestions=[0], micro_suggestion="Optional polish")]
                if _review_is_cancelled(review_id):
                    return
                append_event({"type": "plan", "summary": "All rows matched.", "diagnosis_total": 0})
            elif not unmatched:
                if _review_is_cancelled(review_id):
                    return
                append_event({"type": "done"})
                with _review_jobs_lock:
                    if review_id in _review_jobs:
                        _review_jobs[review_id]["status"] = "done"
                return
            else:
                to_analyze = unmatched[:review_max_failed_rows]
                if _review_is_cancelled(review_id):
                    return
                append_event({"type": "plan", "summary": f"Analyzing {len(to_analyze)} failed rows.", "diagnosis_total": len(to_analyze)})
                if _review_is_cancelled(review_id):
                    return

                def analyze_one(row: ReviewComparisonRow) -> PerRowDiagnosis:
                    prompt = _build_diagnosis_prompt(row, rules_block, schema_lines)
                    _safe_print("\n" + _HL + _SEP + _R)
                    _safe_print(_HL + f"[Review] Diagnosis row {row.row_index} PROMPT SENT TO LLM:" + _R)
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(prompt)
                    _safe_print(_HL + _SEP + _R + "\n")
                    result, _ = llm_run_structured(
                        provider=provider, model=model, api_key=api_key, prompt=prompt,
                        response_model=PerRowDiagnosis, max_tokens=review_max_tokens,
                    )
                    d = result if isinstance(result, PerRowDiagnosis) else PerRowDiagnosis(**(result if isinstance(result, dict) else result.model_dump()))
                    d.row_index = row.row_index
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(_HL + f"[Review] Diagnosis row {row.row_index} LLM OUTPUT:" + _R)
                    _safe_print(_HL + _SEP + _R)
                    _safe_print(json.dumps(d.model_dump(), ensure_ascii=False, indent=2))
                    _safe_print(_HL + _SEP + _R + "\n")
                    return d

                diagnoses_list: list[PerRowDiagnosis] = []
                with ThreadPoolExecutor(max_workers=review_concurrency) as ex:
                    futures = {ex.submit(analyze_one, r): r for r in to_analyze}
                    done = 0
                    for future in as_completed(futures):
                        if _review_is_cancelled(review_id):
                            break
                        d_row = future.result()
                        diagnoses_list.append(d_row)
                        done += 1
                        if _review_is_cancelled(review_id):
                            break
                        append_event({"type": "diagnosis_row", "row_index": d_row.row_index, "done": done, "total": len(to_analyze)})
                if _review_is_cancelled(review_id):
                    with _review_jobs_lock:
                        if review_id in _review_jobs:
                            _review_jobs[review_id]["status"] = "cancelled"
                    return
                diagnoses_list.sort(key=lambda d: d.row_index)
                diagnoses = diagnoses_list

            # Repair (synthesis from diagnoses, or polish when all matched)
            if _review_is_cancelled(review_id):
                with _review_jobs_lock:
                    if review_id in _review_jobs:
                        _review_jobs[review_id]["status"] = "cancelled"
                return
            repair_prompt = _build_repair_synthesis_prompt(body, diagnoses)
            _safe_print("\n" + _HL + _SEP + _R)
            _safe_print(_HL + "[Review] Repair (synthesis) PROMPT SENT TO LLM:" + _R)
            _safe_print(_HL + _SEP + _R)
            _safe_print(repair_prompt)
            _safe_print(_HL + _SEP + _R + "\n")
            repair_result, _ = llm_run_structured(
                provider=provider, model=model, api_key=api_key, prompt=repair_prompt,
                response_model=RepairSynthesisResult, max_tokens=review_max_tokens,
            )
            _safe_print(_HL + _SEP + _R)
            _safe_print(_HL + "[Review] Repair (synthesis) LLM OUTPUT:" + _R)
            _safe_print(_HL + _SEP + _R)
            _safe_print(json.dumps(repair_result.model_dump() if hasattr(repair_result, "model_dump") else repair_result, ensure_ascii=False, indent=2, default=str))
            _safe_print(_HL + _SEP + _R + "\n")
            fs = repair_result if hasattr(repair_result, "suggestions") else RepairSynthesisResult(**(repair_result if isinstance(repair_result, dict) else {}))
            raw_suggestions = list(getattr(fs, "suggestions", []) or [])
            if all_matched and len(raw_suggestions) > 2:
                raw_suggestions = raw_suggestions[:2]
            data_refinement = [x.model_dump() if hasattr(x, "model_dump") else x for x in (getattr(fs, "data_refinement", None) or [])]

        if _review_is_cancelled(review_id):
            with _review_jobs_lock:
                if review_id in _review_jobs:
                    _review_jobs[review_id]["status"] = "cancelled"
            return
        batch = []
        for s in raw_suggestions:
            s_dict = s.model_dump() if hasattr(s, "model_dump") else s
            if isinstance(s_dict, dict):
                if (s_dict.get("section_index") or 0) < 0 and body.prompt_sections:
                    s_dict["section_index"] = 0
                batch.append(s_dict)
        if batch:
            append_event({"type": "suggestions", "suggestions": batch})
        if data_refinement:
            if _review_is_cancelled(review_id):
                with _review_jobs_lock:
                    if review_id in _review_jobs:
                        _review_jobs[review_id]["status"] = "cancelled"
                return
            append_event({"type": "data_refinement", "data_refinement": data_refinement})
        append_event({"type": "done"})
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


