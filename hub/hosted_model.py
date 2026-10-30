"""Account-scoped, metered OpenAI-compatible gateway for the web's managed model.

Only the Hub holds the provider key. Workspace containers receive an account-scoped
gateway token, so user-authored Process code cannot retrieve the platform API key.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import time
from datetime import datetime, timedelta, timezone
import uuid
from contextlib import contextmanager
from functools import lru_cache
import math

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from tokenizers import Tokenizer
try:
    from .hosted_model_config import credential_for_role
    from .model_providers import open_completion
except ImportError:  # Uvicorn runs main:app from the hub/ working directory.
    from hosted_model_config import credential_for_role
    from model_providers import open_completion

router = APIRouter(prefix="/internal/hosted-model")
DISPLAY_MODEL = "annobio-free"
ROLES = {"generate", "optimize", "agent"}
QUOTA_MESSAGE = "Your daily free token allowance has been reached. Connect your OpenRouter account in LLM settings to continue, or wait for the daily reset."
DB_PATH = Path(__file__).resolve().parent / "data" / "hosted_usage.db"


def account_token(user_id: int) -> str:
    secret = os.environ.get("PROMPT_STUDIO_SESSION_SECRET", "")
    if not secret:
        raise RuntimeError("The hosted model requires the Hub session secret.")
    signature = hmac.new(secret.encode(), f"hosted-model-v1:{int(user_id)}".encode(), hashlib.sha256).hexdigest()
    return f"{int(user_id)}.{signature}"


def account_from_token(value: str) -> int:
    try:
        user_id = int(value.split(".", 1)[0])
        if user_id > 0 and hmac.compare_digest(account_token(user_id), value):
            return user_id
    except (ValueError, TypeError):
        pass
    raise HTTPException(status_code=401, detail="Invalid hosted-model credentials.")


def authenticated_account(request: Request) -> int:
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Hosted-model credentials are required.")
    user_id = account_from_token(authorization[7:])
    import db
    if not db.get_user_by_id(user_id):
        raise HTTPException(status_code=401, detail="Account unavailable.")
    return user_id


def daily_limit() -> int:
    return max(0, int(os.environ.get("ANNOBIO_HOSTED_DAILY_TOKENS", "50000")))


def day_key(now=None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%d")


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, estimated INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL)")
        connection.execute("CREATE INDEX IF NOT EXISTS calls_account_day ON calls(user_id, day)")
        with connection:
            yield connection
    finally:
        connection.close()


def totals(connection, user_id: int, day: str):
    row = connection.execute("SELECT COALESCE(SUM(charged),0), COALESCE(SUM(CASE WHEN state='reserved' THEN reserved ELSE 0 END),0), COALESCE(SUM(CASE WHEN estimated=1 THEN charged ELSE 0 END),0) FROM calls WHERE user_id=? AND day=?", (user_id, day)).fetchone()
    return tuple(int(item) for item in row)


def usage(user_id: int) -> dict:
    now = datetime.now(timezone.utc)
    with connect() as connection:
        used, held, estimated = totals(connection, user_id, day_key(now))
    reset = datetime.combine((now + timedelta(days=1)).date(), datetime.min.time(), tzinfo=timezone.utc)
    limit = daily_limit()
    return {"enabled": True, "credential_id": "annobio-free", "name": "AnnoBio AI", "limit": limit, "used": used,
            "reserved": held, "estimated": estimated, "remaining": max(0, limit - used - held),
            "resets_at": reset.isoformat(), "available": configured(), "timezone": "UTC"}


def configured() -> bool:
    try:
        return all(credential_for_role(role)["api_key"] for role in ROLES)
    except (ValueError, KeyError):
        return False


class QuotaExceeded(Exception):
    pass


def reserve(user_id: int, input_bound: int, output_limit: int):
    """Reserve before contacting the provider, atomically across concurrent jobs/processes."""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        day = day_key()
        used, held, _ = totals(connection, user_id, day)
        available = daily_limit() - used - held
        output_limit = min(output_limit, available - input_bound)
        if output_limit < 1:
            raise QuotaExceeded(QUOTA_MESSAGE if available <= 0 else "This request needs more free token allowance than remains. Shorten the request or connect OpenRouter in LLM settings to continue.")
        reservation = uuid.uuid4().hex
        connection.execute("INSERT INTO calls(id,user_id,day,reserved,state,created) VALUES(?,?,?,?,?,?)",
                           (reservation, user_id, day, input_bound + output_limit, "reserved", time.time()))
    return reservation, output_limit


def settle(reservation: str, actual_tokens: int | None, *, rejected=False):
    """Missing usage after interruption is charged conservatively, never refunded as zero."""
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM calls WHERE id=?", (reservation,)).fetchone()
        if row is None or row["state"] != "reserved":
            return
        charge = 0 if rejected else max(0, int(actual_tokens)) if actual_tokens is not None else row["reserved"]
        connection.execute("UPDATE calls SET charged=?,state='settled',estimated=? WHERE id=?",
                           (charge, int(actual_tokens is None and not rejected), reservation))


def token_usage(payload) -> int | None:
    values = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(values, dict):
        return None
    prompt, completion, total = values.get("prompt_tokens"), values.get("completion_tokens"), values.get("total_tokens")
    if type(prompt) is int and prompt >= 0 and type(completion) is int and completion >= 0:
        return max(prompt + completion, total if type(total) is int and total >= 0 else 0)
    return total if type(total) is int and total >= 0 else None


def safe_error(message: str, status=400, code="hosted_model_error"):
    return JSONResponse({"error": {"message": message, "type": code, "code": code}}, status_code=status)


@lru_cache(maxsize=4)
def load_tokenizer(path: str):
    return Tokenizer.from_file(path)


def input_reservation(body: dict, tokenizer: str | None = None) -> int:
    """Tokenize the complete prompt/tools, allowing extra space for provider chat framing.

    Byte counts are far too pessimistic: the normal Agent's initial system prompt and tools
    already exceed 50 KB but contain only about 12K tokens. Actual API usage always settles
    the reservation. Unknown model tokenizers fall back to the conservative byte bound.
    """
    serialized = json.dumps(body, ensure_ascii=False)
    model = tokenizer or os.environ.get("ANNOBIO_HOSTED_TOKENIZER_MODEL", "deepseek")
    if model == "bytes":
        return len(serialized.encode("utf-8")) + 1024
    if model == "deepseek":
        path = os.environ.get("ANNOBIO_HOSTED_TOKENIZER_PATH", str(Path(__file__).resolve().parent / "tokenizers" / "deepseek-v4.json"))
        count = len(load_tokenizer(path).encode(serialized, add_special_tokens=False).ids)
    elif model == "cl100k_base":
        import tiktoken
        count = len(tiktoken.get_encoding("cl100k_base").encode(serialized, disallowed_special=()))
    else:
        raise ValueError("Unknown hosted-model tokenizer.")
    return math.ceil(count * 1.25) + 1024


@router.get("/usage")
def get_usage(request: Request):
    return usage(authenticated_account(request))


@router.post("/{role}/v1/chat/completions")
async def completion(role: str, request: Request):
    user_id = authenticated_account(request)
    if role not in ROLES:
        raise HTTPException(status_code=404, detail="Unknown model task.")
    try:
        credential = credential_for_role(role)
    except (ValueError, KeyError):
        return safe_error("The free model is temporarily unavailable. Connect OpenRouter in LLM settings to continue.", 503)
    if not credential["api_key"]:
        return safe_error("The free model is not configured yet. Connect OpenRouter in LLM settings to use your own model.", 503)
    raw = await request.body()
    if len(raw) > 1_000_000:
        return safe_error("This request is too large for the free model.", 413)
    try:
        body = json.loads(raw)
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list) or not body["messages"] or not all(isinstance(message, dict) for message in body["messages"]):
            raise ValueError()
        requested = body.get("max_completion_tokens", body.get("max_tokens", 4096))
        if type(requested) is not int or requested <= 0 or body.get("n", 1) != 1:
            raise ValueError()
    except (ValueError, TypeError):
        return safe_error("Invalid model request.")
    # Visual/audio accounting needs provider-specific token bounds. Until configured, do not
    # let short remote image URLs bypass the text tokenizer and spend an unreserved budget.
    for message in body["messages"]:
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list) and any(not isinstance(block, dict) or block.get("type") != "text" for block in content):
            return safe_error("The free allowance currently covers text prompts. Connect an OpenRouter model to use image, PDF or audio inputs.")
    allowed = {"messages", "tools", "tool_choice", "response_format", "temperature", "top_p", "stop", "seed", "frequency_penalty", "presence_penalty", "parallel_tool_calls", "reasoning_effort"}
    forwarded = {name: value for name, value in body.items() if name in allowed}
    try:
        input_bound = input_reservation(forwarded, credential["tokenizer"])
    except Exception:
        # Missing/corrupt tokenizer must never allow unmetered provider requests.
        return safe_error("The free model is temporarily unavailable. Connect OpenRouter in LLM settings to continue.", 503)
    try:
        reservation, maximum = reserve(user_id, input_bound, min(requested, int(os.environ.get("ANNOBIO_HOSTED_MAX_OUTPUT_TOKENS", "8192"))))
    except QuotaExceeded as error:
        return safe_error(str(error), 429, "free_quota_exhausted")
    forwarded["model"] = credential["model"]
    forwarded["max_tokens"] = maximum
    streaming = body.get("stream") is True
    forwarded["stream"] = streaming
    if streaming:
        forwarded["stream_options"] = {"include_usage": True}
    try:
        upstream, client = await open_completion(credential, forwarded)
    except httpx.ConnectError:
        settle(reservation, None, rejected=True)
        return safe_error("The free model is temporarily unavailable. Please try again later.", 503)
    except httpx.HTTPError:
        settle(reservation, None)
        return safe_error("The free model request was interrupted. Please try again later.", 503)
    if upstream.status_code >= 400:
        try:
            error_text = (await upstream.aread()).decode("utf-8", errors="replace").lower()
        except httpx.HTTPError:
            error_text = ""
        finally:
            settle(reservation, None, rejected=True)
            await upstream.aclose()
            await client.aclose()
        unsupported = next((name for name in ("response_format", "tool_choice", "tools") if name in error_text and any(word in error_text for word in ("unsupported", "not support", "not allowed", "unavailable", "invalid"))), "") if upstream.status_code == 400 else ""
        message = f"{unsupported} is not supported by the free model." if unsupported else "The free model could not complete this request. Try again or connect OpenRouter in LLM settings."
        return safe_error(message, 400 if upstream.status_code < 500 else 503)
    if not streaming:
        try:
            payload = json.loads(await upstream.aread())
            if not isinstance(payload, dict):
                raise ValueError("Invalid completion response")
            settle(reservation, token_usage(payload))
            if "error" in payload:
                return safe_error("The free model could not complete this request. Connect OpenRouter in LLM settings to continue.", 502)
            payload["model"] = DISPLAY_MODEL
            return JSONResponse(payload)
        except (ValueError, httpx.HTTPError):
            settle(reservation, None)
            return safe_error("The free model returned an incomplete response.", 502)
        finally:
            await upstream.aclose()
            await client.aclose()

    async def events():
        actual = None
        try:
            async for line in upstream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                value = line[5:].strip()
                if value == "[DONE]":
                    yield "data: [DONE]\n\n"
                    continue
                try:
                    payload = json.loads(value)
                except ValueError:
                    continue
                if not isinstance(payload, dict):
                    continue
                observed = token_usage(payload)
                if observed is not None:
                    actual = observed
                if "error" in payload:
                    payload = {"error": {"message": "The free model stream was interrupted.", "code": "hosted_model_error"}}
                payload["model"] = DISPLAY_MODEL
                yield "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
        except httpx.HTTPError:
            yield 'data: {"error":{"message":"The free model stream was interrupted.","code":"hosted_model_error"}}\n\n'
        finally:
            settle(reservation, actual)
            await upstream.aclose()
            await client.aclose()
    return StreamingResponse(events(), media_type="text/event-stream")
