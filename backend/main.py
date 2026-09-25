from pathlib import Path
import base64
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, List, Optional
from urllib.parse import unquote

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

from fastapi import Body, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator
from run_output_schema import (
    sanitize_field_name as _sanitize_field_name,
    build_output_model as _build_output_model,
    build_table_output_model as _build_table_output_model,
    run_field_value_non_empty as _run_field_value_non_empty,
    run_structured_output_is_empty as _run_structured_output_is_empty,
)

from agent.chat.agent_chat import build_agent_messages, format_agent_messages_for_log
from agent.prompt.agent_plan_prompt import build_agent_plan_instruction_prefix
from llm import chat as llm_chat, run_structured as llm_run_structured
from pipeline_export import PipelineExportError, build_pipeline_archive
from provider_detect import detect_provider, verify_credential

from asset_store import router as asset_router, resolve_content
from project_store import router as project_router

app = FastAPI()
app.include_router(asset_router)
app.include_router(project_router)

BACKEND_HOST = os.environ.get("PROMPT_STUDIO_BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("PROMPT_STUDIO_BACKEND_PORT", "8000"))
VITE_DEV_SERVER_PORT = int(os.environ.get("PROMPT_STUDIO_VITE_DEV_SERVER_PORT", "5173"))
VITE_DEV_SERVER_ORIGINS = [
    f"http://localhost:{VITE_DEV_SERVER_PORT}",
    f"http://127.0.0.1:{VITE_DEV_SERVER_PORT}",
]

# Allow CORS for the Electron renderer in dev mode. Vite moves to the next free port (5174, ...) when
# 5173 is taken, so any local dev-server port is accepted, not just the configured one; without this
# every renderer request is blocked and the app shows "Unable to load" with a healthy backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=VITE_DEV_SERVER_ORIGINS,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
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
PUBMED_JOBS_FILE = DATA_DIR / "pubmed_jobs.json"
CLINICALTRIALS_JOBS_FILE = DATA_DIR / "clinicaltrials_jobs.json"
PREPRINT_JOBS_FILE = DATA_DIR / "preprint_jobs.json"
CHEMBL_JOBS_FILE = DATA_DIR / "chembl_jobs.json"
PROCESS_JOBS_FILE = DATA_DIR / "process_jobs.json"
MATCH_JOBS_FILE = DATA_DIR / "match_jobs.json"
PROCESS_DF_JOBS_FILE = DATA_DIR / "process_df_jobs.json"

DEFAULT_SETTINGS = {
    "default_run_credential_id": "",
    "default_review_credential_id": "",
    # Used by the Agent window's chat. Blank = fall back to default_review_credential_id (see
    # agentChatSession.js's loadAgentCredential) so upgrading doesn't silently break existing chats.
    "default_agent_credential_id": "",
    # Registered review method id (backend/review_methods.py); blank = registry default. Per-node choice on a
    # Review-capable Score node (dataset.reviewMethod) overrides this.
    "default_review_method": "",
    "run_max_tokens": 8192,
    "review_max_tokens": 32768,
    "run_max_retries": 2,
    # Rows within a single Run job processed concurrently (1-10).
    "run_concurrency": 4,
    # Cap: distinct worksheet inputs that have at least one unmatched Score comparison row (not raw row count).
    "review_max_failed_rows": 30,
    # Thompson-sampling trials per optimization run (4–200).
    "optimization_max_trials": 40,
    # GEPA reflective-evolution max iterations (4-200); kept separate from optimization_max_trials because
    # each GEPA iteration runs the task model against every targeted input, not just a suggestion's rows.
    "gepa_max_iterations": 15,
    # MIPROv2 trials (4-200); its own setting for the same reason gepa_max_iterations is separate from
    # optimization_max_trials — a different method, a different per-trial cost.
    "miprov2_num_trials": 10,
    # BootstrapFewShotWithRandomSearch candidate demo sets (2-100); own setting for the same reason.
    "bootstrap_fewshot_num_candidates": 10,
    # TextGrad textual-gradient-descent steps (2-50); own setting for the same reason.
    "textgrad_num_steps": 6,
    # COPRO breadth (instruction variants proposed per round, 2-30) and depth (rounds, 1-10); own
    # settings for the same reason gepa_max_iterations is separate from optimization_max_trials.
    "copro_breadth": 6,
    "copro_depth": 3,
    # SIMBA mini-batch introspection steps (2-40); own setting for the same reason.
    "simba_max_steps": 8,
    # Show Reset & Debug buttons on suggestion cards.
    "debug_mode": False,
    # Optional: raises PubMed E-utilities rate limit from 3/sec to 10/sec when set.
    "ncbi_api_key": "",
    # Optional: NCBI asks every E-utilities caller to identify a contact; falls back to a generic address when blank.
    "ncbi_email": "",
    # Python interpreter (system install or a venv) used by Process nodes to run user code.
    "python_path": "",
}


LEGACY_MODEL_PROVIDER_HINTS = {
    "gpt-5": "openai",
    "gpt-5-mini": "openai",
    "gpt-5-nano": "openai",
    "claude-opus-4-6": "anthropic",
    "claude-sonnet-4-6": "anthropic",
    "gemini-2.5-pro": "google",
    "gemini-2.5-flash": "google",
    "gemini-2.5-flash-lite": "google",
    "openai.gpt-oss-20b-1:0": "bedrock",
    "openai.gpt-oss-120b-1:0": "bedrock",
    "deepseek-chat": "deepseek",
    "deepseek-reasoner": "deepseek",
}

DEFAULT_BASE_URLS_BY_PROVIDER = {
    "deepseek": "https://api.deepseek.com",
}


def _log_backend_version():
    """Print on startup to confirm this file is loaded."""
    _safe_print(f"[backend] main.py loaded from: {Path(__file__).resolve()}")


_log_backend_version()


class CredentialCreate(BaseModel):
    """Not used for POST /api/credentials (we parse Request body by hand). Kept for OpenAPI docs only."""
    model: str = Field(..., description="LiteLLM model string, e.g. gpt-5 or anthropic/claude-sonnet-4-6")
    api_key: str = Field(..., min_length=1, description="API key")
    base_url: str | None = Field(default=None, description="Optional custom OpenAI-compatible base URL")

class SettingsPatch(BaseModel):
    """Partial settings update; only provided fields are updated."""
    default_run_credential_id: str | None = None
    default_review_credential_id: str | None = None
    default_agent_credential_id: str | None = None
    default_review_method: str | None = None
    run_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    review_max_tokens: int | None = Field(default=None, ge=256, le=131072)
    run_max_retries: int | None = Field(default=None, ge=0, le=5)
    run_concurrency: int | None = Field(default=None, ge=1, le=10)
    review_max_failed_rows: int | None = Field(
        default=None,
        ge=1,
        le=200,
        description="Cap Phase-1 review to this many distinct inputs that have at least one unmatched comparison row (not a raw comparison-row count).",
    )
    optimization_max_trials: int | None = Field(
        default=None,
        ge=4,
        le=200,
        description="Maximum Thompson-sampling trials per compositional optimization run (4–200).",
    )
    gepa_max_iterations: int | None = Field(
        default=None,
        ge=4,
        le=200,
        description="Maximum reflective-evolution iterations for the GEPA review method (4–200).",
    )
    miprov2_num_trials: int | None = Field(
        default=None,
        ge=4,
        le=200,
        description="Maximum trials for the MIPROv2 review method (4–200).",
    )
    bootstrap_fewshot_num_candidates: int | None = Field(
        default=None,
        ge=2,
        le=100,
        description="Candidate demo sets for the BootstrapFewShotWithRandomSearch review method (2–100).",
    )
    textgrad_num_steps: int | None = Field(
        default=None,
        ge=2,
        le=50,
        description="Textual-gradient-descent steps for the TextGrad review method (2–50).",
    )
    copro_breadth: int | None = Field(
        default=None,
        ge=2,
        le=30,
        description="Instruction variants proposed per round for the COPRO review method (2–30).",
    )
    copro_depth: int | None = Field(
        default=None,
        ge=1,
        le=10,
        description="Coordinate-ascent rounds for the COPRO review method (1–10).",
    )
    simba_max_steps: int | None = Field(
        default=None,
        ge=2,
        le=40,
        description="Mini-batch introspection steps for the SIMBA review method (2–40).",
    )
    debug_mode: bool | None = None
    ncbi_api_key: str | None = None
    ncbi_email: str | None = None
    python_path: str | None = None


class CredentialResponse(BaseModel):
    id: str
    model: str
    llm: str
    base_url: str = ""
    provider: str = ""
    last_check_ok: bool | None = None
    last_check_error: str | None = None
    api_key_masked: str


class CredentialDetailResponse(BaseModel):
    """Single credential with full api_key for in-app display only."""

    id: str
    model: str
    llm: str
    base_url: str = ""
    provider: str = ""
    last_check_ok: bool | None = None
    last_check_error: str | None = None
    api_key: str


class RunRequest(BaseModel):
    credential_id: str
    prompts: list[str] | None = Field(default=None, min_length=1)
    samples: list[dict] | None = Field(default=None, min_length=1)
    project_session_id: str | None = None

    @model_validator(mode="after")
    def one_input_format(self):
        if (self.prompts is None) == (self.samples is None):
            raise ValueError("Provide exactly one of prompts or samples.")
        if self.samples is not None:
            for sample in self.samples:
                if not isinstance(sample.get("content"), list):
                    raise ValueError("Each sample requires a content array.")
                for block in sample["content"]:
                    if not isinstance(block, dict) or block.get("type") not in ("text", "image_ref", "pdf_ref"):
                        raise ValueError("Unsupported sample content block.")
                    if block["type"] in ("image_ref", "pdf_ref") and (not self.project_session_id or not isinstance(block.get("asset_id"), str)):
                        raise ValueError("Image/PDF blocks require an asset ID and a project session.")
        return self
    output_schema: dict = Field(..., description="return_shape + fields: [{ key, type, description?, allow_none? }]")
    run_node_id: str | None = Field(default=None, description="Frontend Run node id for correlation when polling")


class PipelineExportRequest(BaseModel):
    """The live canvas plus one concrete route selected in Current Pipeline."""

    name: str = Field(default="pipeline", min_length=1, max_length=120)
    canvas_state: dict[str, Any]
    route: list[dict[str, Any]] = Field(..., min_length=1)


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
    project_session_id: str | None = None
    credential_id: str
    review_session_id: str | None = Field(default=None, description="Frontend session id for cancellation; pass reviewNodeId")
    prompt_sections: list[dict] = Field(..., description="List of {name, content} for each section")
    run_results: list[dict] = Field(default_factory=list, description="List of {row_index, output}")
    output_fields: list[dict] = Field(default_factory=list, description="List of {key, display}; used when output_schema not provided")
    output_schema: dict | None = Field(default=None, description="Same as run: return_shape + fields [{ key, type, description?, allow_none? }]; when set, used instead of output_return_shape + output_fields for prompts")
    output_return_shape: str = Field(default="single", description="Fallback when output_schema not provided")
    comparison_rows: list[ReviewComparisonRow] = Field(default_factory=list, description="Per-row match result and context")
    all_rows_matched: bool | None = Field(default=None, description="If True, frontend reports every comparison row matched")
    review_method: str | None = Field(default=None, description="Registered review method id (backend/review_methods.py); defaults to the legacy issue-analysis + suggested-changes pipeline")
    target_section_index: int | None = Field(default=None, description="0-based prompt_sections index a whole-section-rewrite method (e.g. gepa) should optimize; defaults to section 0 when omitted")
    score_mapping: str | None = Field(default=None, description="Serialized Score rule-tree bundle (scoreMappingBundle.js) from the upstream Score node; only methods that self-score candidates (e.g. gepa) need this")

    @model_validator(mode="after")
    def image_inputs_require_session(self):
        has_assets = any(
            isinstance(value, dict)
            and value.get("kind") in ("images", "pdf")
            and bool(value.get("assetIds"))
            for row in self.comparison_rows
            for value in (row.row_input or {}).values()
        )
        if has_assets and not self.project_session_id:
            raise ValueError("Review image/PDF inputs require a project session.")
        return self


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


def _resolve_review_method_id(explicit: str | None, settings: dict | None = None) -> str:
    """Explicit per-request id wins; else the configured default_review_method; else registry picks its own default."""
    explicit = (explicit or "").strip()
    if explicit:
        return explicit
    st = settings if settings is not None else _load_settings()
    return str(st.get("default_review_method") or "").strip()


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


def _credential_model(item: dict) -> str:
    """Prefer new 'model' field; fall back to legacy 'llm'."""
    return (item.get("model") or item.get("llm") or "").strip()


def _credential_provider(item: dict) -> str:
    """Get provider hint from stored item; infer from known legacy model ids if missing."""
    provider = (item.get("provider") or "").strip()
    if provider:
        return provider
    return LEGACY_MODEL_PROVIDER_HINTS.get(_credential_model(item), "")


def _credential_base_url(item: dict) -> str:
    """Use explicit base_url when present, otherwise derive a provider default for legacy creds."""
    base_url = (item.get("base_url") or "").strip()
    if base_url:
        return base_url
    return DEFAULT_BASE_URLS_BY_PROVIDER.get(_credential_provider(item), "")


@app.get("/health")
def health():
    """Health check."""
    return {"ok": True}


@app.post("/api/pipeline/export")
def export_python_pipeline(request: Request, body: PipelineExportRequest):
    """Generate a code-only Python project for the concrete route selected by the user."""
    settings = _load_settings()
    try:
        filename, archive = build_pipeline_archive(
            canvas_state=body.canvas_state,
            route=body.route,
            name=body.name,
            credentials=_load_credentials(),
            default_credential_id=str(settings.get("default_run_credential_id") or ""),
            run_max_tokens=int(settings.get("run_max_tokens") or DEFAULT_SETTINGS["run_max_tokens"]),
            run_concurrency=int(settings.get("run_concurrency") or DEFAULT_SETTINGS["run_concurrency"]),
            author_name=unquote(request.headers.get("X-AnnoBio-User-Name", "")),
        )
    except PipelineExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from fastapi.responses import Response

    return Response(
        content=archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/debug/backend-info")
def debug_backend_info():
    """Debug: confirm this is the current repo version."""
    return {
        "main_file": str(Path(__file__).resolve()),
    }


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


class TerminologyNormalizeRequest(BaseModel):
    terms: list[str] = Field(default_factory=list)
    source: str = Field(default="auto")  # 'auto' | 'rxnorm' | 'mesh'


class TerminologyNormalizeResponse(BaseModel):
    results: dict[str, dict | None]


@app.post("/api/terminology/normalize", response_model=TerminologyNormalizeResponse)
def api_terminology_normalize(body: TerminologyNormalizeRequest):
    """
    Batch-resolve free-text medical terms to a canonical concept id (RxNorm/MeSH), used by
    the Score node's "Medical concept match" flags. Unlike embeddings, each of these is a
    real external network call with no batch endpoint on either service, so this is backed
    by an on-disk cache + a small thread pool (see terminology_client.py) rather than one
    fast local model call -- capped lower than the embeddings endpoint accordingly.
    """
    from terminology_client import MEDICAL_CONCEPT_MATCH_SOURCES, resolve_concepts_bulk

    terms = body.terms
    source = (body.source or "auto").strip().lower()
    if source not in MEDICAL_CONCEPT_MATCH_SOURCES:
        raise HTTPException(status_code=400, detail=f"source must be one of {MEDICAL_CONCEPT_MATCH_SOURCES}")
    if len(terms) > 500:
        raise HTTPException(status_code=400, detail="Too many terms (max 500 per request)")
    for i, t in enumerate(terms):
        if not isinstance(t, str):
            raise HTTPException(status_code=400, detail=f"terms[{i}] must be a string")
        if len(t) > 2000:
            raise HTTPException(status_code=400, detail="Each term must be at most 2000 characters")

    settings = _load_settings()
    results = resolve_concepts_bulk(
        terms,
        source=source,
        ncbi_api_key=(settings.get("ncbi_api_key") or "").strip(),
        ncbi_email=(settings.get("ncbi_email") or "").strip(),
    )
    return TerminologyNormalizeResponse(results=results)


@app.get("/api/credentials", response_model=list[CredentialResponse])
def list_credentials():
    """List all credentials; API key returned masked."""
    items = _load_credentials()
    return [
        CredentialResponse(
            id=item["id"],
            model=_credential_model(item),
            llm=_credential_model(item),
            base_url=_credential_base_url(item),
            provider=_credential_provider(item),
            last_check_ok=item.get("last_check_ok"),
            last_check_error=item.get("last_check_error"),
            api_key_masked=_mask_key(item["api_key"]),
        )
        for item in items
    ]


@app.post("/api/credentials/detect")
async def detect_credential_provider(request: Request):
    """
    Best-effort identify which provider a model id / base_url / api_key belongs to, and
    return that provider's own live model list (for autocomplete). Never raises on a failed
    detection -- callers should treat provider="" as "let the user type it manually".
    """
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    model = (body.get("model") or "").strip()
    base_url = (body.get("base_url") or "").strip()
    api_key = (body.get("api_key") or "").strip()
    return await detect_provider(model=model, base_url=base_url, api_key=api_key)


@app.post("/api/credentials", response_model=CredentialResponse)
async def add_credential(request: Request):
    """Add a credential. Uses raw JSON parsing to avoid Pydantic cache limiting models."""
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    model = (body.get("model") or body.get("llm") or "").strip()
    api_key = (body.get("api_key") or "").strip()
    base_url = (body.get("base_url") or "").strip()
    provider = (body.get("provider") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    if not api_key:
        raise HTTPException(status_code=400, detail="api_key is required")
    items = _load_credentials()
    new_id = str(uuid.uuid4())
    new_item = {
        "id": new_id,
        "model": model,
        "api_key": api_key,
        "base_url": base_url,
        "provider": provider,
    }
    items.append(new_item)
    _save_credentials(items)
    return CredentialResponse(
        id=new_id,
        model=new_item["model"],
        llm=new_item["model"],
        base_url=new_item["base_url"],
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
                model=_credential_model(item),
                llm=_credential_model(item),
                base_url=_credential_base_url(item),
                provider=_credential_provider(item),
                last_check_ok=item.get("last_check_ok"),
                last_check_error=item.get("last_check_error"),
                api_key=item["api_key"],
            )
    raise HTTPException(status_code=404, detail="Credential not found")


@app.get("/api/credentials/openrouter/catalog")
def openrouter_catalog():
    """Public OpenRouter model catalog (no key needed) for the 'choose a model' picker."""
    from oauth_openrouter import get_catalog

    try:
        return {"models": get_catalog()}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not load OpenRouter model catalog: {e}")


_LITELLM_CATALOG_PROVIDERS = {"openai", "anthropic", "gemini", "deepseek", "bedrock"}


@app.get("/api/credentials/litellm/catalog")
def litellm_catalog():
    """LiteLLM's built-in static model list (no key/network needed) for the 'choose a model' picker."""
    import litellm

    models = []
    for model_id, info in litellm.model_cost.items():
        if not isinstance(info, dict):
            continue
        if info.get("mode") != "chat":
            continue
        provider = info.get("litellm_provider")
        if provider not in _LITELLM_CATALOG_PROVIDERS:
            continue
        models.append(
            {
                "id": model_id,
                "name": model_id,
                "provider": provider,
                "vision": info.get("supports_vision") is True,
                "pdf": info.get("supports_pdf_input") is True,
                "prompt_price": info.get("input_cost_per_token"),
                "completion_price": info.get("output_cost_per_token"),
            }
        )
    models.sort(key=lambda m: m["id"])
    return {"models": models}


@app.post("/api/credentials/{credential_id}/test")
async def test_credential(credential_id: str):
    """
    Confirm -- for real -- which provider this credential actually talks to, by sending a
    minimal chat completion under each candidate interpretation (see verify_credential), and
    correct the stored `provider` if it's wrong or was never set. Not just an "is the key
    valid" ping: string guessing alone can't tell that an OpenRouter id like
    "openai/gpt-oss-20b" needs the openrouter/ wrapper rather than a literal call to OpenAI's
    own API, so this is also what runs (in the background, non-blocking) right after Add.
    """
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    base_url = _credential_base_url(cred)
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")

    result = await verify_credential(
        model=model, base_url=base_url, api_key=api_key, current_provider=_credential_provider(cred)
    )
    # Persist the outcome either way -- a failed check must stick after reopening the app,
    # not silently revert to whatever provider/checkmark was last known good.
    cred["last_check_ok"] = result["ok"]
    cred["last_check_error"] = result["error"]
    if result["ok"] and result["provider"] != _credential_provider(cred):
        cred["provider"] = result["provider"]
    _save_credentials(items)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"] or "Verification failed")
    return result


# ---------- Chat (Review Assistant) ----------
class ChatMessage(BaseModel):
    role: str = Field(..., description="user | assistant | system")
    content: str = Field(default="", description="Message content")


class ChatRequest(BaseModel):
    credential_id: str = Field(..., description="Credential id (uses reviewer settings)")
    messages: list[ChatMessage] = Field(..., min_length=1, description="Conversation history; last message should be user")


class AgentChatRequest(ChatRequest):
    workflow_snapshot: dict[str, Any] | None = Field(
        default=None,
        description="Agent-friendly snapshot of the current workflow canvas",
    )
    node_inspection: dict[str, Any] | None = Field(
        default=None,
        description="Detailed context for one workflow node",
    )
    observations: list["AgentObservation"] = Field(
        default_factory=list,
        description="Structured observations gathered from previous skill calls",
    )
    agent_trace: list[str] = Field(
        default_factory=list,
        description="Ordered trace lines describing plan, skill execution, and answer stages",
    )


class AgentSkillDescriptor(BaseModel):
    name: str = Field(..., description="Skill name")
    description: str = Field(default="", description="What the skill does")
    input_schema: dict[str, Any] = Field(default_factory=dict, description="Lightweight argument schema for the skill")


class AgentPlanRequest(ChatRequest):
    workflow_snapshot: dict[str, Any] | None = Field(
        default=None,
        description="Agent-friendly snapshot of the current workflow canvas",
    )
    observations: list["AgentObservation"] = Field(
        default_factory=list,
        description="Structured observations gathered from previous skill calls",
    )
    available_skills: list[AgentSkillDescriptor] = Field(
        default_factory=list,
        description="All skills that the planner may choose from",
    )
    loop_signals: list[str] = Field(
        default_factory=list,
        description="Warnings about repeated calls, no-progress patterns, or runtime guardrails",
    )
    round_index: int = Field(default=1, description="Current planning round number")


class AgentObservation(BaseModel):
    skill_name: str = Field(..., description="Executed skill name")
    args: dict[str, Any] = Field(default_factory=dict, description="Arguments used for the skill call")
    ok: bool = Field(default=True, description="Whether the skill execution succeeded")
    summary: str = Field(default="", description="Short summary of the observation")
    result: Any | None = Field(default=None, description="Raw structured result returned by the skill")


class AgentSkillCall(BaseModel):
    skill_name: str = Field(..., description="Chosen skill name")
    args: dict[str, Any] = Field(
        default_factory=dict,
        description="Arguments for the selected skill, matching the skill input schema",
    )
    reason: str = Field(..., description="Why this skill was chosen")


class AgentPlanResponse(BaseModel):
    done: bool = Field(..., description="Whether the agent has enough evidence to answer now")
    plan_summary: str = Field(..., description="Short summary of the planner's current intent")
    expected_progress: str = Field(..., description="What new information the planner expects to learn")
    skill_calls: list[AgentSkillCall] = Field(..., description="Ordered list of skills to run before answering")


AgentChatRequest.model_rebuild()
AgentPlanRequest.model_rebuild()


def _resolve_chat_credential(credential_id: str) -> tuple[dict, int]:
    items = _load_credentials()
    cred = None
    for item in items:
        if item.get("id") == credential_id:
            cred = item
            break
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    max_tokens = _load_settings().get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    return cred, max_tokens


def _build_agent_plan_prompt(
    messages: list[dict[str, str]],
    workflow_snapshot: dict[str, Any] | None,
    available_skills: list[AgentSkillDescriptor],
    observations: list[AgentObservation],
    loop_signals: list[str],
    round_index: int,
) -> str:
    serialized_skills = [
        {
            "name": skill.name,
            "description": skill.description,
            "input_schema": skill.input_schema,
        }
        for skill in available_skills
    ]
    serialized_observations = [
        {
            "skill_name": observation.skill_name,
            "args": observation.args,
            "ok": observation.ok,
            "summary": observation.summary,
            "result": observation.result,
        }
        for observation in observations
    ]
    return (
        build_agent_plan_instruction_prefix(round_index=round_index)
        + "Available skills JSON:\n"
        + json.dumps(serialized_skills, ensure_ascii=False, indent=2)
        + "\n\nObservation history JSON:\n"
        + json.dumps(serialized_observations, ensure_ascii=False, indent=2)
        + "\n\nLoop signals JSON:\n"
        + json.dumps(loop_signals or [], ensure_ascii=False, indent=2)
        + "\n\nWorkflow snapshot JSON:\n"
        + json.dumps(workflow_snapshot or {}, ensure_ascii=False, indent=2)
        + "\n\nConversation:\n"
        + format_agent_messages_for_log(messages)
    )


def _summarize_messages_for_log(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return "(no messages)"
    parts: list[str] = []
    for idx, message in enumerate(messages, start=1):
        role = str(message.get("role") or "user").upper()
        content = re.sub(r"\s+", " ", str(message.get("content") or "")).strip()
        if len(content) > 160:
            content = content[:157] + "..."
        parts.append(f"[{idx}] {role}: {content or '(empty)'}")
    return "\n".join(parts)


@app.post("/api/chat")
def chat(body: ChatRequest):
    """Simple chat using the given credential. Uses review_max_tokens from settings."""
    cred, max_tokens = _resolve_chat_credential(body.credential_id)
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = _credential_provider(cred)
    base_url = _credential_base_url(cred)
    msgs = [{"role": m.role, "content": m.content or ""} for m in body.messages]
    try:
        content = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=msgs,
            max_tokens=max_tokens,
        )
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/agent/plan", response_model=AgentPlanResponse)
def agent_plan(body: AgentPlanRequest):
    """Plan which agent skills should run before final answering."""
    if not body.available_skills:
        return AgentPlanResponse(done=True, plan_summary="No skills available", skill_calls=[])
    cred, max_tokens = _resolve_chat_credential(body.credential_id)
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = _credential_provider(cred)
    base_url = _credential_base_url(cred)
    prompt = _build_agent_plan_prompt(
        [{"role": m.role, "content": m.content or ""} for m in body.messages],
        workflow_snapshot=body.workflow_snapshot,
        available_skills=body.available_skills,
        observations=body.observations,
        loop_signals=body.loop_signals,
        round_index=body.round_index,
    )
    try:
        _safe_print(_HL + f"[Agent] PLAN round {max(1, int(body.round_index or 1))} start" + _R)
        _safe_print(
            f"[Agent] Available skills: {', '.join(skill.name for skill in body.available_skills) or '(none)'}",
            flush=True,
        )
        _safe_print(
            f"[Agent] Observations so far: {len(body.observations)} | Loop signals: {len(body.loop_signals)}",
            flush=True,
        )
        result, used_fallback, debug = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            prompt=prompt,
            response_model=AgentPlanResponse,
            max_tokens=max_tokens,
            return_debug=True,
        )
        _safe_print(_HL + "[Agent] PLAN raw output" + _R)
        if isinstance(debug, dict) and debug.get("path"):
            _safe_print(
                f"[Agent] PLAN transport={debug.get('path')} fallback={'yes' if used_fallback else 'no'}",
                flush=True,
            )
        if isinstance(debug, dict) and debug.get("raw_response") is not None:
            _safe_print(json.dumps(debug.get("raw_response"), ensure_ascii=False, indent=2, default=str), flush=True)
        elif isinstance(debug, dict) and debug.get("raw_text"):
            _safe_print(str(debug.get("raw_text")), flush=True)
        else:
            _safe_print("[Agent] PLAN raw output unavailable", flush=True)
        plan = AgentPlanResponse.model_validate(result)
        if plan.skill_calls:
            _safe_print(
                f"[Agent] PLAN round {max(1, int(body.round_index or 1))} result: done={plan.done} "
                + ", ".join(
                    f"{call.skill_name}("
                    + json.dumps(
                        call.args if isinstance(call.args, dict) else {},
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                    + ")"
                    for call in plan.skill_calls
                ),
                flush=True,
            )
        else:
            _safe_print(
                f"[Agent] PLAN round {max(1, int(body.round_index or 1))} result: done={plan.done}, no skill selected",
                flush=True,
            )
        return plan
    except Exception as e:
        _safe_print(_HL + f"[Agent] PLAN round {max(1, int(body.round_index or 1))} error: " + _R + str(e), flush=True)
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/agent/chat")
def agent_chat(body: AgentChatRequest):
    """Agent chat using the given credential, enriched with a workflow snapshot."""
    cred, max_tokens = _resolve_chat_credential(body.credential_id)
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = _credential_provider(cred)
    base_url = _credential_base_url(cred)
    msgs = build_agent_messages(
        [{"role": m.role, "content": m.content or ""} for m in body.messages],
        workflow_snapshot=body.workflow_snapshot,
        observations=[observation.model_dump() for observation in body.observations],
        node_inspection=body.node_inspection,
    )
    try:
        _safe_print(_HL + "[Agent] ROUND TRACE" + _R)
        if body.agent_trace:
            for line in body.agent_trace:
                _safe_print(f"[Agent] {line}")
        else:
            _safe_print("[Agent] No execution trace received from client")
        _safe_print(
            f"[Agent] FINAL ANSWER start: workflow_snapshot={'yes' if body.workflow_snapshot else 'no'}, "
            f"observations={len(body.observations)}, "
            f"legacy_node_inspection={'yes' if body.node_inspection else 'no'}",
            flush=True,
        )
        _safe_print(_HL + "[Agent] FINAL ANSWER message summary" + _R)
        _safe_print(_summarize_messages_for_log(msgs), flush=True)
        content = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=msgs,
            max_tokens=max_tokens,
        )
        _safe_print(_HL + "[Agent] FINAL ANSWER complete" + _R, flush=True)
        return {"content": content}
    except Exception as e:
        _safe_print(_HL + "[Agent] FINAL ANSWER error: " + _R + str(e), flush=True)
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


@app.post("/api/credentials/openrouter/start")
def start_openrouter_oauth():
    """Begin OpenRouter OAuth PKCE login; returns the URL to open in the system browser."""
    from oauth_openrouter import start_oauth

    public_base_url = os.environ.get("PROMPT_STUDIO_PUBLIC_BASE_URL", "")
    return start_oauth(BACKEND_HOST, BACKEND_PORT, public_base_url)


@app.get("/api/credentials/openrouter/callback")
def openrouter_oauth_callback(state: str = "", code: str = ""):
    """Redirect target hit by the user's browser after they approve on openrouter.ai."""
    from oauth_openrouter import handle_callback

    return handle_callback(state, code)


@app.get("/api/credentials/openrouter/status/{state}")
def openrouter_oauth_status(state: str):
    """Poll target for the frontend while the browser-side OAuth flow is in progress."""
    from oauth_openrouter import get_status

    return get_status(state)


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
_run_print_lock = threading.Lock()  # keeps one row's multi-line debug log block from interleaving with another's

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




def _do_run_work(
    run_id: str,
    credential_id: str,
    prompts: list,
    output_schema: dict,
    project_session_id: str | None = None,
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
        provider = _credential_provider(cred)
        model = _credential_model(cred)
        api_key = cred.get("api_key", "")
        base_url = _credential_base_url(cred)
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
        run_concurrency = min(10, max(1, int(run_settings.get("run_concurrency", 4) or 4)))

        def process_one(row_index: int, prompt) -> tuple[int, list[dict]]:
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
                    with _run_print_lock:
                        _safe_print("\n" + _HL + _SEP + _R)
                        _safe_print(_HL + f"[Run] Row {row_index} PROMPT SENT TO LLM:" + _R)
                        _safe_print(_HL + _SEP + _R)
                        _safe_print(prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False, indent=2, default=str))
                    if isinstance(prompt, dict):
                        if prompt.get("error"):
                            raise ValueError(prompt["error"])
                        model_prompt = resolve_content(prompt["content"], project_session_id)
                    else:
                        model_prompt = prompt
                    out, used_fallback, debug = llm_run_structured(
                        provider=provider,
                        model=model,
                        api_key=api_key,
                        base_url=base_url,
                        prompt=model_prompt,
                        response_model=ResponseModel,
                        max_tokens=run_max_tokens,
                        return_shape=return_shape,
                        return_debug=True,
                    )
                    with _run_print_lock:
                        _safe_print(_HL + _SEP + _R)
                        _safe_print(
                            _HL
                            + f"[Run] Row {row_index} LLM RAW OUTPUT"
                            + (f" ({debug.get('path')})" if isinstance(debug, dict) and debug.get("path") else "")
                            + (", fallback" if used_fallback else "")
                            + ":"
                            + _R
                        )
                        _safe_print(_HL + _SEP + _R)
                        if isinstance(debug, dict) and debug.get("raw_response") is not None:
                            _safe_print(json.dumps(debug.get("raw_response"), ensure_ascii=False, indent=2, default=str))
                        elif isinstance(debug, dict) and debug.get("raw_text"):
                            _safe_print(str(debug.get("raw_text")))
                        else:
                            _safe_print("(raw output unavailable)")
                        _safe_print(_HL + _SEP + _R)
                        _safe_print(_HL + f"[Run] Row {row_index} LLM PARSED OUTPUT:" + _R)
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
                            time.sleep(min(2 ** attempt, 8))
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
                    time.sleep(min(2 ** attempt, 8))
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

        # Up to run_concurrency rows in flight per run job. Separate run jobs (e.g. different nodes) may still run at once.
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=run_concurrency)
        try:
            futures = [executor.submit(process_one, i, prompt) for i, prompt in enumerate(prompts)]
            for fut in concurrent.futures.as_completed(futures):
                row_index, items = fut.result()
                _row_done_write_progress(row_index, items)
                if cancelled_early:
                    break
        finally:
            executor.shutdown(wait=True, cancel_futures=True)

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
        args=(run_id, body.credential_id, body.prompts if body.prompts is not None else body.samples, body.output_schema, body.project_session_id),
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


@app.get("/api/review/methods")
def list_review_methods_endpoint():
    """List registered review methods (id, label, stages) for the frontend method picker."""
    from review_methods import list_review_methods

    return {"methods": list_review_methods()}


@app.post("/api/review/analyze")
def review_analyze(body: ReviewRequest):
    """Start review job in background; returns 202 with review_id. Poll GET /api/review/result/{review_id}. Pipeline: review_pipeline.py (per-row analysis → localized prompt edits)."""
    from review_methods import get_review_method

    review_id = str(uuid.uuid4())
    review_node_id = body.review_session_id or ""
    review_method = get_review_method(_resolve_review_method_id(body.review_method))
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
    return JSONResponse(
        status_code=202,
        content={
            "review_id": review_id,
            "review_node_id": review_node_id,
            "review_method_id": review_method.id,
            "review_stages": review_method.to_dict()["stages"],
            "supports_segment_optimization": review_method.supports_segment_optimization,
        },
    )


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


# ---------- PubMed import (bulk-fetch articles into a Dataset) ----------
# Same shape as the Run job block above: background thread + job_id + polling, persisted to
# disk so a large import survives a backend restart. job: { status, completed, total, headers,
# rows, error? }. Cancellation/abandonment reuse the same timeout as Run (RUN_ABANDON_TIMEOUT_SEC).
PUBMED_MAX_IDS_CAP = 5000  # sane ceiling regardless of what the client requests

_pubmed_jobs: dict[str, dict] = {}
_pubmed_jobs_lock = threading.Lock()
_pubmed_cancelled: set[str] = set()
_pubmed_last_activity: dict[str, float] = {}


class PubmedImportRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, description="PMIDs to fetch")
    fields: list[str] = Field(..., min_length=1, description="Keys from pubmed_client.PUBMED_FIELDS to import as columns")


