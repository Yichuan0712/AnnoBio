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
import mimetypes
import os
from html import escape
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

import archive
import containers
import db
import mailer
from guide import GUIDE_GROUPS, build_chapters
from proxy import proxy_request
from hosted_model import router as hosted_model_router

mimetypes.add_type("image/webp", ".webp")
db.init_db()

REAP_INTERVAL_SEC = int(os.environ.get("PROMPT_STUDIO_REAP_INTERVAL_SEC", "300"))

app = FastAPI()
app.include_router(hosted_model_router)


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
GUIDE_TEMPLATE = (TEMPLATES_DIR / "guide.html").read_text(encoding="utf-8")
GUIDE_IMAGES_DIR = TEMPLATES_DIR / "guide_images"


def current_user(request: Request) -> dict | None:
    user_id = request.session.get("user_id")
    return db.get_user_by_id(user_id) if user_id else None


def _require_admin(request: Request) -> dict | None:
    """None if the caller isn't an admin — every /admin/* route below returns 403 in that case
    rather than the redirect-to-login require_login gives everyone else, since a non-admin who's
    already logged in should see "forbidden", not get bounced to a login form they'd pass."""
    user = request.state.user
    return user if user.get("is_admin") else None


# Navigation uses a small version of the wordmark shared with the workspace; logo.png is the favicon.
BRAND_LOGO = '<img class="brand-logo" src="/images/logo_name_nav.webp" width="452" height="156" fetchpriority="high" alt="AnnoBio">'

NAV_LINKS = [
    ("/", "Home"),
    ("/app", "Workspace"),
    ("/gallery", "Gallery"),
    ("/download", "Download"),
    ("/guide", "User Guide"),
    ("/about", "About"),
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
        review_link_html = '<a class="menu-option" href="/admin/gallery">Review</a>' if user.get("is_admin") else ""
        actions_html = (
            '<div class="nav-avatar-wrap">'
            f'<button type="button" class="nav-avatar" aria-label="Account: {user["email"]}" onclick="location.href=\'/profile\'">{initials}</button>'
            '<div class="nav-avatar-dropdown">'
            f'<div class="nav-avatar-email">{user["email"]}</div>'
            '<a class="menu-option" href="/profile">Profile</a>'
            f'{review_link_html}'
            '<form method="post" action="/logout"><button type="submit" class="menu-option">Log out</button></form>'
            '</div>'
            '</div>'
        )
    else:
        actions_html = (
            '<a class="btn btn-ghost" href="/login">Log in</a>'
            '<a class="btn btn-primary" href="/register">Sign up</a>'
        )
    return (
        '<nav class="top">'
        f'<a class="brand" href="/">{BRAND_LOGO}</a>'
        f'<div class="nav-links">{links_html}</div>'
        f'<div class="nav-actions">{actions_html}</div>'
        '</nav>'
    )


def render_page(*, title: str, user: dict | None, active: str = "", body: str, extra_css: str = "", narrow: bool = False) -> str:
    """Shared shell for Download/Guide/Profile — nav + a plain content well, styled with the same
    tokens as landing/auth. See templates/page.html."""
    return (
        PAGE_TEMPLATE
        .replace("{{SHARED_CSS}}", SHARED_CSS)
        .replace("{{EXTRA_CSS}}", extra_css)
        .replace("{{TITLE}}", title)
        .replace("{{NAV}}", render_nav(user, active=active))
        .replace("{{OUTER_CLASS}}", "page-outer--narrow" if narrow else "")
        .replace("{{BODY}}", body)
    )


def render_auth_page(
    *, heading: str, form_action: str, password_placeholder: str = "Password",
    password_minlength: str = "", error: str = "", submit_label: str, footer_link: str,
    user: dict | None = None, extra_fields: str = "",
) -> str:
    """Shared shell for /login and /register — same card, same tokens as the landing page, just
    a different heading/fields/footer link so the two don't visually read as separate products.
    extra_fields is register's hook for the Name field below (login has none)."""
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
        .replace("{{EXTRA_FIELDS}}", extra_fields)
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
        footer_link=(
            'Need an account? <a class="link" href="/register">Register</a>'
            '<br><a class="link" href="/forgot-password">Forgot your password?</a>'
        ),
    )


