from pathlib import Path
import json
import re
import sys
import threading
import time
import uuid
from typing import Any, List, Optional


# ANSI codes for terminal highlight (all yellow; supported on Windows 10+ and Unix)
_HL = "\033[1;33m"   # bold yellow
_R = "\033[0m"       # reset


def _safe_print(s: str) -> None:
    """Print to stdout without UnicodeEncodeError on Windows (GBK console)."""
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"
    try:
        print(s)
    except UnicodeEncodeError:
        sys.stdout.write((s + "\n").encode(enc, errors="replace").decode(enc))

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, create_model

from llm import chat as llm_chat, run_structured as llm_run_structured

app = FastAPI()

# 允许 Electron 渲染进程（Vite 开发服务器 localhost:5173）跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 凭证存储路径（不提交到 git）
DATA_DIR = Path(__file__).resolve().parent / "data"
CREDENTIALS_FILE = DATA_DIR / "credentials.json"
RUN_JOBS_FILE = DATA_DIR / "run_jobs.json"


# 支持的提供商与模型（扩展时在此维护，前端通过 GET /api/credentials/models 获取）
PROVIDERS = [
    {"id": "openai", "name": "OpenAI"},
    {"id": "anthropic", "name": "Anthropic"},
    {"id": "google", "name": "Google"},
    {"id": "deepseek", "name": "DeepSeek"},
    {"id": "mistral", "name": "Mistral"},
    {"id": "bedrock", "name": "Amazon Bedrock"},
]
# name = 下拉框显示名，与 API 传入的模型名一致（GPT 用 id，Anthropic 用 API 实际模型 id）
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
    """启动时打印，便于确认加载的是否为本文件。"""
    print(f"[backend] main.py loaded from: {Path(__file__).resolve()}")
    print(f"[backend] MODELS={len(MODELS)}, PROVIDERS={len(PROVIDERS)}")


_log_backend_version()


def _infer_provider(llm: str) -> str:
    """从 llm 推断 provider，兼容旧数据无 provider 字段。"""
    for m in MODELS:
        if m["id"] == llm:
            return m["provider"]
    return "openai"


def _check_model_for_provider(provider: str, llm: str) -> None:
    """校验 (provider, llm) 在 MODELS 中为合法组合，否则抛出 HTTPException。"""
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
    row_input: dict | None = Field(default=None, description="Input key-values used to fill the prompt for this row; used in Step 1b when LLM requests it")


class ReviewRequest(BaseModel):
    credential_id: str
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
    old_sentence: str = Field(..., description="Exact sentence in the section to replace (one sentence only); use '(no edit)' when ground_truth_issue is true")
    new_sentence: str = Field(..., description="Replacement for that one sentence; use '(no edit)' when ground_truth_issue is true")
    reason: str = Field(..., description="Why this change is suggested")
    ground_truth_issue: bool = Field(default=False, description="If true, informational only: failure may be due to ground truth error; no prompt edit suggested")


class DesignSuggestion(BaseModel):
    """Global design guidance only; not sentence-level edits. Shown without accept/revert."""
    name: str = Field(..., description="Short title (e.g. 'Consider splitting sections')")
    reason: str = Field(..., description="One or two sentences of design guidance")


class ReviewResult(BaseModel):
    summary: str = Field(..., description="Brief overall analysis")
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete edit suggestions")
    design_suggestions: list[DesignSuggestion] = Field(default_factory=list, description="Global design guidance only; no accept/revert in UI")


# New review flow: step1 = per-row analysis (+ rows_needing_input), step1b = optional refill with row_input, step2 = one shot suggestions from per_row
class ReviewStep1RowAnalysis(BaseModel):
    row_index: int = Field(..., description="0-based row index")
    reason: str = Field(..., description="Brief reason why this row failed")
    section_index_suggestions: list[int] = Field(default_factory=list, description="0-based section indices that might need change")
    need_input: bool = Field(default=False, description="True if analysis is unclear without seeing the row's input")


class ReviewStep1Result(BaseModel):
    summary: str = Field(..., description="Brief overall analysis of prompt vs comparison")
    per_row: list[ReviewStep1RowAnalysis] = Field(default_factory=list, description="Per failed-row analysis")
    rows_needing_input: list[int] = Field(default_factory=list, description="Row indices for which input is needed to analyze; subset of failed rows")


class ReviewStep1bRowUpdate(BaseModel):
    row_index: int = Field(..., description="0-based row index")
    reason: str = Field(..., description="Refined reason after seeing row input")
    section_index_suggestions: list[int] = Field(default_factory=list, description="0-based section indices to change")