class _PubmedStopSignal(Exception):
    """Raised from the on_batch callback to unwind fetch_articles when cancelled/abandoned."""


def _touch_pubmed_activity(job_id: str) -> None:
    _pubmed_last_activity[job_id] = time.time()


def _persist_pubmed_jobs() -> None:
    with _pubmed_jobs_lock:
        snapshot = dict(_pubmed_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PUBMED_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[PubMed] persist failed: {e}", file=sys.stderr)


def _load_pubmed_jobs() -> None:
    if not PUBMED_JOBS_FILE.exists():
        return
    try:
        raw = PUBMED_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _pubmed_jobs_lock:
            _pubmed_jobs.clear()
            _pubmed_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[PubMed] load persisted jobs failed: {e}", file=sys.stderr)


_load_pubmed_jobs()


def _do_pubmed_import_work(job_id: str, req: PubmedImportRequest) -> None:
    from pubmed_client import PUBMED_FIELDS, fetch_articles

    try:
        settings = _load_settings()
        api_key = (settings.get("ncbi_api_key") or "").strip()
        email = (settings.get("ncbi_email") or "").strip()
        fields = [f for f in req.fields if f in PUBMED_FIELDS]
        if not fields:
            with _pubmed_jobs_lock:
                _pubmed_jobs[job_id] = {"status": "done", "error": "No valid fields selected"}
            _persist_pubmed_jobs()
            return

        pmids = [p.strip() for p in req.ids if p.strip()]
        # de-dupe, keep order
        seen = set()
        pmids = [p for p in pmids if not (p in seen or seen.add(p))][:PUBMED_MAX_IDS_CAP]

        total = len(pmids)
        with _pubmed_jobs_lock:
            _pubmed_jobs[job_id]["total"] = total
            _pubmed_jobs[job_id]["completed"] = 0
            _pubmed_jobs[job_id]["headers"] = [PUBMED_FIELDS[f] for f in fields]
            _pubmed_jobs[job_id]["rows"] = []
            _pubmed_jobs[job_id]["not_found"] = []
        _persist_pubmed_jobs()

        if total == 0:
            with _pubmed_jobs_lock:
                _pubmed_jobs[job_id]["status"] = "done"
            _persist_pubmed_jobs()
            return

        def on_batch(batch_articles: list[dict], not_found: list[str], completed: int, batch_total: int) -> None:
            is_cancelled = job_id in _pubmed_cancelled
            is_abandoned = (time.time() - _pubmed_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            with _pubmed_jobs_lock:
                # Append incrementally (not just at the end) so a cancelled/abandoned job still
                # keeps whatever was already fetched, instead of throwing away completed work.
                _pubmed_jobs[job_id]["rows"].extend([a.get(f, "") for f in fields] for a in batch_articles)
                _pubmed_jobs[job_id]["completed"] = completed
                _pubmed_jobs[job_id]["not_found"].extend(not_found)
            _persist_pubmed_jobs()
            if is_cancelled or is_abandoned:
                raise _PubmedStopSignal()

        try:
            fetch_articles(pmids, fields=fields, api_key=api_key, email=email, on_batch=on_batch)
        except _PubmedStopSignal:
            with _pubmed_jobs_lock:
                job = _pubmed_jobs.get(job_id, {})
                job["status"] = "cancelled" if job_id in _pubmed_cancelled else "done"
            _persist_pubmed_jobs()
            return

        with _pubmed_jobs_lock:
            _pubmed_jobs[job_id]["status"] = "done"
        _persist_pubmed_jobs()
    except Exception as e:
        with _pubmed_jobs_lock:
            _pubmed_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_pubmed_jobs()


@app.post("/api/pubmed/import")
def start_pubmed_import(body: PubmedImportRequest):
    """Start a PubMed import (fetch by PMID) in the background; returns 202 with job_id. Poll GET .../result/{job_id}."""
    job_id = str(uuid.uuid4())
    with _pubmed_jobs_lock:
        _pubmed_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "headers": [], "rows": []}
        _touch_pubmed_activity(job_id)
    _persist_pubmed_jobs()
    thread = threading.Thread(target=_do_pubmed_import_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/pubmed/import/result/{job_id}")
def get_pubmed_import_result(job_id: str):
    """Return 202 while running (with partial rows), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _pubmed_jobs_lock:
        job = _pubmed_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Import job not found")
        if job.get("status") == "running":
            _touch_pubmed_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        headers = job.get("headers") or []
        rows = (job.get("rows") or [])[:]
        not_found = (job.get("not_found") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "headers": headers, "rows": rows},
        )
    if error:
        return {"status": "done", "error": error, "headers": [], "rows": []}
    return {"status": status, "completed": completed, "total": total, "headers": headers, "rows": rows, "not_found": not_found}


@app.post("/api/pubmed/import/cancel/{job_id}")
def cancel_pubmed_import(job_id: str):
    """Mark import as cancelled; worker stops after the current batch."""
    with _pubmed_jobs_lock:
        if job_id not in _pubmed_jobs:
            raise HTTPException(status_code=404, detail="Import job not found")
        if _pubmed_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _pubmed_jobs[job_id].get("status")}
        _pubmed_cancelled.add(job_id)
        _touch_pubmed_activity(job_id)
    return {"ok": True, "status": "cancelling"}


# ---------- ClinicalTrials.gov import (bulk-fetch studies into a Dataset) ----------
# Same shape as the PubMed job block above: background thread + job_id + polling, persisted to
# disk so a large import survives a backend restart. job: { status, completed, total, headers,
# rows, error? }. Cancellation/abandonment reuse the same timeout as Run (RUN_ABANDON_TIMEOUT_SEC).
CLINICALTRIALS_MAX_IDS_CAP = 5000  # sane ceiling regardless of what the client requests

_clinicaltrials_jobs: dict[str, dict] = {}
_clinicaltrials_jobs_lock = threading.Lock()
_clinicaltrials_cancelled: set[str] = set()
_clinicaltrials_last_activity: dict[str, float] = {}


class ClinicaltrialsImportRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, description="NCT ids to fetch")
    fields: list[str] = Field(..., min_length=1, description="Keys from clinicaltrials_client.CT_FIELDS to import as columns")


class _ClinicaltrialsStopSignal(Exception):
    """Raised from the on_batch callback to unwind fetch_studies when cancelled/abandoned."""


def _touch_clinicaltrials_activity(job_id: str) -> None:
    _clinicaltrials_last_activity[job_id] = time.time()


def _persist_clinicaltrials_jobs() -> None:
    with _clinicaltrials_jobs_lock:
        snapshot = dict(_clinicaltrials_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CLINICALTRIALS_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[ClinicalTrials] persist failed: {e}", file=sys.stderr)


def _load_clinicaltrials_jobs() -> None:
    if not CLINICALTRIALS_JOBS_FILE.exists():
        return
    try:
        raw = CLINICALTRIALS_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _clinicaltrials_jobs_lock:
            _clinicaltrials_jobs.clear()
            _clinicaltrials_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[ClinicalTrials] load persisted jobs failed: {e}", file=sys.stderr)


_load_clinicaltrials_jobs()


def _do_clinicaltrials_import_work(job_id: str, req: ClinicaltrialsImportRequest) -> None:
    from clinicaltrials_client import CT_FIELDS, fetch_studies

    try:
        fields = [f for f in req.fields if f in CT_FIELDS]
        if not fields:
            with _clinicaltrials_jobs_lock:
                _clinicaltrials_jobs[job_id] = {"status": "done", "error": "No valid fields selected"}
            _persist_clinicaltrials_jobs()
            return

        nct_ids = [p.strip().upper() for p in req.ids if p.strip()]
        # de-dupe, keep order
        seen = set()
        nct_ids = [p for p in nct_ids if not (p in seen or seen.add(p))][:CLINICALTRIALS_MAX_IDS_CAP]

        total = len(nct_ids)
        with _clinicaltrials_jobs_lock:
            _clinicaltrials_jobs[job_id]["total"] = total
            _clinicaltrials_jobs[job_id]["completed"] = 0
            _clinicaltrials_jobs[job_id]["headers"] = [CT_FIELDS[f] for f in fields]
            _clinicaltrials_jobs[job_id]["rows"] = []
            _clinicaltrials_jobs[job_id]["not_found"] = []
        _persist_clinicaltrials_jobs()

        if total == 0:
            with _clinicaltrials_jobs_lock:
                _clinicaltrials_jobs[job_id]["status"] = "done"
            _persist_clinicaltrials_jobs()
            return

        def on_batch(batch_studies: list[dict], not_found: list[str], completed: int, batch_total: int) -> None:
            is_cancelled = job_id in _clinicaltrials_cancelled
            is_abandoned = (time.time() - _clinicaltrials_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            with _clinicaltrials_jobs_lock:
                # Append incrementally (not just at the end) so a cancelled/abandoned job still
                # keeps whatever was already fetched, instead of throwing away completed work.
                _clinicaltrials_jobs[job_id]["rows"].extend([s.get(f, "") for f in fields] for s in batch_studies)
                _clinicaltrials_jobs[job_id]["completed"] = completed
                _clinicaltrials_jobs[job_id]["not_found"].extend(not_found)
            _persist_clinicaltrials_jobs()
            if is_cancelled or is_abandoned:
                raise _ClinicaltrialsStopSignal()

        try:
            fetch_studies(nct_ids, fields=fields, on_batch=on_batch)
        except _ClinicaltrialsStopSignal:
            with _clinicaltrials_jobs_lock:
                job = _clinicaltrials_jobs.get(job_id, {})
                job["status"] = "cancelled" if job_id in _clinicaltrials_cancelled else "done"
            _persist_clinicaltrials_jobs()
            return

        with _clinicaltrials_jobs_lock:
            _clinicaltrials_jobs[job_id]["status"] = "done"
        _persist_clinicaltrials_jobs()
    except Exception as e:
        with _clinicaltrials_jobs_lock:
            _clinicaltrials_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_clinicaltrials_jobs()


@app.post("/api/clinicaltrials/import")
def start_clinicaltrials_import(body: ClinicaltrialsImportRequest):
    """Start a ClinicalTrials.gov import (fetch by NCT id) in the background; returns 202 with job_id. Poll GET .../result/{job_id}."""
    job_id = str(uuid.uuid4())
    with _clinicaltrials_jobs_lock:
        _clinicaltrials_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "headers": [], "rows": []}
        _touch_clinicaltrials_activity(job_id)
    _persist_clinicaltrials_jobs()
    thread = threading.Thread(target=_do_clinicaltrials_import_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/clinicaltrials/import/result/{job_id}")
def get_clinicaltrials_import_result(job_id: str):
    """Return 202 while running (with partial rows), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _clinicaltrials_jobs_lock:
        job = _clinicaltrials_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Import job not found")
        if job.get("status") == "running":
            _touch_clinicaltrials_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        headers = job.get("headers") or []
        rows = (job.get("rows") or [])[:]
        not_found = (job.get("not_found") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "headers": headers, "rows": rows},
        )
    if error:
        return {"status": "done", "error": error, "headers": [], "rows": []}
    return {"status": status, "completed": completed, "total": total, "headers": headers, "rows": rows, "not_found": not_found}


@app.post("/api/clinicaltrials/import/cancel/{job_id}")
def cancel_clinicaltrials_import(job_id: str):
    """Mark import as cancelled; worker stops after the current batch."""
    with _clinicaltrials_jobs_lock:
        if job_id not in _clinicaltrials_jobs:
            raise HTTPException(status_code=404, detail="Import job not found")
        if _clinicaltrials_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _clinicaltrials_jobs[job_id].get("status")}
        _clinicaltrials_cancelled.add(job_id)
        _touch_clinicaltrials_activity(job_id)
    return {"ok": True, "status": "cancelling"}


