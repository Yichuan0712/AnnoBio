"""Hub: login + per-user reverse proxy to backend/Dockerfile containers (see containers.py,
proxy.py), and serves the one shared web frontend build (app/dist/) at the root for every user
— only /api/* differs per user, so there's nothing per-user to bake into that bundle.

Auth is deliberately minimal for an invite-only, admin-managed user base (see manage_users.py):
email + password, no self-serve signup, no password reset, no OAuth. That's a scope choice, not
an oversight — see the plan's Phase 3+ note for what a public self-serve version would add.
"""
import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, Form, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

import containers
import db
from proxy import proxy_request

db.init_db()

REAP_INTERVAL_SEC = int(os.environ.get("PROMPT_STUDIO_REAP_INTERVAL_SEC", "300"))

app = FastAPI()


async def _reap_idle_loop():
    while True:
        await asyncio.sleep(REAP_INTERVAL_SEC)
        try:
            # containers.reap_idle() calls the (synchronous) docker SDK — off the event loop
            # thread so a slow Docker API call doesn't stall requests being proxied concurrently.
            await asyncio.to_thread(containers.reap_idle)
        except Exception:
            pass


@app.on_event("startup")
async def _start_reaper():
    asyncio.create_task(_reap_idle_loop())

SESSION_SECRET = os.environ.get("PROMPT_STUDIO_SESSION_SECRET")
if not SESSION_SECRET:
    raise RuntimeError(
        "PROMPT_STUDIO_SESSION_SECRET is required (a long random string — e.g. `openssl rand -hex 32`). "
        "It signs session cookies; losing/rotating it logs everyone out."
    )

# Local dev (no Docker): defaults to the Vite build sitting next to this repo checkout.
# In the Hub's own container, docker-compose.yml mounts the built frontend here instead, since
# it's assembled outside the Hub's image (see the compose file's comment).
FRONTEND_DIST = Path(os.environ.get("PROMPT_STUDIO_FRONTEND_DIST") or (Path(__file__).resolve().parent.parent / "app" / "dist"))

LOGIN_PAGE = """<!doctype html>
<html><head><title>Prompt Studio</title></head>
<body style="font-family:system-ui;max-width:360px;margin:80px auto">
<h2>Prompt Studio</h2>
<form method="post" action="/login">
  <p><input name="email" type="email" placeholder="Email" required style="width:100%;padding:8px;box-sizing:border-box"></p>
  <p><input name="password" type="password" placeholder="Password" required style="width:100%;padding:8px;box-sizing:border-box"></p>
  {error}
  <button type="submit" style="width:100%;padding:8px">Log in</button>
</form>
</body></html>"""


def current_user(request: Request) -> dict | None:
    user_id = request.session.get("user_id")
    return db.get_user_by_id(user_id) if user_id else None


@app.get("/login")
def login_page():
    return HTMLResponse(LOGIN_PAGE.format(error=""))


@app.post("/login")
def login_submit(request: Request, email: str = Form(...), password: str = Form(...)):
    user = db.get_user_by_email(email)
    if not user or not db.verify_password(password, user["password_hash"]):
        return HTMLResponse(
            LOGIN_PAGE.format(error='<p style="color:#c00">Invalid email or password.</p>'),
            status_code=401,
        )
    request.session["user_id"] = user["id"]
    return RedirectResponse("/", status_code=302)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/logout"):
        return await call_next(request)
    user = current_user(request)
    if not user:
        if path.startswith("/api/"):
            return Response(status_code=401)
        return RedirectResponse("/login", status_code=302)
    request.state.user = user
    return await call_next(request)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def api_proxy(request: Request, path: str):
    return await proxy_request(request, request.state.user["id"])


# Added last so it wraps outermost and runs before require_login above — middleware added via
# add_middleware() wraps whatever was already registered, and require_login needs
# request.session (which this middleware populates) to already exist by the time it runs.
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, session_cookie="ps_session")


if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