class ReviewStep1bResult(BaseModel):
    updates: list[ReviewStep1bRowUpdate] = Field(default_factory=list, description="Refined analysis for rows that had row_input")


class FocusSuggestions(BaseModel):
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete suggestions (used for step2 single call)")


class DesignReviewResult(BaseModel):
    """Step 0: design check. Only suggest when user clearly has design issues (very loose)."""
    suggestions: list[DesignSuggestion] = Field(default_factory=list, description="0–3 design guidance items; empty if design is fine")


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
    """从存储项取 provider，缺省时根据 llm 推断（兼容旧数据）。"""
    return item.get("provider") or _infer_provider(item.get("llm", ""))


@app.get("/health")
def health():
    """健康检查；返回 models/providers 数量便于确认后端是否为新版本。"""
    return {"ok": True, "models": len(MODELS), "providers": len(PROVIDERS)}


@app.get("/api/debug/backend-info")
def debug_backend_info():
    """调试用：确认当前跑的是否为本仓库新版本。新版本应有 11 个 model_ids。"""
    return {
        "main_file": str(Path(__file__).resolve()),
        "models_count": len(MODELS),
        "model_ids": [m["id"] for m in MODELS],
        "providers_count": len(PROVIDERS),
    }


@app.get("/api/credentials/models")
def list_credential_models():
    """返回支持的 providers 与 models，供前端动态渲染下拉等。"""
    return {"providers": list(PROVIDERS), "models": list(MODELS)}


@app.get("/api/credentials", response_model=list[CredentialResponse])
def list_credentials():
    """列出所有凭证，API key 以脱敏形式返回。"""
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
    """添加一条凭证。使用原始 JSON 解析，避免 Pydantic 缓存导致只认 gpt-5 三模型。"""
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


@app.delete("/api/credentials/{credential_id}")
def delete_credential(credential_id: str):
    """根据 id 删除一条凭证。"""
    items = _load_credentials()
    new_items = [x for x in items if x.get("id") != credential_id]
    if len(new_items) == len(items):
        raise HTTPException(status_code=404, detail="Credential not found!")
    _save_credentials(new_items)
    return {"ok": True}


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
        with _run_jobs_lock:
            _run_jobs[run_id]["total"] = total
            _run_jobs[run_id]["completed"] = 0
            _run_jobs[run_id]["results"] = []
            _run_jobs[run_id]["output_fields"] = output_fields
        results: list[dict] = []
        for row_index, prompt in enumerate(prompts):
            with _run_jobs_lock:
                if run_id in _run_cancelled:
                    nid = _run_jobs.get(run_id, {}).get("run_node_id")
                    _run_jobs[run_id] = {
                        "status": "cancelled",
                        "results": list(results),
                        "output_fields": output_fields,
                        "run_node_id": nid,
                        "completed": row_index,
                        "total": total,
                    }
                    _run_cancelled.discard(run_id)
                    _persist_run_jobs()
                    return
                last = _run_last_activity.get(run_id, 0)
                if (time.time() - last) > RUN_ABANDON_TIMEOUT_SEC:
                    nid = _run_jobs.get(run_id, {}).get("run_node_id")
                    _run_jobs[run_id] = {
                        "status": "cancelled",
                        "results": list(results),
                        "output_fields": output_fields,
                        "run_node_id": nid,
                        "completed": row_index,
                        "total": total,
                    }
                    _persist_run_jobs()
                    _safe_print(_HL + "[Run] Client gone (no poll for {}s), run {} abandoned.\n".format(RUN_ABANDON_TIMEOUT_SEC, run_id) + _R)
                    return
            _safe_print("\n" + _HL + "=" * 60 + _R)
            _safe_print(_HL + "[Run] PROMPT SENT TO LLM:" + _R)
            _safe_print(_HL + "-" * 60 + _R)
            _safe_print(prompt)
            _safe_print(_HL + "-" * 60 + _R)
            try:
                out, used_fallback = llm_run_structured(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    prompt=prompt,
                    response_model=ResponseModel,
                    max_tokens=8192,
                    return_shape=return_shape,
                )
                if return_shape == "table" and isinstance(out, dict) and "rows" in out:
                    out = out["rows"]
                if not used_fallback:
                    _safe_print(_HL + "[Run] OUTPUT SCHEMA GIVEN TO LANGCHAIN:" + _R)
                    _safe_print(_HL + "-" * 60 + _R)
                    _safe_print(schema_repr)
                    _safe_print(_HL + "-" * 60 + _R)
                if return_shape == "table" and isinstance(out, list):
                    for row in out:
                        out_idx = len(results)
                        results.append({
                            "row_index": out_idx,
                            "input_row_index": row_index,
                            "output": row if isinstance(row, dict) else {},
                            "error": None,
                        })
                else:
                    out_idx = len(results)
                    results.append({
                        "row_index": out_idx,
                        "input_row_index": row_index,
                        "output": out,
                        "error": None,
                    })
                _safe_print(_HL + "[Run] LLM STRUCTURED OUTPUT:" + _R)
                _safe_print(_HL + "-" * 60 + _R)
                _safe_print(json.dumps(out, ensure_ascii=False, indent=2))
                _safe_print(_HL + "-" * 60 + _R)
            except Exception as e:
                out_idx = len(results)
                results.append({
                    "row_index": out_idx,
                    "input_row_index": row_index,
                    "output": None,
                    "error": str(e),
                })
                _safe_print(_HL + "[Run] LLM ERROR: " + _R + str(e))
            with _run_jobs_lock:
                _run_jobs[run_id]["completed"] = row_index + 1
                _run_jobs[run_id]["results"] = list(results)
            _persist_run_jobs()
            _safe_print(_HL + "=" * 60 + _R + "\n")
        with _run_jobs_lock:
            nid = _run_jobs.get(run_id, {}).get("run_node_id")
            _run_jobs[run_id] = {
                "status": "done",
                "results": results,
                "output_fields": output_fields,
                "run_node_id": nid,
                "completed": total,
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
    if job.get("status") == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "status": "running",
                "completed": job.get("completed", 0),
                "total": job.get("total", 0),
                "results": job.get("results") or [],
                "output_fields": job.get("output_fields") or [],
            },
        )
    if job.get("status") == "cancelled":
        return {
            "status": "cancelled",
            "results": job.get("results") or [],
            "output_fields": job.get("output_fields") or [],
            "completed": job.get("completed", 0),
            "total": job.get("total", 0),
        }
    if job.get("error"):
        return {"status": "done", "error": job["error"], "results": None, "output_fields": None}
    return {
        "status": "done",
        "results": job["results"],
        "output_fields": job["output_fields"],
        "completed": job.get("completed", 0),
        "total": job.get("total", 0),
    }


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
    if job.get("status") == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={
                "run_id": run_id,
                "status": "running",
                "completed": job.get("completed", 0),
                "total": job.get("total", 0),
                "results": job.get("results") or [],
                "output_fields": job.get("output_fields") or [],
            },
        )
    if job.get("status") == "cancelled":
        return {
            "run_id": run_id,
            "status": "cancelled",
            "results": job.get("results") or [],
            "output_fields": job.get("output_fields") or [],
            "completed": job.get("completed", 0),
            "total": job.get("total", 0),
        }
    if job.get("error"):
        return {"run_id": run_id, "status": "done", "error": job["error"], "results": None, "output_fields": None}
    return {"run_id": run_id, "status": "done", "results": job["results"], "output_fields": job["output_fields"]}