# ---------- bioRxiv/medRxiv import (bulk-fetch preprints into a Dataset) ----------
# Same shape as the ClinicalTrials.gov job block above: background thread + job_id + polling,
# persisted to disk so a large import survives a backend restart. job: { status, completed,
# total, headers, rows, error? }. Cancellation/abandonment reuse the same timeout as Run
# (RUN_ABANDON_TIMEOUT_SEC).
PREPRINT_MAX_IDS_CAP = 5000  # sane ceiling regardless of what the client requests

_preprint_jobs: dict[str, dict] = {}
_preprint_jobs_lock = threading.Lock()
_preprint_cancelled: set[str] = set()
_preprint_last_activity: dict[str, float] = {}


class PreprintImportRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, description="DOIs to fetch")
    fields: list[str] = Field(..., min_length=1, description="Keys from preprint_client.PREPRINT_FIELDS to import as columns")


class _PreprintStopSignal(Exception):
    """Raised from the on_batch callback to unwind fetch_preprints when cancelled/abandoned."""


def _touch_preprint_activity(job_id: str) -> None:
    _preprint_last_activity[job_id] = time.time()


def _persist_preprint_jobs() -> None:
    with _preprint_jobs_lock:
        snapshot = dict(_preprint_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PREPRINT_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[Preprint] persist failed: {e}", file=sys.stderr)


def _load_preprint_jobs() -> None:
    if not PREPRINT_JOBS_FILE.exists():
        return
    try:
        raw = PREPRINT_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _preprint_jobs_lock:
            _preprint_jobs.clear()
            _preprint_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[Preprint] load persisted jobs failed: {e}", file=sys.stderr)


_load_preprint_jobs()


def _do_preprint_import_work(job_id: str, req: PreprintImportRequest) -> None:
    from preprint_client import PREPRINT_FIELDS, fetch_preprints

    try:
        fields = [f for f in req.fields if f in PREPRINT_FIELDS]
        if not fields:
            with _preprint_jobs_lock:
                _preprint_jobs[job_id] = {"status": "done", "error": "No valid fields selected"}
            _persist_preprint_jobs()
            return

        dois = [p.strip() for p in req.ids if p.strip()]
        # de-dupe, keep order
        seen = set()
        dois = [p for p in dois if not (p in seen or seen.add(p))][:PREPRINT_MAX_IDS_CAP]

        total = len(dois)
        with _preprint_jobs_lock:
            _preprint_jobs[job_id]["total"] = total
            _preprint_jobs[job_id]["completed"] = 0
            _preprint_jobs[job_id]["headers"] = [PREPRINT_FIELDS[f] for f in fields]
            _preprint_jobs[job_id]["rows"] = []
            _preprint_jobs[job_id]["not_found"] = []
        _persist_preprint_jobs()

        if total == 0:
            with _preprint_jobs_lock:
                _preprint_jobs[job_id]["status"] = "done"
            _persist_preprint_jobs()
            return

        def on_batch(batch_entries: list[dict], not_found: list[str], completed: int, batch_total: int) -> None:
            is_cancelled = job_id in _preprint_cancelled
            is_abandoned = (time.time() - _preprint_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            with _preprint_jobs_lock:
                # Append incrementally (not just at the end) so a cancelled/abandoned job still
                # keeps whatever was already fetched, instead of throwing away completed work.
                _preprint_jobs[job_id]["rows"].extend([e.get(f, "") for f in fields] for e in batch_entries)
                _preprint_jobs[job_id]["completed"] = completed
                _preprint_jobs[job_id]["not_found"].extend(not_found)
            _persist_preprint_jobs()
            if is_cancelled or is_abandoned:
                raise _PreprintStopSignal()

        try:
            fetch_preprints(dois, fields=fields, on_batch=on_batch)
        except _PreprintStopSignal:
            with _preprint_jobs_lock:
                job = _preprint_jobs.get(job_id, {})
                job["status"] = "cancelled" if job_id in _preprint_cancelled else "done"
            _persist_preprint_jobs()
            return

        with _preprint_jobs_lock:
            _preprint_jobs[job_id]["status"] = "done"
        _persist_preprint_jobs()
    except Exception as e:
        with _preprint_jobs_lock:
            _preprint_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_preprint_jobs()


@app.post("/api/preprint/import")
def start_preprint_import(body: PreprintImportRequest):
    """Start a bioRxiv/medRxiv import (fetch by DOI) in the background; returns 202 with job_id. Poll GET .../result/{job_id}."""
    job_id = str(uuid.uuid4())
    with _preprint_jobs_lock:
        _preprint_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "headers": [], "rows": []}
        _touch_preprint_activity(job_id)
    _persist_preprint_jobs()
    thread = threading.Thread(target=_do_preprint_import_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/preprint/import/result/{job_id}")
def get_preprint_import_result(job_id: str):
    """Return 202 while running (with partial rows), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _preprint_jobs_lock:
        job = _preprint_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Import job not found")
        if job.get("status") == "running":
            _touch_preprint_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        headers = job.get("headers") or []
        rows = (job.get("rows") or [])[:]
        not_found = (job.get("not_found") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "headers": headers, "rows": rows},
        )
    if error:
        return {"status": "done", "error": error, "headers": [], "rows": []}
    return {"status": status, "completed": completed, "total": total, "headers": headers, "rows": rows, "not_found": not_found}


@app.post("/api/preprint/import/cancel/{job_id}")
def cancel_preprint_import(job_id: str):
    """Mark import as cancelled; worker stops after the current batch."""
    with _preprint_jobs_lock:
        if job_id not in _preprint_jobs:
            raise HTTPException(status_code=404, detail="Import job not found")
        if _preprint_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _preprint_jobs[job_id].get("status")}
        _preprint_cancelled.add(job_id)
        _touch_preprint_activity(job_id)
    return {"ok": True, "status": "cancelling"}


# ---------- ChEMBL import (bulk-fetch molecules into a Dataset) ----------
# Same shape as the ClinicalTrials.gov job block above: background thread + job_id + polling,
# persisted to disk so a large import survives a backend restart. job: { status, completed,
# total, headers, rows, error? }. Cancellation/abandonment reuse the same timeout as Run
# (RUN_ABANDON_TIMEOUT_SEC).
CHEMBL_MAX_IDS_CAP = 5000  # sane ceiling regardless of what the client requests

_chembl_jobs: dict[str, dict] = {}
_chembl_jobs_lock = threading.Lock()
_chembl_cancelled: set[str] = set()
_chembl_last_activity: dict[str, float] = {}


class ChemblImportRequest(BaseModel):
    ids: list[str] = Field(..., min_length=1, description="ChEMBL ids to fetch")
    fields: list[str] = Field(..., min_length=1, description="Keys from chembl_client.CHEMBL_FIELDS to import as columns")


class _ChemblStopSignal(Exception):
    """Raised from the on_batch callback to unwind fetch_molecules when cancelled/abandoned."""


def _touch_chembl_activity(job_id: str) -> None:
    _chembl_last_activity[job_id] = time.time()


def _persist_chembl_jobs() -> None:
    with _chembl_jobs_lock:
        snapshot = dict(_chembl_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CHEMBL_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[ChEMBL] persist failed: {e}", file=sys.stderr)


def _load_chembl_jobs() -> None:
    if not CHEMBL_JOBS_FILE.exists():
        return
    try:
        raw = CHEMBL_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _chembl_jobs_lock:
            _chembl_jobs.clear()
            _chembl_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[ChEMBL] load persisted jobs failed: {e}", file=sys.stderr)


_load_chembl_jobs()


def _do_chembl_import_work(job_id: str, req: ChemblImportRequest) -> None:
    from chembl_client import CHEMBL_FIELDS, fetch_molecules

    try:
        fields = [f for f in req.fields if f in CHEMBL_FIELDS]
        if not fields:
            with _chembl_jobs_lock:
                _chembl_jobs[job_id] = {"status": "done", "error": "No valid fields selected"}
            _persist_chembl_jobs()
            return

        chembl_ids = [p.strip().upper() for p in req.ids if p.strip()]
        # de-dupe, keep order
        seen = set()
        chembl_ids = [p for p in chembl_ids if not (p in seen or seen.add(p))][:CHEMBL_MAX_IDS_CAP]

        total = len(chembl_ids)
        with _chembl_jobs_lock:
            _chembl_jobs[job_id]["total"] = total
            _chembl_jobs[job_id]["completed"] = 0
            _chembl_jobs[job_id]["headers"] = [CHEMBL_FIELDS[f] for f in fields]
            _chembl_jobs[job_id]["rows"] = []
            _chembl_jobs[job_id]["not_found"] = []
        _persist_chembl_jobs()

        if total == 0:
            with _chembl_jobs_lock:
                _chembl_jobs[job_id]["status"] = "done"
            _persist_chembl_jobs()
            return

        def on_batch(batch_molecules: list[dict], not_found: list[str], completed: int, batch_total: int) -> None:
            is_cancelled = job_id in _chembl_cancelled
            is_abandoned = (time.time() - _chembl_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            with _chembl_jobs_lock:
                # Append incrementally (not just at the end) so a cancelled/abandoned job still
                # keeps whatever was already fetched, instead of throwing away completed work.
                _chembl_jobs[job_id]["rows"].extend([m.get(f, "") for f in fields] for m in batch_molecules)
                _chembl_jobs[job_id]["completed"] = completed
                _chembl_jobs[job_id]["not_found"].extend(not_found)
            _persist_chembl_jobs()
            if is_cancelled or is_abandoned:
                raise _ChemblStopSignal()

        try:
            fetch_molecules(chembl_ids, fields=fields, on_batch=on_batch)
        except _ChemblStopSignal:
            with _chembl_jobs_lock:
                job = _chembl_jobs.get(job_id, {})
                job["status"] = "cancelled" if job_id in _chembl_cancelled else "done"
            _persist_chembl_jobs()
            return

        with _chembl_jobs_lock:
            _chembl_jobs[job_id]["status"] = "done"
        _persist_chembl_jobs()
    except Exception as e:
        with _chembl_jobs_lock:
            _chembl_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_chembl_jobs()


@app.post("/api/chembl/import")
def start_chembl_import(body: ChemblImportRequest):
    """Start a ChEMBL import (fetch by ChEMBL id) in the background; returns 202 with job_id. Poll GET .../result/{job_id}."""
    job_id = str(uuid.uuid4())
    with _chembl_jobs_lock:
        _chembl_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "headers": [], "rows": []}
        _touch_chembl_activity(job_id)
    _persist_chembl_jobs()
    thread = threading.Thread(target=_do_chembl_import_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/chembl/import/result/{job_id}")
def get_chembl_import_result(job_id: str):
    """Return 202 while running (with partial rows), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _chembl_jobs_lock:
        job = _chembl_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Import job not found")
        if job.get("status") == "running":
            _touch_chembl_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        headers = job.get("headers") or []
        rows = (job.get("rows") or [])[:]
        not_found = (job.get("not_found") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "headers": headers, "rows": rows},
        )
    if error:
        return {"status": "done", "error": error, "headers": [], "rows": []}
    return {"status": status, "completed": completed, "total": total, "headers": headers, "rows": rows, "not_found": not_found}


@app.post("/api/chembl/import/cancel/{job_id}")
def cancel_chembl_import(job_id: str):
    """Mark import as cancelled; worker stops after the current batch."""
    with _chembl_jobs_lock:
        if job_id not in _chembl_jobs:
            raise HTTPException(status_code=404, detail="Import job not found")
        if _chembl_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _chembl_jobs[job_id].get("status")}
        _chembl_cancelled.add(job_id)
        _touch_chembl_activity(job_id)
    return {"ok": True, "status": "cancelling"}


