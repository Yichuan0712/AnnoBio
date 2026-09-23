"""Reverse proxy: an authenticated request for /api/* is forwarded to the requesting user's own
backend container (see containers.py) — the Hub has no run/review/credential logic of its own.
"""
from urllib.parse import quote

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse

import containers
import db


async def proxy_request(request: Request, user: dict) -> Response:
    user_id = int(user["id"])
    try:
        name = containers.ensure_running(user_id)
    except containers.CapacityExceeded as e:
        # A distinct, JSON body (rather than BackendUnavailable's plain text below) so the web
        # app can recognize this specific case and point the user at /download instead of just
        # showing a generic "couldn't load" error — see webProjectModal.js's throwApiError.
        return JSONResponse({"error": "capacity_exceeded", "detail": str(e)}, status_code=503)
    except containers.BackendUnavailable as e:
        return Response(content=str(e), status_code=503)
    db.touch_container(user_id)

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
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            upstream = await client.request(
                request.method,
                target_url,
                headers=forwarded_headers,
                content=body,
            )
    except httpx.HTTPError as e:
        return Response(content=f"Your workspace container did not respond: {e}", status_code=502)

    excluded_response_headers = {"content-encoding", "transfer-encoding", "connection"}
    headers = {k: v for k, v in upstream.headers.items() if k.lower() not in excluded_response_headers}
    return Response(content=upstream.content, status_code=upstream.status_code, headers=headers)
