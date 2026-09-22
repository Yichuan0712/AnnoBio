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


# Brand mark — two nodes flowing into one, drawn in Lucide's own style (24x24 grid, 2px stroke,
# round caps/joins) since that's what every icon elsewhere on the site already uses, but an
# original composition rather than reusing one of theirs verbatim. Same markup as app/src/topBar.js's
# brand mark in the Workspace's own top bar — one icon, everywhere "AnnoBio" appears.
BRAND_MARK_SVG = (
    '<svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    '<rect x="2" y="8.5" width="7" height="7" rx="1.5"/>'
    '<rect x="14" y="2" width="7" height="7" rx="1.5"/>'
    '<rect x="14" y="15" width="7" height="7" rx="1.5"/>'
    '<path d="M9 12v-3a2 2 0 0 1 2-2h3"/>'
    '<path d="M9 12v3a2 2 0 0 0 2 2h3"/>'
    '</svg>'
)

NAV_LINKS = [
    ("/", "Home"),
    ("/app", "Workspace"),
    ("/gallery", "Gallery"),
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
        f'<a class="brand" href="/">{BRAND_MARK_SVG}AnnoBio</a>'
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
        footer_link='Need an account? <a class="link" href="/register">Register</a>',
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


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=302)


@app.get("/whoami")
def whoami(request: Request):
    """Lets the frontend show who's logged in (account avatar in the top bar) without teaching
    it anything about sessions — require_login below already gated this request and attached
    the user. is_admin drives whether the top bar shows a Review link (see topBar.js); name/
    contact let the web app warn before Publish if either is still blank (see
    publishCurrentProjectToGallery in webProjectModal.js)."""
    user = request.state.user
    return {
        "email": user["email"],
        "is_admin": bool(user.get("is_admin")),
        "name": user.get("name") or "",
        "contact": user.get("contact") or "",
    }


WINDOWS_INSTALLER_URL = "https://drive.google.com/file/d/1BoNqaCO4QrfS6XlvbVhRjaF9RLkZ17Ly/view?usp=drive_link"
MAC_INSTALLER_URL = "https://drive.google.com/file/d/17tZiG-wMFrAlmfw7S96BQs0mhJfb5_-f/view?usp=drive_link"


@app.get("/download")
def download_page(request: Request):
    """Public page for the two desktop installers (built by .github/workflows/build-desktop.yml,
    hosted on Google Drive rather than served from the Hub itself)."""
    user = current_user(request)
    browser_href = "/app" if user else "/register"
    body = f"""
      <h1>Download AnnoBio</h1>
      <p class="page-sub">The full Electron app: native file access, local project storage, works entirely offline.</p>
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


# Screenshots referenced by GUIDE_CHAPTERS below, served from GUIDE_IMAGES_DIR at /guide/images/*
# (see the mount near the bottom of this file). Missing files degrade gracefully — see fig() — so
# a chapter still reads fine before its screenshot has been captured/added.
GUIDE_IMAGES = {
    "empty-canvas": "empty-canvas.png",
    "add-prompt-modal": "add-prompt-modal.png",
    "add-dataset-modal": "add-dataset-modal.png",
    "canvas-connected": "canvas-connected.png",
    "run-progress": "run-progress.png",
    "run-results": "run-results.png",
    "review-method-picker": "review-method-picker.png",
    "llm-settings": "llm-settings.png",
    "agent-assistant": "agent-assistant.png",
    "process-node": "process-node.png",
    "process-context-menu": "process-context-menu.png",
}


def fig(slug: str, caption: str) -> str:
    filename = GUIDE_IMAGES.get(slug)
    if not filename or not (GUIDE_IMAGES_DIR / filename).is_file():
        return ""
    return (
        '<figure class="docs-figure">'
        f'<img src="/guide/images/{filename}" alt="{caption}" loading="lazy">'
        f'<figcaption>{caption}</figcaption>'
        '</figure>'
    )


REVIEW_METHODS_TABLE = """
<div class="docs-table-wrap">
<table>
<tr><th>Method</th><th>Rewrites</th><th>Good for</th></tr>
<tr><td><strong>Thompson Prompt Search</strong><br>(default)</td><td>Instructions</td><td>A quick first pass that reads the failing rows, explains the likely issue, and proposes a targeted edit.</td></tr>
<tr><td><strong>GEPA</strong></td><td>Instructions</td><td>Harder tasks where a single edit isn't enough. Evolves several candidate prompts over multiple rounds and keeps the best.</td></tr>
<tr><td><strong>MIPROv2</strong></td><td>Instructions + few-shot examples</td><td>When both the wording and a couple of worked examples would help.</td></tr>
<tr><td><strong>COPRO</strong></td><td>Instructions only</td><td>Similar to MIPROv2 but skips few-shot examples, useful when example rows would eat too much of the context window.</td></tr>
<tr><td><strong>BootstrapFewShotWithRandomSearch</strong></td><td>Few-shot examples only</td><td>When the instructions are already good and the model mainly needs to see examples of the right output.</td></tr>
<tr><td><strong>SIMBA</strong></td><td>Instructions + few-shot examples</td><td>Self-reflective: the model critiques its own mistakes and turns them into rules and examples.</td></tr>
<tr><td><strong>TextGrad</strong></td><td>Instructions</td><td>Treats the score as a loss signal and nudges the prompt's wording in the direction that would have improved it.</td></tr>
</table>
</div>
"""

GUIDE_CHAPTERS = [
    ("overview", "Overview", lambda: f"""