# ---------- Process node (runs a user Python function per dataset row, delegates to process_exec.py) ----------
_process_jobs: dict[str, dict] = {}
_process_jobs_lock = threading.Lock()
_process_cancelled: set[str] = set()
_process_last_activity: dict[str, float] = {}


class ProcessRunRequest(BaseModel):
    python_path: str = Field(..., min_length=1, description="Path to a Python interpreter (system install or a venv)")
    code: str = Field(..., min_length=1, description="User code defining process(row) -> dict | None")
    headers: list[str] = Field(..., description="Column names; row dict passed to process() is keyed by these")
    rows: list[list[Any]] = Field(default_factory=list, description="Input rows, same order as headers")
    project_session_id: str | None = Field(default=None, description="Required when any row has an image/PDF cell -- see asset_store.py")


def _touch_process_activity(job_id: str) -> None:
    _process_last_activity[job_id] = time.time()


def _persist_process_jobs() -> None:
    with _process_jobs_lock:
        snapshot = dict(_process_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PROCESS_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[Process] persist failed: {e}", file=sys.stderr)


def _load_process_jobs() -> None:
    if not PROCESS_JOBS_FILE.exists():
        return
    try:
        raw = PROCESS_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _process_jobs_lock:
            _process_jobs.clear()
            _process_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[Process] load persisted jobs failed: {e}", file=sys.stderr)


_load_process_jobs()


def _do_process_work(job_id: str, req: ProcessRunRequest) -> None:
    from process_exec import run_process_rows
    from asset_store import resolve_cell_for_code

    try:
        resolved_rows = resolve_cell_for_code(req.rows, req.project_session_id)
        total = len(resolved_rows)
        with _process_jobs_lock:
            _process_jobs[job_id]["total"] = total
            _process_jobs[job_id]["completed"] = 0
            _process_jobs[job_id]["results"] = []
        _persist_process_jobs()

        if total == 0:
            with _process_jobs_lock:
                _process_jobs[job_id]["status"] = "done"
            _persist_process_jobs()
            return

        def on_row(index: int, outcome: dict) -> None:
            with _process_jobs_lock:
                _process_jobs[job_id]["results"].append(outcome)
                _process_jobs[job_id]["completed"] = index + 1
            _persist_process_jobs()
            _touch_process_activity(job_id)

        def is_cancelled() -> bool:
            is_stopped = job_id in _process_cancelled
            is_abandoned = (time.time() - _process_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            return is_stopped or is_abandoned

        run_process_rows(req.python_path, req.code, req.headers, resolved_rows, on_row, is_cancelled)

        with _process_jobs_lock:
            _process_jobs[job_id]["status"] = "cancelled" if job_id in _process_cancelled else "done"
        _persist_process_jobs()
    except Exception as e:
        with _process_jobs_lock:
            _process_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_process_jobs()


@app.post("/api/process/run")
def start_process_run(body: ProcessRunRequest):
    """Start a Process run (Python `process(row)` per dataset row) in the background; returns 202 with job_id."""
    job_id = str(uuid.uuid4())
    with _process_jobs_lock:
        _process_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "results": []}
        _touch_process_activity(job_id)
    _persist_process_jobs()
    thread = threading.Thread(target=_do_process_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/process/run/result/{job_id}")
def get_process_run_result(job_id: str):
    """Return 202 while running (with partial results), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _process_jobs_lock:
        job = _process_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Process job not found")
        if job.get("status") == "running":
            _touch_process_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        results = (job.get("results") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "results": results},
        )
    if error:
        return {"status": "done", "error": error, "results": []}
    return {"status": status, "completed": completed, "total": total, "results": results}


@app.post("/api/process/run/cancel/{job_id}")
def cancel_process_run(job_id: str):
    """Mark a Process run as cancelled; worker stops after the current row."""
    with _process_jobs_lock:
        if job_id not in _process_jobs:
            raise HTTPException(status_code=404, detail="Process job not found")
        if _process_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _process_jobs[job_id].get("status")}
        _process_cancelled.add(job_id)
        _touch_process_activity(job_id)
    return {"ok": True, "status": "cancelling"}


@app.post("/api/process/check-python")
def check_process_python(body: dict = Body(...)):
    """Runs `<python_path> --version` to validate a Settings-page Python interpreter path."""
    from process_exec import check_python

    python_path = str(body.get("python_path") or "").strip()
    return check_python(python_path)


# ---------- Score "Match by code" (runs a user Python match(input_row, output_row, gt_row) predicate,
#             delegates to match_exec.py) ----------
_match_jobs: dict[str, dict] = {}
_match_jobs_lock = threading.Lock()
_match_cancelled: set[str] = set()
_match_last_activity: dict[str, float] = {}


class MatchRunRequest(BaseModel):
    python_path: str = Field(..., min_length=1, description="Path to a Python interpreter (system install or a venv)")
    code: str = Field(..., min_length=1, description="User code defining match(input_row, output_row, gt_row) -> bool")
    run_rows: list[dict] = Field(default_factory=list, description="Each: {input_row: dict, output_row: dict}")
    gt_rows: list[dict] = Field(default_factory=list, description="Each: {gt_row: dict}")
    project_session_id: str | None = Field(default=None, description="Required when any row has an image/PDF cell -- see asset_store.py")


def _touch_match_activity(job_id: str) -> None:
    _match_last_activity[job_id] = time.time()


def _persist_match_jobs() -> None:
    with _match_jobs_lock:
        snapshot = dict(_match_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        MATCH_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[Match] persist failed: {e}", file=sys.stderr)


def _load_match_jobs() -> None:
    if not MATCH_JOBS_FILE.exists():
        return
    try:
        raw = MATCH_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _match_jobs_lock:
            _match_jobs.clear()
            _match_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[Match] load persisted jobs failed: {e}", file=sys.stderr)


_load_match_jobs()


def _do_match_work(job_id: str, req: MatchRunRequest) -> None:
    from match_exec import run_match_pairs
    from asset_store import resolve_cell_for_code

    try:
        resolved_run_rows = resolve_cell_for_code(req.run_rows, req.project_session_id)
        resolved_gt_rows = resolve_cell_for_code(req.gt_rows, req.project_session_id)
        total = len(resolved_run_rows)
        with _match_jobs_lock:
            _match_jobs[job_id]["total"] = total
            _match_jobs[job_id]["completed"] = 0
            _match_jobs[job_id]["results"] = []
        _persist_match_jobs()

        if total == 0:
            with _match_jobs_lock:
                _match_jobs[job_id]["status"] = "done"
            _persist_match_jobs()
            return

        def on_row(index: int, outcome: dict) -> None:
            with _match_jobs_lock:
                _match_jobs[job_id]["results"].append(outcome)
                _match_jobs[job_id]["completed"] = index + 1
            _persist_match_jobs()
            _touch_match_activity(job_id)

        def is_cancelled() -> bool:
            is_stopped = job_id in _match_cancelled
            is_abandoned = (time.time() - _match_last_activity.get(job_id, time.time())) > RUN_ABANDON_TIMEOUT_SEC
            return is_stopped or is_abandoned

        run_match_pairs(req.python_path, req.code, resolved_run_rows, resolved_gt_rows, on_row, is_cancelled)

        with _match_jobs_lock:
            _match_jobs[job_id]["status"] = "cancelled" if job_id in _match_cancelled else "done"
        _persist_match_jobs()
    except Exception as e:
        with _match_jobs_lock:
            _match_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_match_jobs()


@app.post("/api/score/match/run")
def start_match_run(body: MatchRunRequest):
    """Start a Match-by-code run (Python `match(input_row, output_row, gt_row)` pairing) in the background; returns 202 with job_id."""
    job_id = str(uuid.uuid4())
    with _match_jobs_lock:
        _match_jobs[job_id] = {"status": "running", "completed": 0, "total": 0, "results": []}
        _touch_match_activity(job_id)
    _persist_match_jobs()
    thread = threading.Thread(target=_do_match_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/score/match/run/result/{job_id}")
def get_match_run_result(job_id: str):
    """Return 202 while running (with partial results), 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _match_jobs_lock:
        job = _match_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Match job not found")
        if job.get("status") == "running":
            _touch_match_activity(job_id)
        status = job.get("status")
        completed = job.get("completed", 0)
        total = job.get("total", 0)
        results = (job.get("results") or [])[:]
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(
            status_code=202,
            content={"status": "running", "completed": completed, "total": total, "results": results},
        )
    if error:
        return {"status": "done", "error": error, "results": []}
    return {"status": status, "completed": completed, "total": total, "results": results}


@app.post("/api/score/match/run/cancel/{job_id}")
def cancel_match_run(job_id: str):
    """Mark a Match-by-code run as cancelled; worker stops after the current row."""
    with _match_jobs_lock:
        if job_id not in _match_jobs:
            raise HTTPException(status_code=404, detail="Match job not found")
        if _match_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _match_jobs[job_id].get("status")}
        _match_cancelled.add(job_id)
        _touch_match_activity(job_id)
    return {"ok": True, "status": "cancelling"}


# ---------- Process (runs a user Python process(df) function once on the whole dataset, delegates
#             to process_df_exec.py; it may return one DataFrame or named DataFrame branches) ----------
_process_df_jobs: dict[str, dict] = {}
_process_df_jobs_lock = threading.Lock()
_process_df_cancelled: set[str] = set()
_process_df_last_activity: dict[str, float] = {}
_process_df_procs: dict[str, subprocess.Popen] = {}


class ProcessDfRunRequest(BaseModel):
    python_path: str = Field(..., min_length=1, description="Path to a Python interpreter (system install or a venv)")
    code: str = Field(..., min_length=1, description="User code defining process(df) -> DataFrame | dict[str, DataFrame]")
    headers: list[str] = Field(default_factory=list, description="Legacy primary Dataset column names")
    rows: list[list[Any]] = Field(default_factory=list, description="Legacy primary Dataset rows")
    input_datasets: dict[str, dict[str, Any]] = Field(default_factory=dict, description="Python alias -> {headers, rows}; each is exposed independently to Process code")
    primary_dataset_id: str = Field(default="", description="Alias supplied as df")
    project_session_id: str | None = Field(default=None, description="Required when any row has an image/PDF cell -- see asset_store.py")


def _touch_process_df_activity(job_id: str) -> None:
    _process_df_last_activity[job_id] = time.time()


def _persist_process_df_jobs() -> None:
    with _process_df_jobs_lock:
        snapshot = dict(_process_df_jobs)
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        PROCESS_DF_JOBS_FILE.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    except (OSError, TypeError) as e:
        _safe_print(f"[ProcessDf] persist failed: {e}", file=sys.stderr)


def _load_process_df_jobs() -> None:
    if not PROCESS_DF_JOBS_FILE.exists():
        return
    try:
        raw = PROCESS_DF_JOBS_FILE.read_text(encoding="utf-8")
        jobs = json.loads(raw) or {}
        with _process_df_jobs_lock:
            _process_df_jobs.clear()
            _process_df_jobs.update(jobs)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[ProcessDf] load persisted jobs failed: {e}", file=sys.stderr)


_load_process_df_jobs()


def _do_process_df_work(job_id: str, req: ProcessDfRunRequest) -> None:
    from process_df_exec import run_process_df_code
    from asset_store import resolve_cell_for_code

    try:
        _touch_process_df_activity(job_id)
        raw_inputs = req.input_datasets or {req.primary_dataset_id or "input": {"headers": req.headers, "rows": req.rows}}
        resolved_inputs: dict[str, dict[str, Any]] = {}
        for dataset_id, content in raw_inputs.items():
            if not isinstance(content, dict):
                continue
            headers = [str(header) for header in (content.get("headers") or [])]
            rows = content.get("rows") or []
            if not isinstance(rows, list):
                rows = []
            resolved_inputs[str(dataset_id)] = {
                "headers": headers,
                "rows": resolve_cell_for_code(rows, req.project_session_id),
            }
        if not resolved_inputs:
            raise ValueError("Connect at least one Dataset before running a Process.")
        primary_dataset_id = req.primary_dataset_id if req.primary_dataset_id in resolved_inputs else next(iter(resolved_inputs))

        def register_proc(proc: subprocess.Popen) -> None:
            _process_df_procs[job_id] = proc

        outcome = run_process_df_code(
            req.python_path,
            req.code,
            req.headers,
            req.rows,
            input_datasets=resolved_inputs,
            primary_dataset_id=primary_dataset_id,
            register_proc=register_proc,
        )

        with _process_df_jobs_lock:
            was_cancelled = job_id in _process_df_cancelled
            if was_cancelled:
                _process_df_jobs[job_id] = {"status": "cancelled"}
            elif outcome.get("ok"):
                _process_df_jobs[job_id] = {"status": "done", "outputs": outcome.get("outputs") or {}}
            else:
                _process_df_jobs[job_id] = {"status": "done", "error": outcome.get("error") or "Unknown error"}
        _persist_process_df_jobs()
    except Exception as e:
        with _process_df_jobs_lock:
            _process_df_jobs[job_id] = {"status": "done", "error": str(e)}
        _persist_process_df_jobs()
    finally:
        _process_df_procs.pop(job_id, None)


@app.post("/api/process/df/run")
def start_process_df_run(body: ProcessDfRunRequest):
    """Start a Process run (Python `process(df)`) in the background; it may return named branches."""
    job_id = str(uuid.uuid4())
    with _process_df_jobs_lock:
        _process_df_jobs[job_id] = {"status": "running"}
    _persist_process_df_jobs()
    thread = threading.Thread(target=_do_process_df_work, args=(job_id, body), daemon=True)
    thread.start()
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=202, content={"job_id": job_id})


