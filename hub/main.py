"""Hub: public marketing landing page at "/", login/registration, and a per-user reverse proxy
to backend/Dockerfile containers (see containers.py, proxy.py) that serves the one shared web
frontend build (app/dist/) under /app for every user — only /api/* differs per user, so there's
nothing per-user to bake into that bundle.

Auth is deliberately minimal: email + password, self-serve registration (open — no email
verification, no invite requirement), no password reset, no OAuth. manage_users.py still exists
for an admin to create/list accounts by hand, but it's no longer the only way in.
"""
import asyncio
import datetime
import os
from pathlib import Path

import httpx
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

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
SHARED_CSS = (TEMPLATES_DIR / "shared.css").read_text(encoding="utf-8")
LANDING_TEMPLATE = (TEMPLATES_DIR / "landing.html").read_text(encoding="utf-8")
AUTH_TEMPLATE = (TEMPLATES_DIR / "auth.html").read_text(encoding="utf-8")
PAGE_TEMPLATE = (TEMPLATES_DIR / "page.html").read_text(encoding="utf-8")


def current_user(request: Request) -> dict | None:
    user_id = request.session.get("user_id")
    return db.get_user_by_id(user_id) if user_id else None


NAV_LINKS = [
    ("/", "Home"),
    ("/app", "Workspace"),
    ("/download", "Download"),
    ("/guide", "User Guide"),
]


def render_nav(user: dict | None, active: str = "") -> str:
    """Shared top nav for every Hub page (landing, auth, and the Download/Guide/Profile pages) —
    same brand, same links, same auth-state-dependent actions everywhere, so the site reads as one
    product instead of a pile of separately-styled pages."""
    links_html = "".join(
        f'<a class="nav-link{" nav-link--active" if href == active else ""}" href="{href}">{label}</a>'
        for href, label in NAV_LINKS
    )
    if user:
        initials = user["email"][:2].upper()
        actions_html = f'<a class="nav-avatar" href="/profile" title="{user["email"]}" aria-label="Profile: {user["email"]}">{initials}</a>'
    else:
        actions_html = (
            '<a class="btn btn-ghost" href="/login">Log in</a>'
            '<a class="btn btn-primary" href="/register">Sign up</a>'
        )
    return (
        '<nav class="top">'
        '<a class="brand" href="/">Prompt Studio</a>'
        f'<div class="nav-links">{links_html}</div>'
        f'<div class="nav-actions">{actions_html}</div>'
        '</nav>'
    )


def render_page(*, title: str, user: dict | None, active: str = "", body: str, extra_css: str = "") -> str:
    """Shared shell for Download/Guide/Profile — nav + a plain content well, styled with the same
    tokens as landing/auth. See templates/page.html."""
    return (
        PAGE_TEMPLATE
        .replace("{{SHARED_CSS}}", SHARED_CSS)
        .replace("{{EXTRA_CSS}}", extra_css)
        .replace("{{TITLE}}", title)
        .replace("{{NAV}}", render_nav(user, active=active))
        .replace("{{BODY}}", body)
    )


def render_auth_page(
    *, heading: str, form_action: str, password_placeholder: str = "Password",
    password_minlength: str = "", error: str = "", submit_label: str, footer_link: str,
    user: dict | None = None,
) -> str:
    """Shared shell for /login and /register — same card, same tokens as the landing page, just
    a different heading/fields/footer link so the two don't visually read as separate products."""
    error_html = f'<div class="error">{error}</div>' if error else ""
    return (
        AUTH_TEMPLATE
        .replace("{{SHARED_CSS}}", SHARED_CSS)
        .replace("{{NAV}}", render_nav(user))
        .replace("{{HEADING}}", heading)
        .replace("{{FORM_ACTION}}", form_action)
        .replace("{{PASSWORD_PLACEHOLDER}}", password_placeholder)
        .replace("{{PASSWORD_MINLENGTH}}", password_minlength)
        .replace("{{ERROR}}", error_html)
        .replace("{{SUBMIT_LABEL}}", submit_label)
        .replace("{{FOOTER_LINK}}", footer_link)
    )


@app.get("/")
def landing_page(request: Request):
    """Public marketing page — the app itself lives at /app, behind login (see require_login)."""
    user = current_user(request)
    primary_href, primary_label = ("/app", "Open Online Workspace") if user else ("/register", "Sign up free")
    html = (
        LANDING_TEMPLATE
        .replace("{{SHARED_CSS}}", SHARED_CSS)
        .replace("{{NAV}}", render_nav(user, active="/"))
        .replace("{{PRIMARY_CTA_HREF}}", primary_href)
        .replace("{{PRIMARY_CTA_LABEL}}", primary_label)
    )
    return HTMLResponse(html)


def _login_page_html(error: str = "") -> str:
    return render_auth_page(
        heading="Log in",
        form_action="/login",
        error=error,
        submit_label="Log in",
        footer_link='Need an account? <a class="link" href="/register">Register</a>',
    )


