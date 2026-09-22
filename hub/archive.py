"""Public Archive: publish a project from your own container as a shareable read-only listing,
and copy ("add to my account") someone else's published project into your own container.

Storage lives under DATA_DIR/archive (bundle JSON, same .yc shape project_store.py's export/yc
produces) and DATA_DIR/archive_thumbs (a PNG captured client-side when publishing) — a new,
Hub-owned store, separate from every user's own per-container project data, since the whole point
is for it to be readable by everyone rather than isolated to one user's container/volume.
"""
import uuid
from pathlib import Path

import httpx

import containers
import db

DATA_DIR = Path(__file__).resolve().parent / "data"
ARCHIVE_DIR = DATA_DIR / "archive"
ARCHIVE_THUMBS_DIR = DATA_DIR / "archive_thumbs"

MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024


async def fetch_project_bundle(user_id: int, project_id: str) -> bytes:
    """Pulls a .yc export straight from the publishing user's own container — same call proxy.py
    would make for a browser request, just made directly since this is a Hub-initiated fetch."""
    name = containers.ensure_running(user_id)
    db.touch_container(user_id)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.get(f"http://{name}:{containers.BACKEND_PORT}/api/projects/{project_id}/export/yc")
    if resp.status_code != 200:
        raise ValueError("Could not export that project — make sure it still exists.")
    return resp.content


async def import_bundle_into_container(user_id: int, bundle_bytes: bytes, filename: str) -> str:
    """Copies a stored bundle into the requesting user's own container via the same import/yc
    endpoint the web project picker's "Import .yc file" button uses — always mints a brand new
    project id, so this is exactly fork/copy semantics, never an overwrite."""
    name = containers.ensure_running(user_id)
    db.touch_container(user_id)
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"http://{name}:{containers.BACKEND_PORT}/api/projects/import/yc",
            files={"file": (filename, bundle_bytes, "application/json")},
        )
    if resp.status_code != 200:
        raise ValueError("Could not add that project to your account.")
    return resp.json()["id"]


def save_bundle(bundle_bytes: bytes) -> str:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    rel = f"{uuid.uuid4().hex}.yc.json"
    (ARCHIVE_DIR / rel).write_bytes(bundle_bytes)
    return rel


def save_thumbnail(thumbnail_bytes: bytes) -> str:
    ARCHIVE_THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    rel = f"{uuid.uuid4().hex}.png"
    (ARCHIVE_THUMBS_DIR / rel).write_bytes(thumbnail_bytes)
    return rel


def read_bundle(bundle_path: str) -> bytes:
    return (ARCHIVE_DIR / bundle_path).read_bytes()


def delete_files(item: dict) -> None:
    """Removes a rejected/deleted item's stored bundle and thumbnail — called by main.py's admin
    delete route right after db.delete_archive_item drops the row. Missing files are fine (a
    thumbnail is optional in the first place)."""
    for key, root in (("bundle_path", ARCHIVE_DIR), ("thumbnail_path", ARCHIVE_THUMBS_DIR)):
        rel = item.get(key)
        if rel:
            (root / rel).unlink(missing_ok=True)