<p>AnnoBio is a canvas for building, running, and improving LLM prompts against real datasets. You write a
prompt once, connect it to a dataset, run it across every row, and, if the output isn't good enough yet, let an
automatic optimizer rewrite the prompt for you based on what went wrong.</p>
<p>It's built for the kind of work that shows up in chemistry and medical research: pulling structured facts out of
literature, screening compound descriptions, classifying trial text, anything where you'd otherwise be
copy-pasting the same instructions into a chat window hundreds of times.</p>
{fig("empty-canvas", "A new, empty project. The three icons in the top bar create everything you need: LLM settings, a prompt, or a dataset.")}
<h3>What this guide covers</h3>
<ul>
<li>The core objects (project, prompt, dataset, run, review) and how they fit together</li>
<li>Creating a project and adding your first prompt and dataset</li>
<li>Connecting nodes on the canvas and running a prompt across a dataset</li>
<li>Scoring results and letting an optimizer rewrite the prompt automatically</li>
<li>Running plain Python over a dataset when a step doesn't need a model at all</li>
<li>Adding your own LLM credentials, and using the Agent Assistant to drive the canvas in plain language</li>
</ul>
"""),
    ("key-concepts", "Key concepts", lambda: """
<h3>Project</h3>
<p>A <strong>project</strong> is the unit everything else lives in: its own canvas, with its own prompts,
datasets, runs, and review history. Switching projects switches the whole canvas.</p>
<h3>Prompt</h3>
<p>A <strong>prompt</strong> is a reusable instruction template made of one or more named <strong>sections</strong>,
plus an <strong>output schema</strong> describing the fields you want the model to return. You write it once and
run it against as many dataset rows as you like.</p>
<h3>Dataset</h3>
<p>A <strong>dataset</strong> is a table of rows, each one an input to run the prompt against. Build one by hand,
import a spreadsheet, or pull rows directly from PubMed, ClinicalTrials.gov, bioRxiv/medRxiv, or ChEMBL.</p>
<h3>Run</h3>
<p>A <strong>Run node</strong> sends the prompt, filled in with each dataset row, to your chosen model, and
collects the results into a table, one row of output per row of input.</p>
<h3>Review / Score</h3>
<p>A <strong>Score node</strong> grades a run's output against criteria you define. Once rows are scored, an
optimization method can use that signal to rewrite the prompt and try again.</p>
<h3>Process</h3>
<p>A <strong>Process node</strong> runs your own Python function over a dataset instead of a model. No LLM
involved. Useful for the parts of a pipeline that are plain data manipulation, not something worth spending a
model call on.</p>
<h3>Credential</h3>
<p>A <strong>credential</strong> is an API key for a model provider. You bring your own; AnnoBio doesn't
meter or bill LLM usage on your behalf.</p>
"""),
    ("website-overview", "Where to go", lambda: """