def _register_page_html(error: str = "") -> str:
    return render_auth_page(
        heading="Create an account",
        form_action="/register",
        password_placeholder="Password (min 8 characters)",
        password_minlength='minlength="8"',
        error=error,
        submit_label="Create account",
        footer_link='Already have an account? <a class="link" href="/login">Log in</a>',
    )


@app.get("/login")
def login_page():
    return HTMLResponse(_login_page_html())


@app.post("/login")
def login_submit(request: Request, email: str = Form(...), password: str = Form(...)):
    user = db.get_user_by_email(email)
    if not user or not db.verify_password(password, user["password_hash"]):
        return HTMLResponse(_login_page_html(error="Invalid email or password."), status_code=401)
    request.session["user_id"] = user["id"]
    return RedirectResponse("/app", status_code=302)


@app.get("/register")
def register_page():
    return HTMLResponse(_register_page_html())


@app.post("/register")
def register_submit(request: Request, email: str = Form(...), password: str = Form(...)):
    if len(password) < 8:
        return HTMLResponse(_register_page_html(error="Password must be at least 8 characters."), status_code=400)
    if db.get_user_by_email(email):
        return HTMLResponse(_register_page_html(error="An account with this email already exists."), status_code=400)
    user_id = db.create_user(email, password)
    request.session["user_id"] = user_id
    return RedirectResponse("/app", status_code=302)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


@app.get("/whoami")
def whoami(request: Request):
    """Lets the frontend show who's logged in (account avatar in the top bar) without teaching
    it anything about sessions — require_login below already gated this request and attached
    the user."""
    return {"email": request.state.user["email"]}


@app.get("/download")
def download_page(request: Request):
    """Public — no installers published yet (see the plan's Phase 1 scope), but the page itself
    is real so the landing page's "Download for desktop" link goes somewhere."""
    user = current_user(request)
    body = """
      <h1>Download Prompt Studio</h1>
      <p class="page-sub">The full Electron app: native file access, local project storage, works entirely offline.</p>
      <div class="download-grid">
        <div class="download-card">
          <h3>Windows</h3>
          <p>.exe installer</p>
          <button class="btn btn-secondary" disabled>Coming soon</button>
        </div>
        <div class="download-card">
          <h3>macOS</h3>
          <p>.dmg installer</p>
          <button class="btn btn-secondary" disabled>Coming soon</button>
        </div>
      </div>
      <p class="download-note">
        Desktop builds aren't published yet. In the meantime, <a class="link" href="/register">use Prompt Studio in your browser</a> —
        same projects, same file format, and you can move a project to desktop later once builds are available.
      </p>
    """
    extra_css = """
      .download-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
      .download-card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 22px; text-align: center; }
      .download-card h3 { margin: 0 0 4px; font-size: 17px; }
      .download-card p { margin: 0 0 16px; color: var(--text-muted); font-size: 13.5px; }
      .download-note { color: var(--text-muted); font-size: 14px; line-height: 1.6; }
      a.link { color: var(--accent); text-decoration: none; }
      a.link:hover { text-decoration: underline; }
    """
    return HTMLResponse(render_page(title="Download", user=user, active="/download", body=body, extra_css=extra_css))


GUIDE_SECTIONS = [
    (
        "Create a project",
        "Click the project name in the top bar to open the project picker. Create a new project or "
        "pick an existing one — a project holds your prompts, datasets, runs, and review results together.",
    ),
    (
        "Add a prompt",
        "Use the document icon in the top bar to create a new prompt. A prompt is a reusable template: "
        "write it once, then run it against many rows of a dataset.",
    ),
    (
        "Add a dataset",
        "Use the database icon in the top bar to create a new dataset, or import one directly from ChEMBL, "
        "PubMed, ClinicalTrials.gov, or a preprint server via the Agent Assistant.",
    ),
    (
        "Connect and run",
        "Drag a connection from a prompt node to a dataset node, then to a Run node, to execute the prompt "
        "against every row. Results land in a results table you can inspect row by row.",
    ),
    (
        "Review and optimize",
        "Attach a Score/Review node to a run to grade its outputs against your own criteria, then let an "
        "automatic method — GEPA, MIPROv2, TextGrad, COPRO, SIMBA, or BootstrapFewShot — rewrite the prompt "
        "to improve that score.",
    ),
    (
        "Add your model",
        "Open LLM settings (the chip icon) and add a credential for OpenAI, Anthropic, Gemini, DeepSeek, "
        "Bedrock, OpenRouter, or any LiteLLM-compatible endpoint. Set defaults for Run, Review, and the "
        "Agent Assistant independently.",
    ),
    (
        "Ask the Agent Assistant",
        "The Agent Assistant (the sparkle button on the canvas) can add nodes, start runs, and apply review "
        "suggestions on your behalf — describe what you want in plain language.",
    ),
]


