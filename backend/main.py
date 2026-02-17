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
    run_results: list[dict] = Field(default_factory=list, description="List of {row_index, output}")
    output_fields: list[dict] = Field(default_factory=list, description="List of {key, display}")
    comparison_rows: list[ReviewComparisonRow] = Field(default_factory=list, description="Per-row match result and context")


class ReviewSuggestion(BaseModel):
    name: str = Field(..., description="Short name summarizing this change (e.g. 'Clarify output format')")
    section_index: int = Field(..., ge=0, description="0-based index of the section to change")
    old_sentence: str = Field(..., description="Exact sentence in the section to replace (one sentence only)")
    new_sentence: str = Field(..., description="Replacement for that one sentence")
    reason: str = Field(..., description="Why this change is suggested")


class DesignSuggestion(BaseModel):
    """Global design guidance only; not sentence-level edits. Shown without accept/revert."""
    name: str = Field(..., description="Short title (e.g. 'Consider splitting sections')")
    reason: str = Field(..., description="One or two sentences of design guidance")


class ReviewResult(BaseModel):
    summary: str = Field(..., description="Brief overall analysis")
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete edit suggestions")
    design_suggestions: list[DesignSuggestion] = Field(default_factory=list, description="Global design guidance only; no accept/revert in UI")


# Two-step review: step1 = plan (summary + change focuses), step2 = concrete suggestions per focus
class ReviewChangeFocus(BaseModel):
    section_index: int = Field(..., ge=0, description="0-based section index")
    focus_description: str = Field(..., description="One-sentence description of what to change in this section")
    name: str = Field(default="", description="Short title for this change (e.g. 'Clarify output format')")


class ReviewPlan(BaseModel):
    summary: str = Field(..., description="Brief overall analysis of prompt vs comparison")
    focuses: list[ReviewChangeFocus] = Field(default_factory=list, description="List of change focuses to expand into concrete edits")


class FocusSuggestions(BaseModel):
    suggestions: list[ReviewSuggestion] = Field(default_factory=list, description="Concrete suggestions for this focus only")


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


# ---------- Review: step0 design check (optional), then step1 plan + step2 per-focus suggestions ----------
def _build_review_design_prompt(body: ReviewRequest) -> str:
    """Step 0: Check section layout and output schema. Only suggest when design is clearly poor (very loose)."""
    lines = [
        "You are reviewing how a user structured their prompt: sections (names + content) and output schema (field keys).",
        "",
        "## Task",
        "Only if the user clearly has design problems (e.g. no clear section structure, output schema obviously mismatched to the task, missing obvious inputs or outputs), output 0–3 short design suggestions. Each: name (short title) and reason (1–2 sentences of guidance). If the design is reasonable or only has minor issues, output an empty suggestions list.",
        "Be very conservative: only suggest when the user would clearly benefit from design guidance.",
        "",
        "## Sections",
    ]
    for i, sec in enumerate(body.prompt_sections or []):
        name = (sec.get("name") or "").strip() or "(unnamed)"
        content = (sec.get("content") or "").strip() or "(empty)"
        lines.append(f"--- {i}: {name} ---")
        lines.append(content[:800] + ("..." if len(content) > 800 else ""))
        lines.append("")
    lines.append("## Output schema (field keys)")
    keys = [(f.get("key") or "").strip() for f in (body.output_fields or []) if f and (f.get("key") or "").strip()]
    lines.append(", ".join(keys) if keys else "(none)")
    lines.append("")
    lines.append('Respond with JSON: {"suggestions": [{"name": "short title", "reason": "1-2 sentences"}, ...]} or {"suggestions": []}.')
    return "\n".join(lines)