<p>Use this table as a map: each row points to the guide section that covers it.</p>
<div class="docs-table-wrap">
<table>
<tr><th>I want to&hellip;</th><th>Go to</th></tr>
<tr><td>Start a new piece of work</td><td><a href="#create-a-project">Create a project</a></td></tr>
<tr><td>Add an OpenAI / Anthropic / Gemini / other API key</td><td><a href="#add-your-model">Add your model</a></td></tr>
<tr><td>Write reusable instructions for the model</td><td><a href="#write-a-prompt">Write a prompt</a></td></tr>
<tr><td>Bring in rows to run the prompt against</td><td><a href="#build-a-dataset">Build a dataset</a></td></tr>
<tr><td>Actually run the prompt and see output</td><td><a href="#connect-and-run">Connect nodes and run</a></td></tr>
<tr><td>Grade output and improve the prompt automatically</td><td><a href="#review-and-optimize">Review and optimize a prompt</a></td></tr>
<tr><td>Run plain Python instead of a model call</td><td><a href="#process-node">Transform data with Python</a></td></tr>
<tr><td>Build the canvas by describing it in plain language</td><td><a href="#agent-assistant">Ask the Agent Assistant</a></td></tr>
<tr><td>Copy or combine projects</td><td><a href="#managing-projects">Managing projects</a></td></tr>
</table>
</div>
"""),
    ("create-a-project", "Create a project", lambda: """
<p>Click the project name in the top bar to open the project picker.</p>
<ol>
<li>Click <strong>New project</strong>, or pick an existing one from the list to reopen it.</li>
<li>A new project opens on an empty canvas with a short guidance box until you add your first node.</li>
</ol>
<p>Everything you build afterward (prompts, datasets, runs, review history) is saved inside that project and
reopens exactly as you left it.</p>
"""),
    ("add-your-model", "Add your model", lambda: f"""
<p>Before writing a prompt, open <strong>LLM settings</strong> (the chip icon in the top bar) and add a credential:
Run, Review, and the Agent Assistant all need one to actually talk to a model. AnnoBio doesn't restrict
which LLM you use, and doesn't meter or bill usage on your behalf; you bring your own API key, and it talks to
that provider directly. There are two ways to add one:</p>
<ul>
<li><strong>Via LiteLLM</strong> (the default): type a <strong>Model ID</strong> in LiteLLM's naming convention,
e.g. <code>gpt-5</code>, <code>anthropic/claude-sonnet-4-6</code>, or <code>gemini/gemini-2.0-flash</code>, paste
that provider's API key, and you're done. LiteLLM alone covers well over a hundred providers this way. Point the
optional <strong>Base URL</strong> field at a local or self-hosted endpoint (e.g. Ollama at
<code>http://localhost:11434/v1</code>) to use a model that isn't hosted by anyone else at all.</li>
<li><strong>Via OpenRouter</strong>: click <strong>Connect</strong> to sign in with an OpenRouter account, then
pick any model from its catalog. One connection, no per-model key pasting.</li>
</ul>
{fig("llm-settings", "LLM settings, empty state: two ways to add a credential, a LiteLLM model ID or an OpenRouter account connection.")}
<p>You can add more than one credential and set a different default for <strong>Run</strong>,
<strong>Review</strong>, and the <strong>Agent Assistant</strong> independently, for example a cheaper model for
everyday runs and a stronger one for optimization.</p>
"""),
    ("write-a-prompt", "Write a prompt", lambda: f"""
<p>Click the document icon in the top bar to create a new prompt. The editor walks through three steps.</p>
<h3>1. Name & description</h3>
<p>A name and a short note on what the prompt is for. Purely for your own reference.</p>
<h3>2. Sections</h3>
<p>The prompt body, split into named <strong>sections</strong>. Add as many as you need and reorder them freely.
Write a placeholder in single curly braces, e.g. <code>{{excerpt}}</code>, anywhere you want a dataset column's
value inserted; you'll map each placeholder to an actual column when you set up the Run node (see
<a href="#connect-and-run">Connect nodes and run</a>).</p>
<h3>3. Output schema</h3>
<p>Define the fields you want back from the model, each with a name, an optional description, and example values,
plus whether the model should return a <strong>single row</strong> or <strong>multiple rows</strong> per input.
This is what turns a free-text model response into a structured results table instead of a wall of text you'd
have to parse yourself. A live preview on the right shows exactly how the schema and the filled-in prompt will
look.</p>
{fig("add-prompt-modal", "Step 3 of the prompt editor: the output schema on the right, a live preview of the assembled prompt in the middle, showing the {excerpt} placeholder.")}
"""),
    ("build-a-dataset", "Build a dataset", lambda: f"""