@app.get("/guide")
def guide_page(request: Request):
    user = current_user(request)
    toc_html = "".join(f'<a class="guide-toc-link" href="#{i}">{title}</a>' for i, (title, _) in enumerate(GUIDE_SECTIONS))
    sections_html = "".join(
        f'<section class="guide-section" id="{i}"><h2>{i + 1}. {title}</h2><p>{body}</p></section>'
        for i, (title, body) in enumerate(GUIDE_SECTIONS)
    )
    body = f"""
      <h1>User Guide</h1>
      <p class="page-sub">A short walkthrough of the core workflow — canvas, prompts, datasets, runs, and review.</p>
      <nav class="guide-toc">{toc_html}</nav>
      {sections_html}
    """
    extra_css = """
      .guide-toc { display: flex; flex-wrap: wrap; gap: 6px 4px; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
      .guide-toc-link { padding: 6px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; color: var(--accent); background: var(--bg-panel); }
      .guide-toc-link:hover { background: rgba(37, 99, 235, 0.12); }
      .guide-section { margin-bottom: 28px; }
      .guide-section h2 { font-size: 17px; margin: 0 0 8px; }
      .guide-section p { color: var(--text-muted); font-size: 14.5px; line-height: 1.65; margin: 0; max-width: 720px; }
    """
    return HTMLResponse(render_page(title="User Guide", user=user, active="/guide", body=body, extra_css=extra_css))


async def _fetch_user_projects(user_id: int) -> list[dict]:
    """Lists a user's workspaces for the Profile page — reaches into their own backend container
    directly (see containers.py), the same way proxy.py does for a browser's /api/* request, just
    without needing an inbound Request to forward since this is a plain GET with no body/headers
    of its own."""
    try:
        name = containers.ensure_running(user_id)
    except containers.BackendUnavailable:
        return []
    db.touch_container(user_id)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"http://{name}:{containers.BACKEND_PORT}/api/projects")
        if resp.status_code == 200:
            return resp.json()
    except httpx.HTTPError:
        pass
    return []


@app.get("/profile")
async def profile_page(request: Request):
    user = request.state.user
    joined = datetime.datetime.fromtimestamp(user["created_at"]).strftime("%B %-d, %Y") if user.get("created_at") else "—"
    projects = await _fetch_user_projects(user["id"])
    projects.sort(key=lambda p: p.get("updatedAt") or 0, reverse=True)

    if not projects:
        workspaces_html = '<p class="workspaces-empty">No workspaces yet — <a class="link" href="/app">create one</a>.</p>'
    else:
        rows = "".join(
            f"""
            <a class="workspace-row" href="/app/?open={p['id']}">
              <span class="workspace-name">{p.get('name') or 'Untitled Project'}</span>
              <span class="workspace-date">{datetime.datetime.fromtimestamp(p['updatedAt']).strftime('%b %-d, %Y')}</span>
            </a>
            """
            for p in projects
        )
        workspaces_html = f'<div class="workspace-list">{rows}</div>'

    body = f"""
      <h1>Profile</h1>
      <p class="page-sub">Your Prompt Studio account.</p>
      <div class="profile-col">
        <div class="profile-card">
          <div class="profile-row"><span class="profile-label">Email</span><span>{user["email"]}</span></div>
          <div class="profile-row"><span class="profile-label">Member since</span><span>{joined}</span></div>
        </div>
        <form method="post" action="/logout">
          <button type="submit" class="btn btn-secondary">Log out</button>
        </form>

        <h2 class="workspaces-heading">Your workspaces</h2>
        {workspaces_html}
      </div>
    """
    extra_css = """
      .profile-col { max-width: 480px; }
      .profile-card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 20px; margin-bottom: 22px; }
      .profile-row { display: flex; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
      .profile-row:last-child { border-bottom: none; }
      .profile-label { color: var(--text-muted); }
      .workspaces-heading { font-size: 18px; margin: 40px 0 14px; }
      .workspaces-empty { color: var(--text-muted); font-size: 14px; }
      a.link { color: var(--accent); text-decoration: none; }
      a.link:hover { text-decoration: underline; }
      .workspace-list { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .workspace-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 13px 18px; text-decoration: none; color: var(--text);
        background: var(--bg-panel); border-bottom: 1px solid var(--border); font-size: 14px;
      }
      .workspace-row:last-child { border-bottom: none; }
      .workspace-row:hover { background: rgba(37, 99, 235, 0.06); }
      .workspace-name { font-weight: 600; }
      .workspace-date { color: var(--text-muted); font-size: 12.5px; }
    """
    return HTMLResponse(render_page(title="Profile", user=user, active="/profile", body=body, extra_css=extra_css))


@app.middleware("http")
async def no_cache_for_pages(request: Request, call_next):
    """Every page here (the Hub's own routes, and the SPA's index.html served under /app) can
    change on a redeploy, and none of them are told apart by a versioned URL — so without this, a
    browser that heuristically cached index.html (it has no Cache-Control of its own from
    StaticFiles) or a Hub-rendered page keeps showing stale nav/copy after a rebuild, with no
    obvious way for someone testing the site to tell that's what happened. Vite's hashed build
    assets (/app/assets/*.js, *.css) are the one exception — their filename already changes
    whenever their content does, so those are left cacheable."""
    response = await call_next(request)
    if not request.url.path.startswith("/app/assets/"):
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path in ("/", "/login", "/logout", "/register", "/download", "/guide"):
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
    app.mount("/app", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