def _register_page_html(error: str = "", name: str = "") -> str:
    return render_auth_page(
        heading="Create an account",
        form_action="/register",
        password_placeholder="Password (min 8 characters)",
        password_minlength='minlength="8"',
        error=error,
        submit_label="Create account",
        footer_link='Already have an account? <a class="link" href="/login">Log in</a>',
        extra_fields=f'<div class="field"><input name="name" type="text" placeholder="Name" value="{escape(name)}" maxlength="200" required></div>',
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
def register_submit(request: Request, email: str = Form(...), password: str = Form(...), name: str = Form(...)):
    if not name.strip():
        return HTMLResponse(_register_page_html(error="Name is required."), status_code=400)
    if len(password) < 8:
        return HTMLResponse(_register_page_html(error="Password must be at least 8 characters.", name=name), status_code=400)
    if db.get_user_by_email(email):
        return HTMLResponse(_register_page_html(error="An account with this email already exists.", name=name), status_code=400)
    user_id = db.create_user(email, password, name=name)
    request.session["user_id"] = user_id
    return RedirectResponse("/app", status_code=302)


# Same card look as login/register (see auth.html), but a standalone block rather than another
# render_auth_page() variant — that shared template hard-codes an email field *and* a password
# field, and these two pages each only ever want one of the two, not both.
_SIMPLE_FORM_CSS = """
  .simple-form { max-width: 360px; }
  .simple-form .field { margin-bottom: 14px; }
  .simple-form input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 13px;
    border: 1px solid var(--border); border-radius: var(--control-radius);
    background: var(--bg); color: var(--text); font-family: inherit;
  }
  .simple-form input:-webkit-autofill,
  .simple-form input:-webkit-autofill:hover,
  .simple-form input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    caret-color: var(--text);
    box-shadow: 0 0 0 1000px var(--bg) inset;
    border: 1px solid var(--border);
  }
  .simple-form .btn-submit { width: 100%; }
  .simple-form-footer { margin-top: 14px; font-size: 13px; color: var(--text-muted); }
  .error { background: rgba(200, 0, 0, 0.08); color: #b00020; font-size: 13px; padding: 8px 10px; border-radius: var(--control-radius); margin-bottom: 14px; }
"""


@app.get("/forgot-password")
def forgot_password_page():
    body = """
      <h1>Reset your password</h1>
      <p class="page-sub">Enter your account email and we'll send you a link to set a new one.</p>
      <form method="post" action="/forgot-password" class="simple-form">
        <div class="field"><input name="email" type="email" placeholder="Email" required></div>
        <button type="submit" class="btn btn-primary btn-submit">Send reset link</button>
      </form>
      <p class="simple-form-footer"><a class="link" href="/login">Back to log in</a></p>
    """
    return HTMLResponse(render_page(title="Reset password", user=None, body=body, extra_css=_SIMPLE_FORM_CSS, narrow=True))


@app.post("/forgot-password")
def forgot_password_submit(request: Request, email: str = Form(...)):
    """Same response whether or not the email matches an account — the page never confirms or
    denies an account's existence to whoever's asking. If it does match, a fresh single-use
    token (see db.create_password_reset) is emailed as a /reset-password link."""
    user = db.get_user_by_email(email)
    if user:
        token = db.create_password_reset(user["id"])
        base = containers.PUBLIC_BASE_URL.rstrip("/") if containers.PUBLIC_BASE_URL else str(request.base_url).rstrip("/")
        link = f"{base}/reset-password?token={token}"
        mailer.send_email(
            user["email"],
            "Reset your AnnoBio password",
            "Someone (hopefully you) asked to reset your AnnoBio password.\n\n"
            f"Click this link to set a new one — it's valid for 1 hour:\n{link}\n\n"
            "If you didn't request this, you can safely ignore this email.",
        )
    body = """
      <h1>Check your email</h1>
      <p class="page-sub">If that email has an AnnoBio account, we've sent a link to reset your password. It's valid for 1 hour.</p>
      <p class="simple-form-footer"><a class="link" href="/login">Back to log in</a></p>
    """
    return HTMLResponse(render_page(title="Check your email", user=None, body=body, narrow=True))


def _reset_password_form_html(token: str, error: str = "") -> str:
    error_html = f'<div class="error">{escape(error)}</div>' if error else ""
    return f"""
      <h1>Set a new password</h1>
      {error_html}
      <form method="post" action="/reset-password" class="simple-form">
        <input type="hidden" name="token" value="{escape(token)}">
        <div class="field"><input name="password" type="password" placeholder="New password (min 8 characters)" minlength="8" required></div>
        <button type="submit" class="btn btn-primary btn-submit">Set new password</button>
      </form>
    """


_RESET_LINK_INVALID_BODY = """
  <h1>Link expired</h1>
  <p class="page-sub">This password reset link is invalid or has expired.</p>
  <p class="simple-form-footer"><a class="link" href="/forgot-password">Request a new one</a></p>
"""


@app.get("/reset-password")
def reset_password_page(token: str = ""):
    if not db.get_valid_password_reset(token):
        return HTMLResponse(render_page(title="Link expired", user=None, body=_RESET_LINK_INVALID_BODY), status_code=400)
    return HTMLResponse(render_page(title="Set a new password", user=None, body=_reset_password_form_html(token), extra_css=_SIMPLE_FORM_CSS, narrow=True))


@app.post("/reset-password")
def reset_password_submit(token: str = Form(...), password: str = Form(...)):
    reset = db.get_valid_password_reset(token)
    if not reset:
        return HTMLResponse(render_page(title="Link expired", user=None, body=_RESET_LINK_INVALID_BODY), status_code=400)
    if len(password) < 8:
        body = _reset_password_form_html(token, error="Password must be at least 8 characters.")
        return HTMLResponse(render_page(title="Set a new password", user=None, body=body, extra_css=_SIMPLE_FORM_CSS, narrow=True), status_code=400)
    db.consume_password_reset(token, reset["user_id"], password)
    return RedirectResponse("/login", status_code=302)


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


@app.get("/whoami")
def whoami(request: Request):
    """Lets the frontend show who's logged in (account avatar in the top bar) without teaching
    it anything about sessions — require_login below already gated this request and attached
    the user. is_admin drives whether the top bar shows a Review link (see topBar.js); name
    lets the web app warn before Publish if it's still blank (see publishCurrentProjectToGallery
    in webProjectModal.js)."""
    user = request.state.user
    return {
        "email": user["email"],
        "is_admin": bool(user.get("is_admin")),
        "name": user.get("name") or "",
    }


WINDOWS_INSTALLER_URL = "https://drive.google.com/file/d/1BoNqaCO4QrfS6XlvbVhRjaF9RLkZ17Ly/view?usp=drive_link"
MAC_INSTALLER_URL = "https://drive.google.com/file/d/17tZiG-wMFrAlmfw7S96BQs0mhJfb5_-f/view?usp=drive_link"


@app.get("/download")
def download_page(request: Request):
    """Public page for the two desktop installers (built by .github/workflows/build-desktop.yml,
    hosted on Google Drive rather than served from the Hub itself)."""
    user = current_user(request)
    browser_href = "/app" if user else "/login"
    body = f"""
      <h1>Download AnnoBio</h1>
      <p class="page-sub">The desktop app for Windows and macOS.</p>
      <div class="download-grid">
        <div class="download-card">
          <h3>Windows</h3>
          <p>.exe installer</p>
          <a class="btn btn-primary" href="{WINDOWS_INSTALLER_URL}" target="_blank" rel="noopener">Download</a>
        </div>
        <div class="download-card">
          <h3>macOS</h3>
          <p>.dmg installer, Apple Silicon</p>
          <a class="btn btn-primary" href="{MAC_INSTALLER_URL}" target="_blank" rel="noopener">Download</a>
        </div>
      </div>
      <p class="download-note">
        Prefer the browser? <a class="link" href="{browser_href}">Use AnnoBio online</a> instead.
      </p>
    """
    extra_css = """
      .download-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
      .download-card { background: var(--bg); border: 1px solid var(--border); border-radius: var(--control-radius); padding: 22px; text-align: center; }
      .download-card h3 { margin: 0 0 4px; font-size: 17px; }
      .download-card p { margin: 0 0 16px; color: var(--text-muted); font-size: 13.5px; }
      .download-note { color: var(--text-muted); font-size: 14px; line-height: 1.6; }
      a.link { color: var(--accent); text-decoration: none; }
      a.link:hover { text-decoration: underline; }
    """
    return HTMLResponse(render_page(title="Download", user=user, active="/download", body=body, extra_css=extra_css))


@app.get("/about")
def about_page(request: Request):
    user = current_user(request)
    body = """
      <h1>About AnnoBio</h1>
      <p class="page-sub">
        AnnoBio is a visual workspace for building biomedical AI workflows. Connect data, prompts,
        and processing steps on the canvas, or describe your research task to the Agent and build
        the workflow together.
      </p>
      <p class="page-sub">
        Find relevant data, generate structured results, evaluate outputs, and improve prompts.
        Keep sources and prompt versions connected as you refine your workflow. Available in
        your browser and on Windows and macOS.
      </p>
      <h2 class="about-heading">Contact</h2>
      <p class="page-sub about-contact-intro">For questions about AnnoBio data, methods, website feedback, or collaboration, please contact:</p>
      <p class="about-contact-line">Yichuan Zhang (<a class="link" href="mailto:yichuan@usf.edu">yichuan@usf.edu</a>)</p>
      <p class="about-contact-line">Duolin Wang (<a class="link" href="mailto:duolinwang@usf.edu">duolinwang@usf.edu</a>)</p>
    """
    extra_css = """
      .about-heading { font-size: 18px; margin: 32px 0 12px; }
      .about-contact-intro { margin-bottom: 16px; }
      .about-contact-line { margin: 0 0 8px; font-size: 14px; color: var(--text); }
      a.link { color: var(--accent); text-decoration: none; }
      a.link:hover { text-decoration: underline; }
    """
    return HTMLResponse(render_page(title="About", user=user, active="/about", body=body, extra_css=extra_css))


# Screenshots referenced by GUIDE_CHAPTERS below, served from GUIDE_IMAGES_DIR at /guide/images/*
# (see the mount near the bottom of this file). Missing files degrade gracefully — see fig() — so
# a chapter still reads fine before its screenshot has been captured/added.
GUIDE_IMAGES = {
    "empty-canvas": "empty-canvas.png",
    "add-prompt-modal": "add-prompt-modal.png",
    "add-dataset-modal": "add-dataset-modal.png",
    "canvas-connected": "canvas-connected.png",
    "run-results": "run-results.png",
    "review-method-picker": "review-method-picker.png",
    "llm-settings": "llm-settings.png",
    "agent-assistant": "agent-assistant.png",
    "agent-welcome": "agent-welcome.png",
    "process-node": "process-node.png",
    "dataset-table": "dataset-table.png",
    "pipeline-overview": "pipeline-overview.png",
    "optimize-findings": "optimize-findings.png",
    "optimize-suggestion": "optimize-suggestion.png",
    "prompt-versions": "prompt-versions.png",
}


def fig(slug: str, caption: str) -> str:
    filename = GUIDE_IMAGES.get(slug)
    if not filename or not (GUIDE_IMAGES_DIR / filename).is_file():
        return ""
    return (
        '<figure class="docs-figure">'
        f'<a href="/guide/images/{filename}" target="_blank" rel="noopener" aria-label="Open screenshot: {escape(caption, quote=True)}">'
        f'<img src="/guide/images/{filename}" alt="{escape(caption, quote=True)}" loading="lazy"></a>'
        f'<figcaption>{caption}</figcaption>'
        '</figure>'
    )


# Keep the guide narrative separate from request handling.
GUIDE_CHAPTERS = build_chapters(fig)


@app.get("/guide")
def guide_page(request: Request):
    user = current_user(request)
    toc_items = "".join(
        (f'<li class="docs-toc-group">{GUIDE_GROUPS[chapter_id]}</li>' if chapter_id in GUIDE_GROUPS else "")
        + f'<li><a href="#{chapter_id}">{title}</a></li>'
        for chapter_id, title, _ in GUIDE_CHAPTERS
    )
    chapters_html = "".join(
        f'<section class="docs-chapter" id="{chapter_id}">'
        f'<h2 class="docs-chapter-title">{i + 1}. {title}</h2>'
        f'<div class="docs-article">{render_body()}</div>'
        '</section>'
        for i, (chapter_id, title, render_body) in enumerate(GUIDE_CHAPTERS)
    )
    html = (
        GUIDE_TEMPLATE
        .replace("{{SHARED_CSS}}", SHARED_CSS)
        .replace("{{NAV}}", render_nav(user, active="/guide"))
        .replace("{{TOC_ITEMS}}", toc_items)
        .replace("{{CHAPTERS}}", chapters_html)
    )
    return HTMLResponse(html)


async def _fetch_user_projects(user_id: int) -> list[dict]:
    """Lists a user's workspaces for the Profile page — reaches into their own backend container
    directly (see containers.py), the same way proxy.py does for a browser's /api/* request, just
    without needing an inbound Request to forward since this is a plain GET with no body/headers
    of its own."""
    try:
        name = await asyncio.to_thread(containers.ensure_running, user_id)
    except containers.BackendUnavailable:
        return []
    await asyncio.to_thread(db.touch_container, user_id)
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
        workspaces_html = '<p class="workspaces-empty">No workspaces yet. <a class="link" href="/app">Create one</a>.</p>'
    else:
        # Same card-grid look as the public Gallery (see ARCHIVE_CSS/_archive_thumb_html above) —
        # a thumbnail per workspace, generated client-side on every autosave (see renderer.js's
        # saveWebProjectThumbnail) and served back through the per-user proxy at /api/projects/...
        # rather than a Hub-owned static path, since it's private to this user's own container.
        cards = "".join(
            f"""
            <a class="archive-card" href="/app/?open={p['id']}">
              {_workspace_thumb_html(p)}
              <div class="archive-card-body">
                <div class="archive-card-title">{escape(p.get('name') or 'Untitled Project')}</div>
                <div class="archive-card-meta">{datetime.datetime.fromtimestamp(p['updatedAt']).strftime('%b %-d, %Y')}</div>
              </div>
            </a>
            """
            for p in projects
        )
        workspaces_html = f'<div class="archive-grid">{cards}</div>'

    body = f"""
      <h1>Profile</h1>
      <p class="page-sub">Your AnnoBio account.</p>
      <div class="profile-card">
        <div class="profile-row"><span class="profile-label">Email</span><span>{user["email"]}</span></div>
        <div class="profile-row"><span class="profile-label">Member since</span><span>{joined}</span></div>
      </div>

      <form method="post" action="/profile/info" class="profile-card">
        <div class="profile-row">
          <label class="profile-label" for="profile-name">Name</label>
          <input id="profile-name" name="name" type="text" maxlength="200" value="{escape(user.get('name') or '')}">
        </div>
        <div class="profile-row profile-save-row"><button type="submit" class="btn btn-secondary">Save</button></div>
      </form>
      <p class="page-sub profile-info-note">Shown to the admin reviewing anything you publish to the Gallery. Required before you can publish.</p>

      <form method="post" action="/logout">
        <button type="submit" class="btn btn-secondary">Log out</button>
      </form>

      <h2 class="workspaces-heading">Your workspaces</h2>
      {workspaces_html}
    """
    extra_css = ARCHIVE_CSS + """
      .profile-card { max-width: 460px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--control-radius); padding: 6px 20px; margin-bottom: 22px; }
      .profile-row { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
      .profile-row:last-child { border-bottom: none; }
      .profile-label { color: var(--text-muted); }
      .profile-row input[type="text"] { flex: 1; max-width: 260px; margin-left: 16px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--bg); color: var(--text); font-size: 13px; font-family: inherit; }
      .profile-save-row { justify-content: flex-end; padding-top: 12px; }
      .profile-info-note { max-width: 460px; font-size: 12.5px; margin: -12px 0 22px; }
      .workspaces-heading { font-size: 18px; margin: 40px 0 14px; }
      .workspaces-empty { color: var(--text-muted); font-size: 14px; }
      a.link { color: var(--accent); text-decoration: none; }
      a.link:hover { text-decoration: underline; }
    """
    return HTMLResponse(render_page(title="Profile", user=user, active="/profile", body=body, extra_css=extra_css))


@app.post("/profile/info")
def profile_update_info(request: Request, name: str = Form("")):
    db.update_user_info(request.state.user["id"], name)
    return RedirectResponse("/profile", status_code=302)


ARCHIVE_CSS = """
  .archive-intro-actions { margin-bottom: 24px; }
  .archive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
  .archive-card {
    display: block; text-decoration: none; color: var(--text);
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--control-radius);
    overflow: hidden; transition: border-color .1s;
  }
  .archive-card:hover { border-color: var(--accent); }
  .archive-card-thumb, .archive-card-thumb-empty { aspect-ratio: 16/10; background: var(--bg-bar, #f4f4f5); }
  .archive-card-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .archive-card-body { padding: 12px 14px; }
  .archive-card-title { font-weight: 600; font-size: 14px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-card-meta { font-size: 12px; color: var(--text-muted); }
  .archive-detail { display: flex; gap: 32px; flex-wrap: wrap; }
  .archive-detail-thumb { flex: 1 1 360px; max-width: 480px; }
  .archive-detail-thumb img, .archive-detail-thumb .archive-card-thumb-empty { display: block; width: 100%; border-radius: var(--control-radius); border: 1px solid var(--border); aspect-ratio: 16/10; object-fit: cover; background: var(--bg-bar, #f4f4f5); }
  .archive-detail-info { flex: 1 1 280px; }
  .archive-detail-meta { color: var(--text-muted); font-size: 13.5px; margin: 4px 0 16px; }
  .archive-detail-desc { font-size: 14px; line-height: 1.6; margin: 0 0 24px; white-space: pre-wrap; }
"""


def _archive_thumb_html(item: dict, css_class: str = "archive-card-thumb") -> str:
    if not item.get("thumbnail_path"):
        return f'<div class="{css_class} archive-card-thumb-empty"></div>'
    return f'<div class="{css_class}"><img src="/gallery-images/{item["thumbnail_path"]}" alt="" loading="lazy"></div>'


def _workspace_thumb_html(project: dict) -> str:
    """Same card look as _archive_thumb_html, but for the Profile page's own (private) workspaces
    — served through the per-user proxy at /api/projects/... (see project_store.py's
    GET /{id}/thumbnail) rather than a Hub-owned static path, since only its owner may see it."""
    if not project.get("hasThumbnail"):
        return '<div class="archive-card-thumb archive-card-thumb-empty"></div>'
    return f'<div class="archive-card-thumb"><img src="/api/projects/{project["id"]}/thumbnail" alt="" loading="lazy"></div>'


def _fmt_date(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts).strftime("%b %-d, %Y") if ts else ""


def _gallery_owner_name(item: dict) -> str:
    """Public Gallery pages show the display name, never an account email address."""
    return (item.get("owner_name") or "").strip() or "AnnoBio member"


@app.get("/gallery")
def archive_list_page(request: Request):
    user = current_user(request)
    items = db.list_archive_items()
    if not items:
        grid_html = '<p class="workspaces-empty">Nothing published yet. Open a project and use "Publish to Gallery" to be the first.</p>'
    else:
        cards = "".join(
            f"""
            <a class="archive-card" href="/gallery/{item['id']}">
              {_archive_thumb_html(item)}
              <div class="archive-card-body">
                <div class="archive-card-title">{escape(item['title'])}</div>
                <div class="archive-card-meta">{escape(_gallery_owner_name(item))} · {_fmt_date(item['created_at'])}</div>
              </div>
            </a>
            """
            for item in items
        )
        grid_html = f'<div class="archive-grid">{cards}</div>'
    body = f"""
      <h1>Gallery</h1>
      <p class="page-sub">Pipelines other researchers have published, with their prompts, datasets, and scores. Open one to see how it was built, or add it to your account and build on it.</p>
      {grid_html}
    """
    return HTMLResponse(render_page(title="Gallery", user=user, active="/gallery", body=body, extra_css=ARCHIVE_CSS))


@app.get("/gallery/{item_id}")
def archive_detail_page(request: Request, item_id: int):
    user = current_user(request)
    item = db.get_archive_item(item_id)
    # Pending items 404 the same as missing ones (rather than a distinct "not approved yet"
    # message) — no reason to confirm to a random visitor that some unapproved item exists.
    if not item or item.get("status") != "approved":
        body = "<h1>Not found</h1><p class=\"page-sub\">This project isn't in the Gallery (anymore).</p>"
        return HTMLResponse(render_page(title="Gallery", user=user, active="/gallery", body=body), status_code=404)
    if user:
        action_html = f'<form method="post" action="/gallery/{item_id}/fork"><button type="submit" class="btn btn-primary">Add to my account</button></form>'
    else:
        action_html = '<a class="btn btn-primary" href="/login">Log in to add this to your account</a>'
    desc_html = f'<p class="archive-detail-desc">{escape(item["description"])}</p>' if item.get("description") else ""
    admin_html = (
        f'<div class="archive-detail-admin">{_admin_delete_form(item_id, "gallery", "Delete from Gallery")}</div>'
        if user and user.get("is_admin") else ""
    )
    body = f"""
      <div class="archive-detail">
        <div class="archive-detail-thumb">{_archive_thumb_html(item, css_class="")}</div>
        <div class="archive-detail-info">
          <h1>{escape(item['title'])}</h1>
          <p class="archive-detail-meta">Published by {escape(_gallery_owner_name(item))} · {_fmt_date(item['created_at'])}</p>
          {desc_html}
          {action_html}
          {admin_html}
        </div>
      </div>
    """
    return HTMLResponse(render_page(title=item["title"], user=user, active="/gallery", body=body, extra_css=ADMIN_REVIEW_CSS if admin_html else ARCHIVE_CSS))


@app.post("/gallery/publish")
async def archive_publish(
    request: Request,
    project_id: str = Form(...),
    title: str = Form(...),
    description: str = Form(""),
    thumbnail: UploadFile | None = File(None),
):
    """Called by the web app (see webProjectModal.js) with the currently open project's id, a
    title/description, and a PNG thumbnail captured client-side from the canvas — the Hub has no
    way to render a canvas screenshot itself. Fetches the actual bundle from the publishing user's
    own container (see archive.fetch_project_bundle) rather than trusting anything about the
    project's contents from the client."""
    user = request.state.user
    title = title.strip()[:200]
    if not title:
        return Response(content="Title is required.", status_code=400)
    if not (user.get("name") or "").strip():
        return Response(
            content="Add your name on your Profile page before publishing.",
            status_code=400,
        )
    try:
        bundle_bytes = await archive.fetch_project_bundle(user["id"], project_id)
    except (ValueError, containers.BackendUnavailable) as e:
        return Response(content=str(e), status_code=400)
    bundle_path = archive.save_bundle(bundle_bytes)
    thumbnail_path = None
    if thumbnail is not None:
        thumb_bytes = await thumbnail.read()
        if 0 < len(thumb_bytes) <= archive.MAX_THUMBNAIL_BYTES:
            thumbnail_path = archive.save_thumbnail(thumb_bytes)
    item_id = db.create_archive_item(user["id"], title, description.strip()[:2000], bundle_path, thumbnail_path)
    return {"id": item_id}


@app.post("/gallery/{item_id}/fork")
async def archive_fork(request: Request, item_id: int):
    user = request.state.user
    item = db.get_archive_item(item_id)
    if not item or item.get("status") != "approved":
        return RedirectResponse("/gallery", status_code=302)
    bundle_bytes = archive.read_bundle(item["bundle_path"])
    try:
        new_id = await archive.import_bundle_into_container(user["id"], bundle_bytes, f"{item['title']}.yc")
    except (ValueError, containers.BackendUnavailable) as e:
        body = f"<h1>Could not add project</h1><p class=\"page-sub\">{escape(str(e))}</p>"
        return HTMLResponse(render_page(title="Gallery", user=user, active="/gallery", body=body), status_code=502)
    return RedirectResponse(f"/app/?open={new_id}", status_code=302)


def _admin_delete_form(item_id: int, return_to: str, label: str = "Delete") -> str:
    """An admin's delete button for a Gallery item, published or pending. Copies people already
    added to their accounts are independent projects, so they are not affected."""
    confirm = "Delete this project from the Gallery? Copies people already added to their accounts are not affected. This cannot be undone."
    return (
        f'<form method="post" action="/admin/gallery/{item_id}/delete" onsubmit="return confirm(\'{confirm}\');">'
        f'<input type="hidden" name="return_to" value="{return_to}">'
        f'<button type="submit" class="btn btn-secondary btn-delete">{label}</button></form>'
    )


ADMIN_REVIEW_CSS = ARCHIVE_CSS + """
  .admin-review-grid { display: flex; flex-direction: column; gap: 18px; }
  .admin-review-card { display: flex; gap: 20px; border: 1px solid var(--border); border-radius: var(--control-radius); padding: 16px; background: var(--bg); }
  .admin-review-thumb { flex: 0 0 200px; }
  .admin-review-thumb .archive-card-thumb, .admin-review-thumb .archive-card-thumb-empty { border-radius: var(--control-radius); }
  .admin-review-body { flex: 1; min-width: 0; }
  .admin-review-edit-form input, .admin-review-edit-form textarea {
    display: block; width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 6px 8px;
    border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--bg);
    color: var(--text); font-size: 13px; font-family: inherit;
  }
  .admin-review-edit-form textarea { min-height: 60px; resize: vertical; }
  .admin-review-meta { color: var(--text-muted); font-size: 12.5px; margin: 4px 0 12px; }
  .admin-review-actions { display: flex; gap: 8px; }
  .admin-review-actions .btn-delete, .archive-detail-admin .btn-delete { color: #c0392b; border-color: #c0392b; }
  .archive-detail-admin { margin-top: 16px; }
  .admin-section-title { font-size: 16px; margin: 32px 0 12px; }
  .admin-published-list { display: flex; flex-direction: column; gap: 10px; }
  .admin-published-row { display: flex; align-items: center; gap: 14px; border: 1px solid var(--border); border-radius: var(--control-radius); padding: 10px 14px; background: var(--bg); }
  .admin-published-row .archive-card-thumb, .admin-published-row .archive-card-thumb-empty { width: 96px; flex: 0 0 96px; border-radius: var(--control-radius); }
  .admin-published-info { flex: 1; min-width: 0; }
  .admin-published-info a { color: var(--text); font-weight: 600; text-decoration: none; }
  .admin-published-info a:hover { text-decoration: underline; }
"""


@app.get("/admin/gallery")
def admin_gallery_page(request: Request):
    """Review queue for pending Gallery publishes — the flip side of archive_publish's status
    default: nothing a user submits shows up in the public /gallery until an admin approves it
    here. Reuses ARCHIVE_CSS's thumbnail look, not the public listing's read-only card, since
    each item needs its own edit form."""
    user = _require_admin(request)
    if not user:
        return HTMLResponse("<h1>Forbidden</h1>", status_code=403)
    items = db.list_pending_archive_items()
    if not items:
        grid_html = '<p class="workspaces-empty">Nothing pending review.</p>'
    else:
        cards = "".join(
            f"""
            <div class="admin-review-card">
              <div class="admin-review-thumb">{_archive_thumb_html(item)}</div>
              <div class="admin-review-body">
                <form method="post" action="/admin/gallery/{item['id']}/save" class="admin-review-edit-form">
                  <input type="text" name="title" value="{escape(item['title'])}" maxlength="200">
                  <textarea name="description" maxlength="2000">{escape(item.get('description') or '')}</textarea>
                  <button type="submit" class="btn btn-secondary">Save changes</button>
                </form>
                <p class="admin-review-meta">
                  Submitted by {escape(item.get('owner_name') or '(no name on file)')}
                  &lt;{escape(item['owner_email'])}&gt; · {_fmt_date(item['created_at'])}
                </p>
                <div class="admin-review-actions">
                  <form method="post" action="/admin/gallery/{item['id']}/approve"><button type="submit" class="btn btn-primary">Approve</button></form>
                  {_admin_delete_form(item['id'], "admin")}
                </div>
              </div>
            </div>
            """
            for item in items
        )
        grid_html = f'<div class="admin-review-grid">{cards}</div>'
    published = db.list_archive_items()
    if not published:
        published_html = '<p class="workspaces-empty">Nothing published yet.</p>'
    else:
        rows = "".join(
            f"""
            <div class="admin-published-row">
              {_archive_thumb_html(item)}
              <div class="admin-published-info">
                <a href="/gallery/{item['id']}">{escape(item['title'])}</a>
                <div class="admin-review-meta">
                  {escape(item.get('owner_name') or '(no name on file)')} &lt;{escape(item['owner_email'])}&gt; · {_fmt_date(item['created_at'])}
                </div>
              </div>
              {_admin_delete_form(item['id'], "admin")}
            </div>
            """
            for item in published
        )
        published_html = f'<div class="admin-published-list">{rows}</div>'
    body = f"""
      <h1>Review submissions</h1>
      <p class="page-sub">Pending Gallery publishes. Edit if needed, then approve or delete.</p>
      {grid_html}
      <h2 class="admin-section-title">Published ({len(published)})</h2>
      {published_html}
    """
    return HTMLResponse(render_page(title="Review submissions", user=user, active="/admin/gallery", body=body, extra_css=ADMIN_REVIEW_CSS))


@app.post("/admin/gallery/{item_id}/save")
def admin_gallery_save(request: Request, item_id: int, title: str = Form(...), description: str = Form("")):
    if not _require_admin(request):
        return HTMLResponse("<h1>Forbidden</h1>", status_code=403)
    db.update_archive_item(item_id, title, description)
    return RedirectResponse("/admin/gallery", status_code=302)


@app.post("/admin/gallery/{item_id}/approve")
def admin_gallery_approve(request: Request, item_id: int):
    if not _require_admin(request):
        return HTMLResponse("<h1>Forbidden</h1>", status_code=403)
    db.approve_archive_item(item_id)
    return RedirectResponse("/admin/gallery", status_code=302)


@app.post("/admin/gallery/{item_id}/delete")
def admin_gallery_delete(request: Request, item_id: int, return_to: str = Form("admin")):
    """Deletes a pending or published item and its stored files. return_to picks where the admin
    lands: back on the review page, or on the Gallery when deleting from an item's own page."""
    if not _require_admin(request):
        return HTMLResponse("<h1>Forbidden</h1>", status_code=403)
    item = db.delete_archive_item(item_id)
    if item:
        archive.delete_files(item)
    return RedirectResponse("/gallery" if return_to == "gallery" else "/admin/gallery", status_code=302)


@app.middleware("http")
async def no_cache_for_pages(request: Request, call_next):
    """Every page here (the Hub's own routes, and the SPA's index.html served under /app) can
    change on a redeploy, and none of them are told apart by a versioned URL — so without this, a
    browser that heuristically cached index.html (it has no Cache-Control of its own from
    StaticFiles) or a Hub-rendered page keeps showing stale nav/copy after a rebuild, with no
    obvious way for someone testing the site to tell that's what happened. Vite's hashed build
    assets (/app/assets/*.js, *.css) are the one exception — their filename already changes
    whenever their content does, so those are left cacheable. The small shared navigation logos
    can be cached for a day to avoid downloading them again between Hub and Workspace pages."""
    response = await call_next(request)
    if request.url.path in ("/images/logo_name_nav.webp", "/images/logo_nav.webp") and response.status_code == 200:
        response.headers["Cache-Control"] = "public, max-age=86400"
    elif request.url.path.startswith("/app/assets/"):
        # Vite includes a content hash in these URLs. Reopening a workspace can
        # reuse the bundle without a download or a validation round trip.
        if response.status_code in (200, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    else:
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    # Gallery browsing (the list, a project's detail page, its thumbnail image) is public —
    # Overleaf-style, so it's worth sharing outside the app. Publishing and forking are POSTs,
    # so they fall through to the login check below same as everything else under /gallery.
    if (
        path in ("/", "/login", "/logout", "/register", "/download", "/guide", "/about", "/gallery", "/forgot-password", "/reset-password")
        or path.startswith("/internal/hosted-model/")
        or path.startswith("/guide/images/")
        or path.startswith("/gallery-images/")
        or path.startswith("/images/")
        or (path.startswith("/gallery/") and request.method == "GET")
    ):
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
    return await proxy_request(request, request.state.user)


# Added last so it wraps outermost and runs before require_login above — middleware added via
# add_middleware() wraps whatever was already registered, and require_login needs
# request.session (which this middleware populates) to already exist by the time it runs.
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, session_cookie="ps_session")


BRAND_IMAGES_DIR = Path(__file__).resolve().parent.parent / "images"
if BRAND_IMAGES_DIR.is_dir():
    app.mount("/images", StaticFiles(directory=BRAND_IMAGES_DIR), name="brand-images")

if FRONTEND_DIST.is_dir():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")

if GUIDE_IMAGES_DIR.is_dir():
    app.mount("/guide/images", StaticFiles(directory=GUIDE_IMAGES_DIR), name="guide-images")

# Unlike GUIDE_IMAGES_DIR (pre-seeded before deploy), thumbnails are written by archive_publish()
# at runtime, so the directory has to exist *before* mounting rather than being mounted
# conditionally on already existing.
archive.ARCHIVE_THUMBS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/gallery-images", StaticFiles(directory=archive.ARCHIVE_THUMBS_DIR), name="gallery-images")