# ---------- Review: step0 design check (optional), then step1 plan + step2 per-focus suggestions ----------
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


def _build_review_design_prompt(body: ReviewRequest) -> str:
    """Step 0: Design suggestions only when prompt is seriously broken (user typically can't write)."""
    lines = [
        "You are reviewing how a user structured their prompt: sections (names + content) and output schema (field keys).",
        "",
        "## Task",
        "Output design suggestions ONLY when the prompt has serious structural/schema problems: e.g. no usable section structure, output schema clearly wrong or missing for the task, or the prompt would not work at all. This is for cases where the user typically does not know how to write a prompt.",
        "When the prompt is already reasonable, usable, or only has minor polish issues, you MUST output {\"suggestions\": []}. Do NOT suggest optional improvements, polish, or 'consider adding X'. Default to empty list.",
        "",
        "## Sections",
    ]
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- {i}: {name} ---")
        lines.append(content)
        lines.append("")
    schema_lines, _ = _review_output_schema_lines(body)
    if schema_lines:
        lines.append("## Output schema (same as used in run)")
        lines.extend(schema_lines)
        lines.append("(This schema is enforced by LangChain at run time; the user does NOT need to add the exact JSON format or output structure in the prompt text. Do not suggest adding JSON examples or output format to the prompt.)")
    else:
        keys = [(f.get("key") or "").strip() for f in (body.output_fields or []) if f and (f.get("key") or "").strip()]
        lines.append("## Output schema (field keys)")
        lines.append(", ".join(keys) if keys else "(none)")
        lines.append("(Output format is enforced by LangChain; do not suggest adding JSON/output format to the prompt.)")
    lines.append("")
    lines.append('Respond with JSON: {"suggestions": [{"name": "short title", "reason": "1-2 sentences"}, ...]}. Use {"suggestions": []} unless the prompt is seriously broken.')
    return "\n".join(lines)