@app.get("/api/process/df/run/result/{job_id}")
def get_process_df_run_result(job_id: str):
    """Return 202 while running, 200 when done/cancelled. Polling refreshes the abandonment timer."""
    with _process_df_jobs_lock:
        job = _process_df_jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Process-df job not found")
        if job.get("status") == "running":
            _touch_process_df_activity(job_id)
        status = job.get("status")
        outputs = job.get("outputs")
        # Jobs saved by older backend versions used one unlabelled rows list. Keep it readable
        # while the browser migrates the Process result into the named-output form.
        rows = job.get("rows") or []
        error = job.get("error")
    if status == "running":
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=202, content={"status": "running"})
    if error:
        return {"status": "done", "error": error, "outputs": {}}
    if isinstance(outputs, dict):
        return {"status": status, "outputs": outputs}
    return {"status": status, "outputs": {"result": rows}}


@app.post("/api/process/df/run/cancel/{job_id}")
def cancel_process_df_run(job_id: str):
    """Cancel a running Process-as-df job by killing its subprocess (there's no per-row loop to flag between iterations)."""
    with _process_df_jobs_lock:
        if job_id not in _process_df_jobs:
            raise HTTPException(status_code=404, detail="Process-df job not found")
        if _process_df_jobs[job_id].get("status") != "running":
            return {"ok": True, "status": _process_df_jobs[job_id].get("status")}
        _process_df_cancelled.add(job_id)
        _touch_process_df_activity(job_id)
    proc = _process_df_procs.get(job_id)
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass
    return {"ok": True, "status": "cancelling"}


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

        from review_methods import get_review_method

        st = _load_settings()
        review_method = get_review_method(_resolve_review_method_id(body.review_method, st))

        provider = _credential_provider(cred)
        model = _credential_model(cred) or ""
        base_url = _credential_base_url(cred)
        max_tokens = int(st.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"])
        try:
            max_failed = int(st.get("review_max_failed_rows") or DEFAULT_SETTINGS["review_max_failed_rows"])
        except (TypeError, ValueError):
            max_failed = DEFAULT_SETTINGS["review_max_failed_rows"]
        max_failed = max(1, min(200, max_failed))

        review_method.run(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            body=body,
            max_tokens=max_tokens,
            max_failed_inputs=max_failed,
            is_cancelled=lambda: _review_is_cancelled(review_id),
            append_event=append_event,
            settings=st,
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


# ---------- Optimization: Compositional segments + candidates ----------

class OptimizationSegmentsRequest(BaseModel):
    credential_id: str = Field(..., description="Credential id (LLM used for generation)")
    old_sentence: str = Field(default="", description="Original sentence (context)")
    new_sentence: str = Field(..., description="Improved sentence to split into segments")
    improvement_rationale: str = Field(default="", description="Why this change was proposed")
    max_segments: int = Field(default=5, ge=1, le=8, description="Max number of segments (1–8)")


class OptimizationCandidatesRequest(BaseModel):
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


@app.post("/api/review/optimization-compositional/segments")
def optimization_segments(body: OptimizationSegmentsRequest):
    """Split an improved sentence into contiguous segments for compositional optimization."""
    from review_optimization_compositional import compositional_optimization_segments
    items = _load_credentials()
    cred = next((c for c in items if c.get("id") == body.credential_id), None)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = _credential_provider(cred)
    base_url = _credential_base_url(cred)
    settings = _load_settings()
    max_tokens = settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    _safe_print(_HL + "[Optimization] POST /segments" + _R + f"  model={model}  new_sentence={body.new_sentence[:80]!r}")
    try:
        segments = compositional_optimization_segments(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            max_tokens=max_tokens,
            old_sentence=body.old_sentence,
            new_sentence=body.new_sentence,
            improvement_rationale=body.improvement_rationale,
            max_segments=body.max_segments,
        )
    except Exception as e:
        _safe_print(_HL + "[Optimization] /segments ERROR" + _R + f"  {e}")
        raise HTTPException(status_code=400, detail=str(e))
    _safe_print(_HL + "[Optimization] /segments OK" + _R + f"  → {len(segments)} segment(s): {segments}")
    return {"segments": segments}


@app.post("/api/review/optimization-compositional/candidates")
def optimization_candidates(body: OptimizationCandidatesRequest):
    """Generate paraphrase candidates for one segment of the improved sentence."""
    from review_optimization_compositional import compositional_optimization_segment_candidates
    items = _load_credentials()
    cred = next((c for c in items if c.get("id") == body.credential_id), None)
    if not cred:
        raise HTTPException(status_code=404, detail="Credential not found")
    model = _credential_model(cred)
    api_key = cred.get("api_key", "")
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing API key")
    provider = _credential_provider(cred)
    base_url = _credential_base_url(cred)
    settings = _load_settings()
    max_tokens = settings.get("review_max_tokens") or DEFAULT_SETTINGS["review_max_tokens"]
    _safe_print(_HL + "[Optimization] POST /candidates" + _R + f"  model={model}  segment={body.segment_text[:60]!r}")
    try:
        candidates = compositional_optimization_segment_candidates(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
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
        _safe_print(_HL + "[Optimization] /candidates ERROR" + _R + f"  {e}")
        raise HTTPException(status_code=400, detail=str(e))
    _safe_print(_HL + "[Optimization] /candidates OK" + _R + f"  → {len(candidates)} candidate(s): {candidates}")
    return {"candidates": candidates}


class OptimizationLogResultRequest(BaseModel):
    segments: list[str] = Field(default_factory=list, description="Segment texts")
    lattice: list[list[str]] = Field(default_factory=list, description="lattice[seg][cand]")
    best_picks: list[int] = Field(default_factory=list, description="Winning candidate index per segment")
    best_text: str = Field(default="", description="Composed best sentence")
    best_rate: float = Field(default=0.0, description="Best observed pass rate (0–1)")
    trials_run: int = Field(default=0, description="Number of Thompson-sampling trials actually run")
    trials_total: int = Field(default=0, description="Max trials configured")


@app.post("/api/review/optimization-compositional/log-result")
def optimization_log_result(body: OptimizationLogResultRequest):
    """Log the final optimization result to the terminal for visibility. No persistence."""
    rate_pct = f"{body.best_rate * 100:.1f}%"
    _safe_print("")
    _safe_print(_HL + "[Optimization] ═══════════════ RESULT ════════════════════════════" + _R)
    _safe_print(_HL + f"[Optimization]  Trials: {body.trials_run} / {body.trials_total}   Best pass rate: {rate_pct}" + _R)
    if body.segments and body.lattice and body.best_picks:
        _safe_print(_HL + "[Optimization] ── Winner per segment ─────────────────────────────" + _R)
        for i, (seg, cands, pick) in enumerate(zip(body.segments, body.lattice, body.best_picks)):
            chosen = cands[pick] if 0 <= pick < len(cands) else "?"
            orig_marker = "  ← original" if chosen == seg else ""
            _safe_print(f"[Optimization]   [{i}] cand[{pick}]{orig_marker}")
            _safe_print(f"[Optimization]        {chosen!r}")
    _safe_print(_HL + "[Optimization] ── Best sentence ───────────────────────────────────" + _R)
    _safe_print(f"[Optimization]   {body.best_text!r}")
    _safe_print(_HL + "[Optimization] ═════════════════════════════════════════════════════" + _R)
    _safe_print("")
    return {"ok": True}