<p>Click the database icon in the top bar to create a new dataset. Choose one of six ways to fill it in:</p>
{fig("add-dataset-modal", "Creating a dataset: pick a source, then Create. Empty table starts you with a single blank column; rows and extra columns are added afterward in the dataset editor.")}
<div class="docs-table-wrap">
<table>
<tr><th>Source</th><th>Use it when&hellip;</th></tr>
<tr><td>Empty table</td><td>You want to type in a handful of rows by hand.</td></tr>
<tr><td>Upload file</td><td>You already have a CSV, TSV, or Excel file.</td></tr>
<tr><td>PubMed</td><td>You have a list of PMIDs and want their abstracts as rows.</td></tr>
<tr><td>ClinicalTrials.gov</td><td>You have NCT numbers and want trial records as rows.</td></tr>
<tr><td>bioRxiv / medRxiv</td><td>You have preprint DOIs and want their abstracts as rows.</td></tr>
<tr><td>ChEMBL</td><td>You have ChEMBL IDs and want compound records as rows.</td></tr>
</table>
</div>
<p>Picking <strong>Empty table</strong> and clicking Create gives you a dataset node with one blank column.
Double-click it to open the dataset editor, where you rename columns, add more, and type in rows. However a
dataset is built, the result is the same: a table of rows and columns you can feed into a Run node.</p>
"""),
    ("connect-and-run", "Connect nodes and run", lambda: f"""
<p>Drag a connection from your prompt node to a <strong>Run node</strong> on the canvas.</p>
{fig("canvas-connected", "A prompt node connected to a Run node. The dataset isn't wired in with a drawn line; that happens inside the Run node itself, next.")}
<p>Open the Run node. Under <strong>Input dataset</strong>, pick the dataset to run against, then use the
<strong>Map input dataset columns to prompt inputs</strong> table to match each <code>{{placeholder}}</code> from
your prompt's sections to an actual column. AnnoBio suggests a match automatically when the names line up.
Pick a model at the bottom and click <strong>Run</strong>.</p>
<p>AnnoBio sends the filled-in prompt to your model once per row, in parallel up to your configured
concurrency, and streams results back into a table as they complete.</p>
{fig("run-progress", "A run in progress: completed rows appear in the results table as they finish.")}
{fig("run-results", "A finished run: one output row per input row, with the fields defined in the prompt's output schema.")}
<p>Click any result row to see the exact prompt that was sent and the model's raw response, useful when a
row's output looks wrong and you want to know why.</p>
"""),
    ("review-and-optimize", "Review and optimize a prompt", lambda: f"""
