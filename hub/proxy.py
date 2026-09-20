"""Reverse proxy: an authenticated request for /api/* is forwarded to the requesting user's own
backend container (see containers.py) — the Hub has no run/review/credential logic of its own.
"""
import httpx
from fastapi import Request, Response

import containers
import db


async def proxy_request(request: Request, user_id: int) -> Response:
    try:
        name = containers.ensure_running(user_id)
    except containers.BackendUnavailable as e:
        return Response(content=str(e), status_code=503)
    db.touch_container(user_id)

    target_url = f"http://{name}:{containers.BACKEND_PORT}{request.url.path}"
    if request.url.query:
        target_url += f"?{request.url.query}"

    body = await request.body()
    excluded_request_headers = {"host", "content-length", "cookie"}
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            upstream = await client.request(
                request.method,
                target_url,
                headers={k: v for k, v in request.headers.items() if k.lower() not in excluded_request_headers},
                content=body,
            )
    except httpx.HTTPError as e:
        return Response(content=f"Your workspace container did not respond: {e}", status_code=502)

    excluded_response_headers = {"content-encoding", "transfer-encoding", "connection"}
    headers = {k: v for k, v in upstream.headers.items() if k.lower() not in excluded_response_headers}
    return Response(content=upstream.content, status_code=upstream.status_code, headers=headers)
