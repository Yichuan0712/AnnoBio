from pathlib import Path
import json
import re
import sys
import threading
import uuid
from typing import Any, Optional


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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
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


ALLOWED_MODELS = {"gpt-5", "gpt-5-mini", "gpt-5-nano"}
# Extend when adding new providers (anthropic, google, etc.)
ALLOWED_PROVIDERS = {"openai"}


class CredentialCreate(BaseModel):
    name: str | None = Field(default=None, description="Optional; if omitted, defaults to model name with number if duplicate")
    llm: str = Field(..., description="Model: gpt-5, gpt-5-mini, gpt-5-nano")
    api_key: str = Field(..., min_length=1, description="API key")
    provider: str = Field(default="openai", description="LLM provider; extend ALLOWED_PROVIDERS when adding more")


class CredentialRenameBody(BaseModel):
    name: str = Field(..., min_length=1, description="New name")


class CredentialResponse(BaseModel):
    id: str
    name: str
    llm: str
    api_key_masked: str


class CredentialDetailResponse(BaseModel):
    """Single credential with full api_key for in-app display only."""

    id: str
    name: str
    llm: str
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
    comment: str | None = Field(default=None, description="User comment if any")


class ReviewRequest(BaseModel):
    credential_id: str
    prompt_sections: list[dict] = Field(..., description="List of {name, content} for each section")
    prompt_full_text: str = Field(default="", description="Full prompt as single string")
    run_results: list[dict] = Field(default_factory=list, description="List of {row_index, output}")
    output_fields: list[dict] = Field(default_factory=list, description="List of {key, display}")
    comparison_rows: list[ReviewComparisonRow] = Field(default_factory=list, description="Per-row match result and context")


class ReviewSuggestion(BaseModel):
    section_index: int = Field(..., ge=0, description="0-based index of the section to change")
    new_content: str = Field(..., description="Replacement content for that section")
    reason: str = Field(..., description="Why this change is suggested")


class ReviewResult(BaseModel):
    summary: str = Field(..., description="Brief overall analysis")
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete edit suggestions")


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


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/credentials", response_model=list[CredentialResponse])
def list_credentials():
    """列出所有凭证，API key 以脱敏形式返回。"""
    items = _load_credentials()
    return [
        CredentialResponse(
            id=item["id"],
            name=item.get("name", "Unnamed"),
            llm=item["llm"],
            api_key_masked=_mask_key(item["api_key"]),
        )
        for item in items
    ]


@app.post("/api/credentials", response_model=CredentialResponse)
def add_credential(body: CredentialCreate):
    """添加一条凭证。"""
    if body.llm not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"model must be one of {sorted(ALLOWED_MODELS)}")
    if body.provider not in ALLOWED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"provider must be one of {sorted(ALLOWED_PROVIDERS)}")
    items = _load_credentials()
    new_id = str(uuid.uuid4())
    name = (body.name or "").strip() if body.name else ""
    if not name:
        name = _unique_name_for_model(items, body.llm)
    new_item = {
        "id": new_id,
        "name": name,
        "llm": body.llm,
        "api_key": body.api_key,
        "provider": body.provider,
    }
    items.append(new_item)
    _save_credentials(items)
    return CredentialResponse(
        id=new_id,
        name=new_item["name"],
        llm=new_item["llm"],
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
                api_key_masked=_mask_key(item["api_key"]),
            )
    raise HTTPException(status_code=404, detail="Credential not found")


@app.post("/api/credentials/{credential_id}/test")
def test_credential(credential_id: str):
    """Verify API key by sending a minimal prompt to OpenAI."""
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unsupported model: {model}")
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
# Background runs: run_id -> { status: "running" | "done", results?, output_fields? }
_run_jobs: dict[str, dict] = {}
_run_jobs_lock = threading.Lock()