def _build_review_step1_prompt(body: ReviewRequest) -> str:
    """Step1: Ask for summary + list of change focuses (no exact sentences yet)."""
    lines = [
        "You are helping improve a prompt used for structured LLM output. Below are the current prompt sections and per-row comparison of model output vs ground truth (matched or not, and any user comment).",
        "",
        "## Task (step 1 of 2): Analyze and plan",
        "Output: (1) A brief overall summary. (2) A list of concrete change focuses. Each focus: section_index (0-based), a short name (e.g. \"Clarify output format\"), and focus_description = one sentence describing exactly what to change in that section (e.g. \"Add an example of valid JSON output\").",
        "Do NOT output exact old_sentence/new_sentence yet. Only list what should be changed and where. Prefer 3–10 focuses; merge tiny edits into one focus per idea.",
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
    # Constraint: do not suggest changing user-defined output field keys or section names (from existing payload)
    schema_keys = [(f.get("key") or "").strip() for f in (body.output_fields or []) if f and (f.get("key") or "").strip()]
    section_names = [(s.get("name") or "").strip() for s in (body.prompt_sections or []) if s and (s.get("name") or "").strip()]
    if schema_keys or section_names:
        lines.append("## Constraints (mandatory)")
        lines.append("Do NOT suggest any change that would rename, remove, or alter the following. They are user-defined and must stay exactly as-is:")
        if schema_keys:
            lines.append("- Output schema field keys (keep these exact strings in the prompt): " + ", ".join(repr(k) for k in schema_keys))
        if section_names:
            lines.append("- Input/section names (do not suggest renaming sections or changing these names in the text): " + ", ".join(repr(n) for n in section_names))
        lines.append("Do not add focuses that would modify output field keys or input/section names. You may still suggest clarifications or examples that keep these names unchanged.")
        lines.append("")
    lines.append(
        "Respond with JSON: {\"summary\": \"...\", \"focuses\": [{\"section_index\": 0, \"name\": \"short title\", \"focus_description\": \"one sentence what to change\"}, ...]}."
    )
    return "\n".join(lines)


def _build_review_step2_prompt(
    body: ReviewRequest,
    focus: ReviewChangeFocus,
) -> str:
    """Step2: Given one focus, output exact old_sentence/new_sentence for that section."""
    secs = body.prompt_sections or []
    idx = focus.section_index
    if idx < 0 or idx >= len(secs):
        return ""
    sec = secs[idx]
    name = (sec.get("name") or "").strip() or "(unnamed)"
    content = (sec.get("content") or "").strip() or "(empty)"
    schema_keys = [(f.get("key") or "").strip() for f in (body.output_fields or []) if f and (f.get("key") or "").strip()]
    section_names = [(s.get("name") or "").strip() for s in (body.prompt_sections or []) if s and (s.get("name") or "").strip()]
    lines = [
        "You are improving a prompt section. Output concrete edit suggestions: exact sentence to replace (old_sentence) and replacement (new_sentence).",
        "",
        "## Critical: how to set old_sentence",
        "Copy old_sentence character-for-character from the section text below. Do not paraphrase or add/remove spaces or newlines. "
        "The tool locates the change by matching this string in the section; if it differs by even one character, the edit may fail. "
        "Best practice: copy the exact substring from the section (one sentence or one line) into old_sentence.",
        "",
        "## Focus for this section",
        f"Section index: {idx} ({name})",
        f"What to do: {focus.focus_description}",
        f"Short name for suggestions: {focus.name or 'Edit'}",
        "",
        "## Section full text (copy exact substring from here for old_sentence)",
        content,
        "",
        "## Comparison context (why this change helps)",
    ]
    if schema_keys or section_names:
        lines.append("")
        lines.append("## Constraints (mandatory)")
        lines.append("Do NOT suggest any edit that would rename, remove, or alter these user-defined names (they must stay exactly as-is in new_sentence):")
        if schema_keys:
            lines.append("- Output schema field keys: " + ", ".join(repr(k) for k in schema_keys))
        if section_names:
            lines.append("- Input/section names: " + ", ".join(repr(n) for n in section_names))
        lines.append("")
    for row in (body.comparison_rows or [])[:15]:
        status = "matched" if row.matched else "NOT MATCHED"
        lines.append(f"Row {row.row_index} [{status}] Model: {json.dumps(row.run_output, ensure_ascii=False)[:200]}... Expected: {row.expected}")
    lines.append("")
    lines.append(
        "Respond with JSON: {\"suggestions\": [{\"name\": \"...\", \"section_index\": " + str(idx) + ", \"old_sentence\": \"exact one sentence copied from the section above\", \"new_sentence\": \"replacement\", \"reason\": \"...\"}, ...]}. "
        "Each suggestion must change exactly ONE sentence. old_sentence must be a verbatim copy from the section. You may output 1–3 suggestions for this focus."
    )
    return "\n".join(lines)


@app.post("/api/review/analyze", response_model=ReviewResult)
def review_analyze(body: ReviewRequest):
    """Step 0: design check (optional). Step 1: plan. Step 2: per-focus concrete suggestions."""
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
    try:
        # Step 0: design check (loose; only when clearly needed)
        design_prompt = _build_review_design_prompt(body)
        design_result = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=design_prompt,
            response_model=DesignReviewResult,
            max_tokens=2048,
        )
        design_review = DesignReviewResult(**(design_result if isinstance(design_result, dict) else design_result.model_dump()))
        design_suggestions = list(design_review.suggestions or [])

        # Step 1: get summary + list of change focuses
        step1_prompt = _build_review_step1_prompt(body)
        plan_result = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step1_prompt,
            response_model=ReviewPlan,
            max_tokens=32768,
        )
        plan = ReviewPlan(**(plan_result if isinstance(plan_result, dict) else plan_result.model_dump()))
        if not plan.focuses:
            return ReviewResult(summary=plan.summary, suggestions=[], design_suggestions=design_suggestions)

        # Step 2: for each focus, get exact suggestions (old_sentence / new_sentence)
        all_suggestions: list[ReviewSuggestion] = []
        for focus in plan.focuses:
            step2_prompt = _build_review_step2_prompt(body, focus)
            if not step2_prompt:
                continue
            step2_result = llm_run_structured(
                provider=provider,
                model=model,
                api_key=api_key,
                prompt=step2_prompt,
                response_model=FocusSuggestions,
                max_tokens=32768,
            )
            fs = FocusSuggestions(**(step2_result if isinstance(step2_result, dict) else step2_result.model_dump()))
            for s in fs.suggestions:
                s_dict = s.model_dump() if hasattr(s, "model_dump") else s
                s_dict["section_index"] = focus.section_index
                if not (s_dict.get("name") or "").strip():
                    s_dict["name"] = focus.name or focus.focus_description[:50]
                all_suggestions.append(ReviewSuggestion(**s_dict))

        return ReviewResult(summary=plan.summary, suggestions=all_suggestions, design_suggestions=design_suggestions)
    except Exception as e:
        _safe_print(_HL + "[Review] Error: " + _R + str(e))
        raise HTTPException(status_code=400, detail=str(e))