<p>Attach a <strong>Score node</strong> to a finished run. Pick a <strong>ground truth dataset</strong> (rows with
the answer you expect) and add one or more matching rules (for example, "Input # equals Ground truth #"). A row
counts as a match only when every rule is satisfied; AnnoBio computes precision, recall, and F1 across the
whole run automatically. Simple comparisons like this don't need code; switch to <strong>Match by code</strong>
instead if matching needs logic a rule can't express (fuzzy matching, numeric tolerance, and so on).</p>
<p>Once rows are scored, the review-method dropdown becomes available. Pick a method and click
<strong>Review</strong> to let it rewrite the prompt based on where it's going wrong.</p>
{fig("review-method-picker", "A Score node: ground truth dataset, a matching rule, computed precision/recall/F1, and the review-method dropdown.")}
{REVIEW_METHODS_TABLE}
<p>Not sure which to pick: start with the default (Thompson Prompt Search) for a quick pass. Reach for GEPA or
MIPROv2 when a single edit isn't moving the score enough, and BootstrapFewShotWithRandomSearch when the
instructions are already right but the model needs to see worked examples.</p>
<p>Every optimization run keeps the previous version of the prompt, so you can compare before/after and roll back
if a rewrite makes things worse.</p>
"""),
    ("process-node", "Transform data with Python", lambda: f"""
<p>Not every step needs a model. Right-click a dataset node and choose <strong>Process with code</strong> to run
your own Python function over it instead. No LLM, no API key, no cost, and it runs inside your own private
container, not shared with anyone else.</p>
{fig("process-context-menu", "Right-click a dataset node: Process with code creates a connected Process node.")}
<p>Two modes, on tabs in the Process node's editor:</p>
<ul>
<li><strong>Process by row</strong>: write <code>def process(row):</code>, called once per row.
<code>row</code> is a dict keyed by the dataset's column names; return a dict and each key becomes an output
column. Good for per-row logic a prompt can't (or shouldn't) do, such as flagging keywords, computing a derived
value, or validating a format.</li>
<li><strong>Process as dataframe</strong>: write <code>def process(df):</code>, called once on the whole dataset
as a pandas DataFrame. Good for whole-table work a per-row function can't express, such as filtering,
deduplication, sorting, or sampling.</li>
</ul>
{fig("process-node", "A Process node: a per-row Python function, run for real against the connected dataset, with results in the same table format as a Run node.")}
<p>Click <strong>Run</strong> to execute it against the connected dataset and see results in the same table format
as a Run node. A Process node's output can also be exported back out as a new dataset, so you can chain it into a
prompt afterward, for example filtering down to just the rows worth sending to a model.</p>
"""),
    ("agent-assistant", "Ask the Agent Assistant", lambda: f"""
<p>The Agent Assistant is the sparkle button on the canvas. Describe what you want in plain language and it can add
nodes, start runs, and apply review suggestions on your behalf. Useful for setting up a canvas quickly, or for
importing a dataset without hunting through the dataset modal's tabs yourself.</p>
{fig("agent-assistant", "Asking the Agent Assistant to import a dataset in plain language.")}
<p>It uses whichever credential you've set as the default for the Agent Assistant in LLM settings (see
<a href="#add-your-model">Add your model</a>).</p>
"""),
    ("managing-projects", "Managing projects", lambda: f"""
