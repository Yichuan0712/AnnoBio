from pathlib import Path
import json
import uuid

from fastapi import FastAPI, HTTPException
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


class CredentialCreate(BaseModel):
    llm: str = Field(..., description="LLM 类型: openai, anthropic, other")
    api_key: str = Field(..., min_length=1, description="API key")


class CredentialResponse(BaseModel):
    id: str
    llm: str
    api_key_masked: str


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
            llm=item["llm"],
            api_key_masked=_mask_key(item["api_key"]),
        )
        for item in items
    ]


@app.post("/api/credentials", response_model=CredentialResponse)
def add_credential(body: CredentialCreate):
    """添加一条凭证。"""
    allowed_llm = {"openai", "anthropic", "other"}
    if body.llm not in allowed_llm:
        raise HTTPException(status_code=400, detail=f"llm 必须是 {allowed_llm} 之一")
    items = _load_credentials()
    new_id = str(uuid.uuid4())
    new_item = {
        "id": new_id,
        "llm": body.llm,
        "api_key": body.api_key,
    }
    items.append(new_item)
    _save_credentials(items)
    return CredentialResponse(
        id=new_id,
        llm=new_item["llm"],
        api_key_masked=_mask_key(new_item["api_key"]),
    )


@app.delete("/api/credentials/{credential_id}")
def delete_credential(credential_id: str):
    """根据 id 删除一条凭证。"""
    items = _load_credentials()
    new_items = [x for x in items if x.get("id") != credential_id]
    if len(new_items) == len(items):
        raise HTTPException(status_code=404, detail="凭证不存在")
    _save_credentials(new_items)
    return {"ok": True}