def _build_review_step1_prompt(body: ReviewRequest) -> str:
    """Step1: Per-row analysis. For each failed row: reason, section_index_suggestions; if unclear, set need_input and add row_index to rows_needing_input."""
    all_matched = _review_all_matched(body)
    lines = [
        "You are helping improve a prompt used for structured LLM output. Below are the prompt sections and per-row comparison of model output vs ground truth.",
        "",
        "## Task (step 1): Analyze each failed row",
        "For each row that is NOT MATCHED: (1) Give a brief but complete reason why it failed — e.g. 'Row 1: phosphatase field was under-extracted' or 'Row 2: expected value appears to be a typo; consider checking ground truth.' The reason must explain what went wrong, not just state the row number. (2) List which section indices (0-based) might need a change to fix this. (3) If you cannot tell why it failed without seeing the input that was used to fill the prompt for this row, set need_input to true and add that row_index to rows_needing_input.",
        "(4) If the expected/ground-truth value clearly appears wrong (typo, wrong entity, contradicts the passage, or model output is more plausible), say so in the reason (e.g. 'Row 2: expected value appears incorrect; consider checking ground truth.'). This will be surfaced to the user so they can fix the dataset.",
        "You do NOT see the input (the data that filled the prompt) here; only model output vs expected. If the failure is unclear, request input for that row.",
        "**In your summary and reason text, write row numbers as Row 1, Row 2, Row 3, etc. (do not write '(1-based)' or '0-based' in the text; the row_index in JSON stays 0-based).**",
        "",
        "**Do NOT suggest putting the correct/expected answer or ground truth into the prompt.** Suggest real prompt improvements: clarify instructions, add criteria, improve wording.",
        "",
    ]
    if all_matched:
        lines.extend([
            "**All rows are matched (no failures).** Give a short positive summary. For per_row, output one synthetic entry (e.g. row_index 0, reason \"all matched\", section_index_suggestions [0] or [], need_input false) so we have at least one optional improvement. Keep rows_needing_input empty.",
            "",
        ])
    lines.append("## Sections (0-based index for reference)")
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- Section index {i}: {name} ---")
        lines.append(content)
        lines.append("")
    schema_lines, _ = _review_output_schema_lines(body)
    if schema_lines:
        lines.append("## Output schema (same as used in run)")
        lines.extend(schema_lines)
        lines.append("(Enforced by LangChain; do not suggest adding JSON/output format to the prompt.)")
        lines.append("")
    comparison_rows = body.comparison_rows or []
    compared_fields, rules_block = _review_compared_fields_and_rules(comparison_rows)
    if rules_block:
        lines.append(rules_block)
        lines.append("")
    unmatched = [r for r in comparison_rows if not r.matched]
    matched = [r for r in comparison_rows if r.matched]
    lines.append("## Rows that failed (NOT MATCHED) — analyze each; add to rows_needing_input if you need to see this row's input")
    if unmatched:
        for row in unmatched:
            lines.append(f"Row {row.row_index + 1} (row_index {row.row_index}) [NOT MATCHED]")
            if row.comparison_types:
                lines.append(f"  Comparison: {', '.join(row.comparison_types)}")
            lines.append(f"  Model output: {json.dumps(row.run_output, ensure_ascii=False)}")
            lines.append(f"  Expected: {row.expected}")
            if row.comment:
                lines.append(f"  User comment: {row.comment}")
            lines.append("")
    else:
        lines.append("(None — all rows matched.)")
        lines.append("")
    lines.append("## Rows that matched — context only; avoid suggesting changes that would break these")
    if matched:
        for row in matched[:20]:
            lines.append(f"Row {row.row_index + 1} (row_index {row.row_index}) [matched]")
            if row.comparison_types:
                lines.append(f"  Comparison: {', '.join(row.comparison_types)}")
            lines.append(f"  Model output: {json.dumps(row.run_output, ensure_ascii=False)}")
            lines.append(f"  Expected: {row.expected}")
            if row.comment:
                lines.append(f"  User comment: {row.comment}")
            lines.append("")
    else:
        lines.append("(None.)")
        lines.append("")
    _, schema_keys = _review_output_schema_lines(body)
    section_names = [(s.get("name") or "").strip() for s in (body.prompt_sections or []) if s and (s.get("name") or "").strip()]
    if schema_keys or section_names:
        lines.append("## Constraints")
        lines.append("Do NOT suggest changing output schema field keys or section names; they must stay as-is.")
        lines.append("")
    lines.append(
        "Respond with JSON: {\"summary\": \"...\", \"per_row\": [{\"row_index\": 0, \"reason\": \"...\", \"section_index_suggestions\": [0, 1], \"need_input\": false}, ...], \"rows_needing_input\": [0, 2]}."
    )
    return "\n".join(lines)


