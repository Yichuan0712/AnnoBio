"""Reverse proxy: an authenticated request for /api/* is forwarded to the requesting user's own
backend container (see containers.py) — the Hub has no run/review/credential logic of its own.
"""
import asyncio
from urllib.parse import quote

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

import containers
import db


async def proxy_request(request: Request, user: dict) -> Response:
    user_id = int(user["id"])
    try:
        # Docker inspection/startup and readiness polling are blocking. Keep them off
        # the event loop so opening a workspace cannot stall other users' token streams.
        name = await asyncio.to_thread(containers.ensure_running, user_id)
    except containers.CapacityExceeded as e:
        # A distinct, JSON body (rather than BackendUnavailable's plain text below) so the web
        # app can recognize this specific case and point the user at /download instead of just
        # showing a generic "couldn't load" error — see webProjectModal.js's throwApiError.
        return JSONResponse({"error": "capacity_exceeded", "detail": str(e)}, status_code=503)
    except containers.BackendUnavailable as e:
        return Response(content=str(e), status_code=503)
    await asyncio.to_thread(db.touch_container, user_id)

    target_url = f"http://{name}:{containers.BACKEND_PORT}{request.url.path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    body = await request.body()
    # Attribution is derived from the authenticated Hub session. Drop any browser-supplied value
    # before adding our own ASCII-safe header so a client cannot impersonate another author.
    excluded_request_headers = {"host", "content-length", "cookie", "x-annobio-user-name"}
    forwarded_headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in excluded_request_headers
    }
    author_name = str(user.get("name") or "").strip()
    if author_name:
        forwarded_headers["X-AnnoBio-User-Name"] = quote(author_name[:200], safe="")
    client = httpx.AsyncClient(timeout=300.0)
    try:
        upstream = await client.send(
            client.build_request(request.method, target_url, headers=forwarded_headers, content=body),
            stream=True,
        )
    except httpx.HTTPError as e:
        await client.aclose()
        return Response(content=f"Your workspace container did not respond: {e}", status_code=502)

    excluded_response_headers = {"content-encoding", "transfer-encoding", "connection", "content-length"}
    headers = {k: v for k, v in upstream.headers.items() if k.lower() not in excluded_response_headers}

    async def close_upstream():
        await upstream.aclose()
        await client.aclose()

    # Relay Agent tokens and entity-matching progress without buffering until completion.
    if upstream.headers.get("content-type", "").startswith(("text/event-stream", "application/x-ndjson")):
        return StreamingResponse(
            upstream.aiter_bytes(),
            status_code=upstream.status_code,
            headers=headers,
            background=BackgroundTask(close_upstream),
        )
    try:
        content = await upstream.aread()
    finally:
        await close_upstream()
    return Response(content=content, status_code=upstream.status_code, headers=headers)