def _review_analyze_stream_generator(body: ReviewRequest):
    """Yield NDJSON lines: plan, then one line per focus with suggestions, then done."""
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
    if model not in ALLOWED_MODELS:
        yield (json.dumps({"type": "error", "detail": f"Unsupported model: {model}"}) + "\n").encode("utf-8")
        return
    api_key = cred.get("api_key", "")
    if not api_key:
        yield (json.dumps({"type": "error", "detail": "Missing API key"}) + "\n").encode("utf-8")
        return
    provider = cred.get("provider", "openai")
    try:
        # Step 0: design check
        design_prompt = _build_review_design_prompt(body)
        design_result = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=design_prompt,
            response_model=DesignReviewResult,
            max_tokens=2048,
        )
        design_review = DesignReviewResult(**(design_result if isinstance(design_result, dict) else design_result.model_dump()))
        design_list = [s.model_dump() if hasattr(s, "model_dump") else s for s in (design_review.suggestions or [])]
        yield (json.dumps({"type": "design", "design_suggestions": design_list}, ensure_ascii=False) + "\n").encode("utf-8")

        step1_prompt = _build_review_step1_prompt(body)
        plan_result = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=step1_prompt,
            response_model=ReviewPlan,
            max_tokens=32768,
        )
        plan = ReviewPlan(**(plan_result if isinstance(plan_result, dict) else plan_result.model_dump()))
        yield (json.dumps({"type": "plan", "summary": plan.summary, "focus_count": len(plan.focuses or [])}, ensure_ascii=False) + "\n").encode("utf-8")
        if not plan.focuses:
            yield (json.dumps({"type": "done"}, ensure_ascii=False) + "\n").encode("utf-8")
            return
        for focus in plan.focuses:
            step2_prompt = _build_review_step2_prompt(body, focus)
            if not step2_prompt:
                continue
            step2_result = llm_run_structured(
                provider=provider,
                model=model,
                api_key=api_key,
                prompt=step2_prompt,
                response_model=FocusSuggestions,
                max_tokens=32768,
            )
            fs = FocusSuggestions(**(step2_result if isinstance(step2_result, dict) else step2_result.model_dump()))
            batch = []
            for s in fs.suggestions:
                s_dict = s.model_dump() if hasattr(s, "model_dump") else s
                s_dict["section_index"] = focus.section_index
                if not (s_dict.get("name") or "").strip():
                    s_dict["name"] = focus.name or (focus.focus_description[:50] if focus.focus_description else "Edit")
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