def _do_run_work(
    run_id: str,
    credential_id: str,
    prompts: list[str],
    output_schema: dict,
) -> None:
    """Run in background thread; store result in _run_jobs[run_id]."""
    try:
        items = _load_credentials()
        cred = None
        for item in items:
            if item.get("id") == credential_id:
                cred = item
                break
        if not cred:
            with _run_jobs_lock:
                _run_jobs[run_id] = {"status": "done", "error": "Credential not found"}
            return
        provider = cred.get("provider", "openai")
        model = cred.get("llm", "")
        api_key = cred.get("api_key", "")
        if model not in ALLOWED_MODELS or provider not in ALLOWED_PROVIDERS:
            with _run_jobs_lock:
                _run_jobs[run_id] = {"status": "done", "error": "Unsupported model or provider"}
            return
        if not api_key:
            with _run_jobs_lock:
                _run_jobs[run_id] = {"status": "done", "error": "Missing API key"}
            return

        fields = output_schema.get("fields") or []
        if not fields:
            with _run_jobs_lock:
                _run_jobs[run_id] = {"status": "done", "error": "output_schema.fields is required"}
            return
        ResponseModel = _build_output_model(fields)
        schema_repr = json.dumps(output_schema, ensure_ascii=False, indent=2)

        output_fields = []
        _seen = set()
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
        results = []
        for row_index, prompt in enumerate(prompts):
            _safe_print("\n" + _HL + "=" * 60 + _R)
            _safe_print(_HL + "[Run] PROMPT SENT TO LLM:" + _R)
            _safe_print(_HL + "-" * 60 + _R)
            _safe_print(prompt)
            _safe_print(_HL + "-" * 60 + _R)
            _safe_print(_HL + "[Run] OUTPUT SCHEMA GIVEN TO LANGCHAIN:" + _R)
            _safe_print(schema_repr)
            _safe_print(_HL + "-" * 60 + _R)
            try:
                out = llm_run_structured(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    prompt=prompt,
                    response_model=ResponseModel,
                    max_tokens=8192,
                )
                results.append({"row_index": row_index, "output": out, "error": None})
                _safe_print(_HL + "[Run] LLM STRUCTURED OUTPUT:" + _R)
                _safe_print(json.dumps(out, ensure_ascii=False, indent=2))
            except Exception as e:
                results.append({"row_index": row_index, "output": None, "error": str(e)})
                _safe_print(_HL + "[Run] LLM ERROR: " + _R + str(e))
            with _run_jobs_lock:
                _run_jobs[run_id]["completed"] = len(results)
                _run_jobs[run_id]["results"] = list(results)
            _safe_print(_HL + "=" * 60 + _R + "\n")
        with _run_jobs_lock:
            _run_jobs[run_id] = {"status": "done", "results": results, "output_fields": output_fields}
    except Exception as e:
        with _run_jobs_lock:
            _run_jobs[run_id] = {"status": "done", "error": str(e)}


@app.post("/api/run")
def run_prompts(body: RunRequest):
    """
    Start run in background; returns 202 with run_id. Poll GET /api/run/result/{run_id} for results.
    Run continues even if the client closes the connection.
    """
    run_id = str(uuid.uuid4())
    with _run_jobs_lock:
        _run_jobs[run_id] = {"status": "running"}
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
    """Return 202 while running, 200 with results (or error) when done, 404 if unknown run_id."""
    with _run_jobs_lock:
        job = _run_jobs.get(run_id)
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
    if job.get("error"):
        return {"status": "done", "error": job["error"], "results": None, "output_fields": None}
    return {"status": "done", "results": job["results"], "output_fields": job["output_fields"]}


# ---------- Review: single-round prompt analysis from score comparison ----------
def _build_review_analysis_prompt(body: ReviewRequest) -> str:
    """Build the user message for the review LLM."""
    lines = [
        "You are helping improve a prompt used for structured LLM output. Below are the current prompt, the output schema, and per-row comparison of model output vs ground truth (matched or not, and any user comment).",
        "",
        "## Current prompt (full text)",
        body.prompt_full_text or "(empty)",
        "",
        "## Sections (0-based index for reference)",
    ]
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- Section index {i}: {name} ---")
        lines.append(content)
        lines.append("")
    lines.append("## Comparison (rows that failed or have comments are most important)")
    for row in body.comparison_rows or []:
        status = "matched" if row.matched else "NOT MATCHED"
        lines.append(f"Row {row.row_index} [{status}]")
        lines.append(f"  Model output: {json.dumps(row.run_output, ensure_ascii=False)}")
        lines.append(f"  Expected: {row.expected}")
        if row.comment:
            lines.append(f"  User comment: {row.comment}")
        lines.append("")
    lines.append(
        "Respond with a JSON object: {\"summary\": \"...\", \"suggestions\": [{\"section_index\": 0, \"new_content\": \"...\", \"reason\": \"...\"}, ...]}. "
        "Section names above are only for you to identify which section to edit — do NOT include any section name or title in new_content. "
        "new_content must be only the section body text (the content part). Use the exact 0-based section_index. "
        "Make minimal changes so a diff is clear. reason explains why."
    )
    return "\n".join(lines)


@app.post("/api/review/analyze", response_model=ReviewResult)
def review_analyze(body: ReviewRequest):
    """Single-round analysis: suggest prompt section edits from score comparison. Uses credential for LLM."""
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == body.credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = cred.get("llm", "")
    if model not in ALLOWED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unsupported model: {model}")
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = cred.get("provider", "openai")
    prompt_text = _build_review_analysis_prompt(body)
    try:
        result = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=prompt_text,
            response_model=ReviewResult,
            max_tokens=8192,
        )
        return ReviewResult(**result) if isinstance(result, dict) else result
    except Exception as e:
        _safe_print(_HL + "[Review] Error: " + _R + str(e))
        raise HTTPException(status_code=400, detail=str(e))