def _build_review_step1b_prompt(rows_with_input: list[ReviewComparisonRow]) -> str:
    """Step1b: Refine analysis for rows that need input; each row has row_input (key-values used to fill prompt)."""
    lines = [
        "You previously could not fully analyze these rows without seeing the input. Below each row now includes the input (key-value pairs that were used to fill the prompt for that row).",
        "",
        "## Task: Refine analysis for each row",
        "For each row below, output an update: row_index, reason (refined now that you see the input), and section_index_suggestions (0-based section indices to change).",
        "The reason must be a clear, short explanation for the user (e.g. 'Row 2: substrate in input is TRPV6 but expected has a typo; correct the ground truth.'), not just the row number. When giving reasons, only refer to the compared fields (see below); do not cite other keys in the model output.",
        "",
    ]
    _, rules_block = _review_compared_fields_and_rules(rows_with_input)
    if rules_block:
        lines.append(rules_block)
        lines.append("")
    lines.append("**In your reason text, write row numbers as Row 1, Row 2, etc.; do not write '(1-based)' or '0-based' in the text. The row_index in JSON stays 0-based.**")
    lines.append("")
    for row in rows_with_input:
        lines.append(f"Row {row.row_index + 1} (row_index {row.row_index})")
        lines.append(f"  Input (used to fill prompt): {json.dumps(row.row_input or {}, ensure_ascii=False)}")
        lines.append(f"  Model output: {json.dumps(row.run_output, ensure_ascii=False)}")
        lines.append(f"  Expected: {row.expected}")
        if row.comparison_types:
            lines.append(f"  Comparison: {', '.join(row.comparison_types)}")
        if row.comment:
            lines.append(f"  User comment: {row.comment}")
        lines.append("")
    lines.append(
        "Respond with JSON: {\"updates\": [{\"row_index\": 0, \"reason\": \"...\", \"section_index_suggestions\": [0, 1]}, ...]}."
    )
    return "\n".join(lines)


def _build_review_step2_prompt(body: ReviewRequest, per_row: list[ReviewStep1RowAnalysis]) -> str:
    """Step2: From merged per_row analysis, output concrete old_sentence/new_sentence suggestions (one call, all sections)."""
    all_matched = _review_all_matched(body)
    _, schema_keys = _review_output_schema_lines(body)
    section_names = [(s.get("name") or "").strip() for s in (body.prompt_sections or []) if s and (s.get("name") or "").strip()]
    lines = [
        "You are improving a prompt. You have per-row analysis (reason + which sections to change). Output concrete edit suggestions: for each change, exact old_sentence (verbatim from section) and new_sentence.",
        "",
        "**Do NOT put the correct/expected answer or ground truth into new_sentence.** Improve instructions, criteria, or wording so the model can generalize.",
        "",
        "## Critical: old_sentence",
        "Copy character-for-character from the section text. One sentence or one line per suggestion. The tool matches by string; one character wrong and the edit may fail.",
        "",
        "## Critical: new_sentence",
        "Must not contain expected/correct output. Change instructions or criteria only.",
        "",
    ]
    if all_matched:
        lines.append("**All rows matched.** Output 1–2 optional small improvements (e.g. clarity or wording).")
        lines.append("")
    comparison_rows = body.comparison_rows or []
    compared_fields, rules_block = _review_compared_fields_and_rules(comparison_rows)
    if rules_block:
        lines.append(rules_block)
        lines.append("")
    lines.append("## Sections (copy exact substring from here for old_sentence)")
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- Section index {i}: {name} ---")
        lines.append(content)
        lines.append("")
    lines.append("## Per-row analysis (why each failed and which sections to change)")
    for a in per_row:
        lines.append(f"Row {a.row_index + 1} (row_index {a.row_index}): {a.reason} -> section indices to consider: {a.section_index_suggestions}")
    lines.append("")
    if schema_keys or section_names:
        lines.append("## Constraints")
        lines.append("Do NOT rename or alter output schema field keys or section names.")
        lines.append("")
    schema_lines, _ = _review_output_schema_lines(body)
    if schema_lines:
        lines.append("Output schema (same as run):")
        lines.extend(schema_lines)
        lines.append("")
    comparison_rows = body.comparison_rows or []
    unmatched = [r for r in comparison_rows if not r.matched][:15]
    lines.append("## Reason field rules")
    lines.append(
        "If the suggestion is to fix an unmatched (failed) row: the reason MUST state which run result(s) caused it — e.g. 'Row 2 failed because phosphatase was under-extracted; this edit clarifies that the symbol must come from the list.' Always say which row(s) (Row 1, Row 2, etc.; do not write '1-based' or '0-based') and which error led to this change."
    )
    lines.append(
        "When several failed rows share the same root cause: output one suggestion that fixes it (do not duplicate the same edit for each row). In the reason, list all the rows affected — e.g. 'Rows 2, 3, and 5 all failed because phosphatase was under-extracted; this edit clarifies that the symbol must come from the list.'"
    )
    lines.append(
        "If the suggestion is a general improvement based on matched rows (e.g. all rows matched, or optional polish): no need to mention a row number; a short explanation of the improvement is enough."
    )
    for row in unmatched:
        comp = f" Comparison: {', '.join(row.comparison_types)}." if row.comparison_types else ""
        lines.append(f"  Row {row.row_index + 1} (row_index {row.row_index}){comp} Model: {json.dumps(row.run_output, ensure_ascii=False)[:200]}... Expected: {row.expected}")
    lines.append("")
    lines.append("## Ground truth issues (important)")
    lines.append(
        "When the failure is clearly due to incorrect or inconsistent ground truth (e.g. expected has a typo, wrong ID, contradicts the passage, or model output is more plausible than expected), you MUST include exactly one suggestion with ground_truth_issue: true so the user can fix the dataset. Use name e.g. \"Possible ground truth issue\"; in reason give a full explanation for the user (e.g. 'Row 3: the expected substrate value does not match the passage; please correct the ground truth.'), not just the row number. Write Row 1, Row 2, Row 3 in text; do not write '1-based' or '0-based'. Set old_sentence and new_sentence to \"(no edit)\", section_index 0. Do not be reluctant when the evidence is clear. When the failure is a prompt or extraction issue, do not use ground_truth_issue; output normal edit suggestions instead."
    )
    lines.append("")
    lines.append(
        "Respond with JSON: {\"suggestions\": [{\"name\": \"short title\", \"section_index\": 0, \"old_sentence\": \"exact copy from section\", \"new_sentence\": \"replacement\", \"reason\": \"...\", \"ground_truth_issue\": false}, ...]}. "
        "For suggestions that address an unmatched row: reason must say which row (Row 1, Row 2, etc.) and which error in that run result led to this edit. For suggestions based on matched rows only: no row number needed. For ground_truth_issue, give a full explanation including which row. Never write '(1-based)' or '0-based'. Refer only to the compared fields. Prefer 3–10 suggestions that cover the failures without duplicate edits."
    )
    return "\n".join(lines)