<p>Open the project picker from the top bar to see every project you've created.</p>
<ul>
<li><strong>Duplicate</strong> makes an independent copy of a project (prompts, datasets, and run history
included), so you can branch off without touching the original.</li>
<li><strong>Merge into current project</strong> copies another project's nodes onto the canvas you currently have
open, useful for combining a prompt you built in one project with a dataset from another.</li>
</ul>
"""),
]


@app.get("/guide")
def guide_page(request: Request):
    user = current_user(request)
    toc_items = "".join(
        f'<li><a href="#{chapter_id}">{title}</a></li>' for chapter_id, title, _ in GUIDE_CHAPTERS
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
        <div class="profile-row">
          <label class="profile-label" for="profile-contact">Contact</label>
          <input id="profile-contact" name="contact" type="text" maxlength="200" value="{escape(user.get('contact') or '')}" placeholder="Email or other way to reach you">
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
def profile_update_info(request: Request, name: str = Form(""), contact: str = Form("")):
    db.update_user_info(request.state.user["id"], name, contact)
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
                <div class="archive-card-meta">{escape(item['owner_email'])} · {_fmt_date(item['created_at'])}</div>
              </div>
            </a>
            """
            for item in items
        )
        grid_html = f'<div class="archive-grid">{cards}</div>'
    body = f"""
      <h1>Gallery</h1>
      <p class="page-sub">Projects the community has published. Browse freely, and add any of them to your own account to start from.</p>
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
    body = f"""
      <div class="archive-detail">
        <div class="archive-detail-thumb">{_archive_thumb_html(item, css_class="")}</div>
        <div class="archive-detail-info">
          <h1>{escape(item['title'])}</h1>
          <p class="archive-detail-meta">Published by {escape(item['owner_email'])} · {_fmt_date(item['created_at'])}</p>
          {desc_html}
          {action_html}
        </div>
      </div>
    """
    return HTMLResponse(render_page(title=item["title"], user=user, active="/gallery", body=body, extra_css=ARCHIVE_CSS))


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
    if not (user.get("name") or "").strip() or not (user.get("contact") or "").strip():
        return Response(
            content="Add your name and a contact method on your Profile page before publishing.",
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
  .admin-review-actions .btn-delete { color: #c0392b; border-color: #c0392b; }
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
                  &lt;{escape(item['owner_email'])}&gt; · Contact: {escape(item.get('owner_contact') or '—')}
                  · {_fmt_date(item['created_at'])}
                </p>
                <div class="admin-review-actions">
                  <form method="post" action="/admin/gallery/{item['id']}/approve"><button type="submit" class="btn btn-primary">Approve</button></form>
                  <form method="post" action="/admin/gallery/{item['id']}/delete" onsubmit="return confirm('Delete this submission? This cannot be undone.');"><button type="submit" class="btn btn-secondary btn-delete">Delete</button></form>
                </div>
              </div>
            </div>
            """
            for item in items
        )
        grid_html = f'<div class="admin-review-grid">{cards}</div>'
    body = f"""
      <h1>Review submissions</h1>
      <p class="page-sub">Pending Gallery publishes. Edit if needed, then approve or delete.</p>
      {grid_html}
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
def admin_gallery_delete(request: Request, item_id: int):
    if not _require_admin(request):
        return HTMLResponse("<h1>Forbidden</h1>", status_code=403)
    item = db.delete_archive_item(item_id)
    if item:
        archive.delete_files(item)
    return RedirectResponse("/admin/gallery", status_code=302)


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
    # Gallery browsing (the list, a project's detail page, its thumbnail image) is public —
    # Overleaf-style, so it's worth sharing outside the app. Publishing and forking are POSTs,
    # so they fall through to the login check below same as everything else under /gallery.
    if (
        path in ("/", "/login", "/logout", "/register", "/download", "/guide", "/gallery")
        or path.startswith("/guide/images/")
        or path.startswith("/gallery-images/")
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
    return await proxy_request(request, request.state.user["id"])


# Added last so it wraps outermost and runs before require_login above — middleware added via
# add_middleware() wraps whatever was already registered, and require_login needs
# request.session (which this middleware populates) to already exist by the time it runs.
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, session_cookie="ps_session")


if FRONTEND_DIST.is_dir():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")

if GUIDE_IMAGES_DIR.is_dir():
    app.mount("/guide/images", StaticFiles(directory=GUIDE_IMAGES_DIR), name="guide-images")

# Unlike GUIDE_IMAGES_DIR (pre-seeded before deploy), thumbnails are written by archive_publish()
# at runtime, so the directory has to exist *before* mounting rather than being mounted
# conditionally on already existing.
archive.ARCHIVE_THUMBS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/gallery-images", StaticFiles(directory=archive.ARCHIVE_THUMBS_DIR), name="gallery-images")
