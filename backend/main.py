from pathlib import Path
import json
import uuid

from fastapi import FastAPI, HTTPException

from llm import chat as llm_chat
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

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