def _merge_step1b_into_per_row(
    per_row: list[ReviewStep1RowAnalysis],
    step1b_result: ReviewStep1bResult,
) -> list[ReviewStep1RowAnalysis]:
    """Merge Step1b updates into per_row by row_index (overwrite reason and section_index_suggestions)."""
    by_index = {a.row_index: a for a in per_row}
    for u in step1b_result.updates or []:
        if u.row_index in by_index:
            by_index[u.row_index] = ReviewStep1RowAnalysis(
                row_index=u.row_index,
                reason=u.reason,
                section_index_suggestions=list(u.section_index_suggestions or []),
                need_input=False,
            )
    return list(by_index.values())


@app.post("/api/review/analyze", response_model=ReviewResult)
def review_analyze(body: ReviewRequest):
    """Step 0: design check. Step 1: per-row analysis. Step 1b (optional): refine with row_input. Step 2: one-shot suggestions from per_row."""
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
    try:
        # Step 0: design check
        design_prompt = _build_review_design_prompt(body)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review] Step 0 (design) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(design_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        design_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=design_prompt,
            response_model=DesignReviewResult,
            max_tokens=8192,
        )
        _safe_print(_HL + "[Review] Step 0 (design) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(design_result if isinstance(design_result, dict) else design_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        design_review = DesignReviewResult(**(design_result if isinstance(design_result, dict) else design_result.model_dump()))
        all_matched = _review_all_matched(body)
        design_suggestions = list(design_review.suggestions or [])
        if all_matched and len(design_suggestions) > 1:
            design_suggestions = design_suggestions[:1]

        # Step 1: per-row analysis
        step1_prompt = _build_review_step1_prompt(body)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review] Step 1 (per-row analysis) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(step1_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        step1_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step1_prompt,
            response_model=ReviewStep1Result,
            max_tokens=32768,
        )
        _safe_print(_HL + "[Review] Step 1 (per-row analysis) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(step1_result if isinstance(step1_result, dict) else step1_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        step1 = ReviewStep1Result(**(step1_result if isinstance(step1_result, dict) else step1_result.model_dump()))
        per_row = list(step1.per_row or [])
        rows_needing_input = list(step1.rows_needing_input or [])

        # Step 1b: optional refill for rows that need input (one LLM call per row to avoid huge prompts when input is long)
        if rows_needing_input and body.comparison_rows:
            rows_with_input = [
                r for r in body.comparison_rows
                if r.row_index in rows_needing_input and (r.row_input is not None and len(r.row_input) > 0)
            ]
            for row in rows_with_input:
                step1b_prompt = _build_review_step1b_prompt([row])
                _safe_print("\n" + _HL + "=" * 60 + _R)
                _safe_print(_HL + f"[Review] Step 1b (refine row {row.row_index}) PROMPT SENT TO LLM:" + _R)
                _safe_print(_HL + "-" * 60 + _R)
                _safe_print(step1b_prompt)
                _safe_print(_HL + "-" * 60 + _R)
                step1b_result, _ = llm_run_structured(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    prompt=step1b_prompt,
                    response_model=ReviewStep1bResult,
                    max_tokens=8192,
                )
                _safe_print(_HL + f"[Review] Step 1b (refine row {row.row_index}) LLM STRUCTURED OUTPUT:" + _R)
                _safe_print(json.dumps(step1b_result if isinstance(step1b_result, dict) else step1b_result.model_dump(), ensure_ascii=False, indent=2))
                _safe_print(_HL + "=" * 60 + _R + "\n")
                step1b = ReviewStep1bResult(**(step1b_result if isinstance(step1b_result, dict) else step1b_result.model_dump()))
                per_row = _merge_step1b_into_per_row(per_row, step1b)

        if not per_row and not all_matched:
            return ReviewResult(summary=step1.summary, suggestions=[], design_suggestions=design_suggestions)
        if all_matched and per_row:
            per_row = per_row[:3]

        # Step 2: one call to get all suggestions from per_row
        step2_prompt = _build_review_step2_prompt(body, per_row)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review] Step 2 (suggestions) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(step2_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        step2_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step2_prompt,
            response_model=FocusSuggestions,
            max_tokens=32768,
        )
        _safe_print(_HL + "[Review] Step 2 (suggestions) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(step2_result if isinstance(step2_result, dict) else step2_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        fs = FocusSuggestions(**(step2_result if isinstance(step2_result, dict) else step2_result.model_dump()))
        raw_suggestions = list(fs.suggestions or [])
        if all_matched and len(raw_suggestions) > 2:
            raw_suggestions = raw_suggestions[:2]
        out_suggestions: list[ReviewSuggestion] = []
        for s in raw_suggestions:
            s_dict = s.model_dump() if hasattr(s, "model_dump") else s
            if not isinstance(s_dict, dict):
                continue
            if (s_dict.get("section_index") or 0) < 0 and body.prompt_sections:
                s_dict["section_index"] = 0
            out_suggestions.append(ReviewSuggestion(**s_dict))
        return ReviewResult(summary=step1.summary, suggestions=out_suggestions, design_suggestions=design_suggestions)
    except Exception as e:
        _safe_print(_HL + "[Review] Error: " + _R + str(e))
        raise HTTPException(status_code=400, detail=str(e))


def _review_analyze_stream_generator(body: ReviewRequest):
    """Yield NDJSON lines: design, step1 (summary), optional step1b, step2 (suggestions), done."""
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == body.credential_id:
            cred = item
            break
    if not cred:
        yield (json.dumps({"type": "error", "detail": "Credential not found"}) + "\n").encode("utf-8")
        return
    model = cred.get("llm", "")
    api_key = cred.get("api_key", "")
    if not api_key:
        yield (json.dumps({"type": "error", "detail": "Missing API key"}) + "\n").encode("utf-8")
        return
    provider = cred.get("provider", "openai")
    try:
        # Step 0: design check
        design_prompt = _build_review_design_prompt(body)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review stream] Step 0 (design) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(design_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        design_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=design_prompt,
            response_model=DesignReviewResult,
            max_tokens=8192,
        )
        _safe_print(_HL + "[Review stream] Step 0 (design) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(design_result if isinstance(design_result, dict) else design_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        design_review = DesignReviewResult(**(design_result if isinstance(design_result, dict) else design_result.model_dump()))
        all_matched = _review_all_matched(body)
        design_list = [s.model_dump() if hasattr(s, "model_dump") else s for s in (design_review.suggestions or [])]
        if all_matched and len(design_list) > 1:
            design_list = design_list[:1]
        yield (json.dumps({"type": "design", "design_suggestions": design_list}, ensure_ascii=False) + "\n").encode("utf-8")

        # Step 1: per-row analysis
        step1_prompt = _build_review_step1_prompt(body)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review stream] Step 1 (per-row analysis) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(step1_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        step1_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step1_prompt,
            response_model=ReviewStep1Result,
            max_tokens=32768,
        )
        _safe_print(_HL + "[Review stream] Step 1 (per-row analysis) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(step1_result if isinstance(step1_result, dict) else step1_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        step1 = ReviewStep1Result(**(step1_result if isinstance(step1_result, dict) else step1_result.model_dump()))
        per_row = list(step1.per_row or [])
        rows_needing_input = list(step1.rows_needing_input or [])
        yield (json.dumps({
            "type": "plan",
            "summary": step1.summary,
            "focus_count": 1,
            "per_row_count": len(per_row),
            "rows_needing_input": rows_needing_input,
        }, ensure_ascii=False) + "\n").encode("utf-8")

        # Step 1b: optional (one LLM call per row to avoid huge prompts when input is long)
        if rows_needing_input and body.comparison_rows:
            rows_with_input = [
                r for r in body.comparison_rows
                if r.row_index in rows_needing_input and (r.row_input is not None and len(r.row_input) > 0)
            ]
            for row in rows_with_input:
                yield (json.dumps({"type": "step1b", "row_count": 1, "row_index": row.row_index}, ensure_ascii=False) + "\n").encode("utf-8")
                step1b_prompt = _build_review_step1b_prompt([row])
                _safe_print("\n" + _HL + "=" * 60 + _R)
                _safe_print(_HL + f"[Review stream] Step 1b (refine row {row.row_index}) PROMPT SENT TO LLM:" + _R)
                _safe_print(_HL + "-" * 60 + _R)
                _safe_print(step1b_prompt)
                _safe_print(_HL + "-" * 60 + _R)
                step1b_result, _ = llm_run_structured(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    prompt=step1b_prompt,
                    response_model=ReviewStep1bResult,
                    max_tokens=8192,
                )
                _safe_print(_HL + f"[Review stream] Step 1b (refine row {row.row_index}) LLM STRUCTURED OUTPUT:" + _R)
                _safe_print(json.dumps(step1b_result if isinstance(step1b_result, dict) else step1b_result.model_dump(), ensure_ascii=False, indent=2))
                _safe_print(_HL + "=" * 60 + _R + "\n")
                step1b = ReviewStep1bResult(**(step1b_result if isinstance(step1b_result, dict) else step1b_result.model_dump()))
                per_row = _merge_step1b_into_per_row(per_row, step1b)

        if not per_row and not all_matched:
            yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")
            return
        if all_matched and per_row:
            per_row = per_row[:3]

        # Step 2: one-shot suggestions
        step2_prompt = _build_review_step2_prompt(body, per_row)
        _safe_print("\n" + _HL + "=" * 60 + _R)
        _safe_print(_HL + "[Review stream] Step 2 (suggestions) PROMPT SENT TO LLM:" + _R)
        _safe_print(_HL + "-" * 60 + _R)
        _safe_print(step2_prompt)
        _safe_print(_HL + "-" * 60 + _R)
        step2_result, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step2_prompt,
            response_model=FocusSuggestions,
            max_tokens=32768,
        )
        _safe_print(_HL + "[Review stream] Step 2 (suggestions) LLM STRUCTURED OUTPUT:" + _R)
        _safe_print(json.dumps(step2_result if isinstance(step2_result, dict) else step2_result.model_dump(), ensure_ascii=False, indent=2))
        _safe_print(_HL + "=" * 60 + _R + "\n")
        fs = FocusSuggestions(**(step2_result if isinstance(step2_result, dict) else step2_result.model_dump()))
        raw_suggestions = list(fs.suggestions or [])
        if all_matched and len(raw_suggestions) > 2:
            raw_suggestions = raw_suggestions[:2]
        batch = []
        for s in raw_suggestions:
            s_dict = s.model_dump() if hasattr(s, "model_dump") else s
            if isinstance(s_dict, dict):
                if (s_dict.get("section_index") or 0) < 0 and body.prompt_sections:
                    s_dict["section_index"] = 0
                batch.append(s_dict)
        if batch:
            yield (json.dumps({"type": "suggestions", "suggestions": batch}, ensure_ascii=False) + "\n").encode("utf-8")
        yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")
    except Exception as e:
        _safe_print(_HL + "[Review] Error: " + _R + str(e))
        yield (json.dumps({"type": "error", "detail": str(e)}, ensure_ascii=False) + "\n").encode("utf-8")


@app.post("/api/review/analyze/stream")
def review_analyze_stream(body: ReviewRequest):
    """Stream review: first line = plan (summary), then one NDJSON line per focus with suggestions, then done."""
    return StreamingResponse(
        _review_analyze_stream_generator(body),
        media_type="application/x-ndjson",
    )
