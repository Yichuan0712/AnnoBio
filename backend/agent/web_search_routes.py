"""Public-web read tools; authentication on web remains the Hub's responsibility."""
from fastapi import APIRouter
from pydantic import BaseModel, Field
from agent.web_search import read_webpage, search_web

router = APIRouter(prefix="/api/agent")


class WebSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=5, ge=1, le=5)


class WebReadRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    offset: int = Field(default=0, ge=0, le=48000)
    max_chars: int = Field(default=6000, ge=1, le=12000)


@router.post("/web-search")
def web_search(body: WebSearchRequest):
    return search_web(body.query, body.limit)


@router.post("/webpage")
def webpage(body: WebReadRequest):
    return read_webpage(body.url, body.offset, body.max_chars)
