"""Web project persistence.

Counterpart to app/src/projectAssets.js, which does this job for the desktop app's bundled
`.yc` files (canvas state + images embedded as base64 in one JSON file, read/written by
Electron's Node process). The web app has no local filesystem to save a `.yc` file into, so
each project instead lives as its own directory under DATA_DIR/projects/<id>/:

  projects/<id>/project.json        canvas state + asset metadata + agent session
  projects/<id>/assets/originals/*  actual image bytes, one file per sha256
  projects/<id>/history/index.json  small Run/Process history index
  projects/<id>/history/<id>.json   one result record per file

Keeping images as plain files (rather than re-embedding them as base64 inside project.json,
as the desktop format does) is what makes browser multipart upload and per-image preview cheap;
the /export/yc and /import/yc endpoints convert to and from the desktop's single-file bundle
format so a project can move between the web app and the desktop app.
"""
import base64
import hashlib
import io
import json
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from asset_store import create_session, detect_image_mime, detect_pdf_mime, is_animated_image

router = APIRouter(prefix="/api/projects", tags=["projects"])

DATA_DIR = Path(__file__).resolve().parent / "data"
PROJECTS_DIR = DATA_DIR / "projects"
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_PDF_BYTES = 50 * 1024 * 1024  # matches asset_store.py's limit
MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024  # matches hub/archive.py's cap on the same kind of upload
BUNDLE_VERSION = 1  # matches app/src/projectAssets.js's YC_EXTENSION bundle format

_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_MIME_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
_lock = threading.Lock()


def _project_path(project_id: str) -> Path:
    if not _ID_RE.match(project_id or ""):
        raise HTTPException(404, "Project not found.")
    return PROJECTS_DIR / project_id


def _project_file(project_id: str) -> Path:
    return _project_path(project_id) / "project.json"


def _assets_root(project_id: str) -> Path:
    return _project_path(project_id) / "assets"


def _history_root(project_id: str) -> Path:
    return _project_path(project_id) / "history"


def _history_record_file(project_id: str, record_id: str) -> Path:
    if not _ID_RE.fullmatch(record_id or ""):
        raise HTTPException(404, "History record not found.")
    return _history_root(project_id) / f"{record_id}.json"


def _empty_history_index() -> dict:
    return {"version": 1, "records": []}


def _history_asset_ids(value) -> set[str]:
    ids: set[str] = set()

    def visit(item):
        if isinstance(item, dict):
            if item.get("kind") in ("images", "pdf") and isinstance(item.get("assetIds"), list):
                ids.update(asset_id for asset_id in item["assetIds"] if isinstance(asset_id, str))
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return ids


def _read_history_index(project_id: str) -> dict:
    path = _history_root(project_id) / "index.json"
    try:
        index = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty_history_index()
    if not isinstance(index, dict) or index.get("version") != 1 or not isinstance(index.get("records"), list):
        raise HTTPException(409, "Project history index is invalid.")
    return index


def _read_history_bundle(project_id: str) -> dict:
    index = _read_history_index(project_id)
    records = {}
    for entry in index["records"]:
        record_id = entry.get("id") if isinstance(entry, dict) else None
        path = _history_record_file(project_id, record_id)
        try:
            records[record_id] = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise HTTPException(409, f"History record is missing: {record_id}")
    return {"index": index, "records": records}


def _write_history_bundle(project_id: str, history: dict) -> None:
    if not isinstance(history, dict):
        raise HTTPException(400, "Project history is invalid.")
    index = history.get("index") or _empty_history_index()
    records = history.get("records") or {}
    if not isinstance(index, dict) or index.get("version") != 1 or not isinstance(index.get("records"), list) or not isinstance(records, dict):
        raise HTTPException(400, "Project history is invalid.")
    for entry in index["records"]:
        record_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(record_id, str) or not isinstance(records.get(record_id), dict):
            raise HTTPException(400, "Project history record is missing or invalid.")
        if records[record_id].get("id") != record_id:
            raise HTTPException(400, "Project history record ID does not match its index.")
        _atomic_write_json(_history_record_file(project_id, record_id), records[record_id])
    _atomic_write_json(_history_root(project_id) / "index.json", index)


def _thumbnail_file(project_id: str) -> Path:
    return _project_path(project_id) / "thumbnail.png"


def _bundle_content_disposition(project_name: str) -> str:
    """Return an HTTP-safe attachment filename while preserving Unicode names for browsers."""
    source_name = str(project_name or "").strip() or "project"
    ascii_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", source_name).strip("._") or "project"
    utf8_filename = f"{source_name}.yc"
    ascii_filename = f"{ascii_stem}.yc"
    return (
        f'attachment; filename="{ascii_filename}"; '
        f"filename*=UTF-8''{quote(utf8_filename, safe='')}"
    )


def _atomic_write_json(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def _read_project(project_id: str) -> dict:
    try:
        return json.loads(_project_file(project_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "Project not found.")


def _read_asset_bytes(project_id: str, asset: dict, asset_id: str) -> bytes:
    root = _assets_root(project_id)
    target = (root / asset["path"]).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        raise HTTPException(404, f"Asset file is missing: {asset.get('name', asset_id)}")
    data = target.read_bytes()
    if "sha256:" + hashlib.sha256(data).hexdigest() != asset_id:
        raise HTTPException(409, f"Asset changed: {asset.get('name', asset_id)}")
    return data


class ProjectCreate(BaseModel):
    name: str = "Untitled Project"


class ProjectSave(BaseModel):
    state: dict[str, Any]


class ProjectRename(BaseModel):
    name: str


class RunRecordsSave(BaseModel):
    # One record per Run to here (app/src/executionRecords.js), newest last.
    records: list[dict[str, Any]] = []


class AgentConversationsSave(BaseModel):
    # 2 = tool-calling Agent messages (see app/src/agentWindowModal.js); absent on older saves.
    format_version: int | None = None
    activeConversationId: str = ""
    conversations: list[dict[str, Any]] = []


class HistoryRecordSave(BaseModel):
    record: dict[str, Any]


class HistoryDelete(BaseModel):
    record_id: str
    expected_ids: list[str]


def _dependent_history_ids(records: dict[str, dict], root_id: str) -> set[str]:
    if root_id not in records:
        raise HTTPException(404, "History record not found.")

    def direct_upstream_ids(record: dict) -> set[str]:
        upstream = {item for item in (record.get("sourceRecordIds") or []) if item in records}
        inputs = record.get("inputs") or {}
        if record.get("kind") == "score":
            upstream.update(item for item in (
                inputs.get("runRecordId"), inputs.get("groundTruthSourceRecordId")
            ) if item in records)
        if record.get("kind") == "review" and inputs.get("scoreRecordId") in records:
            upstream.add(inputs["scoreRecordId"])
        elif record.get("kind") == "review" and inputs.get("scoreSignature"):
            created_at = record.get("createdAt")
            candidates = [candidate for candidate in records.values()
                          if candidate.get("kind") == "score"
                          and candidate.get("signature") == inputs.get("scoreSignature")
                          and (not inputs.get("scoreNodeId") or candidate.get("nodeId") == inputs.get("scoreNodeId"))
                          and (created_at is None or candidate.get("createdAt") is None
                               or str(candidate.get("createdAt")) <= str(created_at))]
            if candidates:
                upstream.add(candidates[-1]["id"])
        return upstream

    downstream = {record_id: set() for record_id in records}
    for record_id, record in records.items():
        for upstream_id in direct_upstream_ids(record):
            downstream[upstream_id].add(record_id)

    removed = {root_id}
    queue = [root_id]
    while queue:
        for record_id in downstream[queue.pop(0)]:
            if record_id not in removed:
                removed.add(record_id)
                queue.append(record_id)
    return removed


class DatasetExport(BaseModel):
    headers: list[str]
    columnTypes: list[str] = []
    rowIds: list[Any] = []
    rows: list[list[Any]]


@router.get("")
def list_projects():
    if not PROJECTS_DIR.is_dir():
        return []
    out = []
    for entry in PROJECTS_DIR.iterdir():
        if not entry.is_dir():
            continue
        try:
            data = json.loads((entry / "project.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        meta = data.get("meta") or {}
        out.append({
            "id": entry.name,
            "name": meta.get("name") or "Untitled Project",
            "createdAt": meta.get("createdAt"),
            "updatedAt": meta.get("updatedAt"),
            "hasThumbnail": (entry / "thumbnail.png").is_file(),
        })
    out.sort(key=lambda p: p.get("updatedAt") or 0, reverse=True)
    return out


@router.post("")
def create_project(body: ProjectCreate):
    project_id = uuid.uuid4().hex
    now = time.time()
    with _lock:
        payload = {
            "meta": {"name": body.name.strip() or "Untitled Project", "createdAt": now, "updatedAt": now},
            "state": {},
            "assets": {},
            "agentSession": None,
            "runRecords": [],
        }
        _atomic_write_json(_project_file(project_id), payload)
    return {"id": project_id}


@router.get("/{project_id}")
def get_project(project_id: str):
    data = _read_project(project_id)
    state = dict(data.get("state") or {})
    state["assets"] = data.get("assets") or {}
    return {"id": project_id, "name": (data.get("meta") or {}).get("name"), "state": state}


@router.put("/{project_id}")
def save_project(project_id: str, body: ProjectSave):
    with _lock:
        data = _read_project(project_id)
        state = dict(body.state or {})
        state.pop("assets", None)
        # Mirrors projectAssets.js's save(): a state with no nodes is treated as a fresh
        # project and drops any previously tracked assets rather than keeping stale ones.
        assets = (data.get("assets") or {}) if state.get("nodes") else {}
        data["state"] = state
        data["assets"] = assets
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return {"ok": True}


@router.put("/{project_id}/name")
def rename_project(project_id: str, body: ProjectRename):
    """Renames a project without touching its canvas state. save_project() above deliberately
    writes only state/assets, so the picker needs its own endpoint to reach meta.name — the
    same blank-name fallback as create_project()."""
    with _lock:
        data = _read_project(project_id)
        meta = data.setdefault("meta", {})
        name = body.name.strip() or "Untitled Project"
        meta["name"] = name
        meta["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return {"ok": True, "name": name}


@router.put("/{project_id}/thumbnail")
async def save_thumbnail(project_id: str, file: UploadFile = File(...)):
    """Best-effort canvas screenshot the web app pushes after each autosave (see renderer.js), so
    the Hub's Profile page can show a live preview per workspace the same way the public Gallery
    shows one per published project."""
    _read_project(project_id)  # 404s if the project doesn't exist
    data = await file.read()
    if len(data) > MAX_THUMBNAIL_BYTES:
        raise HTTPException(413, "Thumbnail too large.")
    _thumbnail_file(project_id).write_bytes(data)
    return {"ok": True}


@router.get("/{project_id}/thumbnail")
def get_thumbnail(project_id: str):
    path = _thumbnail_file(project_id)
    if not path.is_file():
        raise HTTPException(404, "No thumbnail yet.")
    return Response(content=path.read_bytes(), media_type="image/png")


@router.delete("/{project_id}")
def delete_project(project_id: str):
    d = _project_path(project_id)
    if not d.is_dir():
        raise HTTPException(404, "Project not found.")
    with _lock:
        shutil.rmtree(d)
    return {"ok": True}


@router.post("/{project_id}/duplicate")
def duplicate_project(project_id: str):
    """Copies a project (canvas state + images) under a new id — a project-management action
    grouped here with delete/export/import in the picker, not a "current project" action, so it
    works on any listed project without opening it first."""
    with _lock:
        data = _read_project(project_id)
        new_id = uuid.uuid4().hex
        now = time.time()
        assets = data.get("assets") or {}
        source_root = _assets_root(project_id)
        target_root = _assets_root(new_id)
        for asset_id, asset in assets.items():
            src_file = (source_root / asset["path"]).resolve()
            if not src_file.is_relative_to(source_root.resolve()) or not src_file.is_file():
                continue
            dst_file = target_root / asset["path"]
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            dst_file.write_bytes(src_file.read_bytes())
        source_history = _history_root(project_id)
        if source_history.is_dir():
            shutil.copytree(source_history, _history_root(new_id))
        name = (data.get("meta") or {}).get("name") or "Untitled Project"
        new_data = {
            "meta": {"name": f"{name} (copy)", "createdAt": now, "updatedAt": now},
            "state": data.get("state") or {},
            "assets": assets,
            "agentSession": None,  # a fresh copy starts its own agent chat, not the source's history
            # Run records name the History records copied above, so they come along.
            "runRecords": list(data.get("runRecords") or []),
        }
        _atomic_write_json(_project_file(new_id), new_data)
    return {"id": new_id}


@router.post("/{target_id}/merge/{source_id}")
def merge_project(target_id: str, source_id: str):
    """Adds source_id's nodes, connections and images into target_id's canvas, alongside
    whatever is already there — nothing in target_id is removed or overwritten.

    Node ids are `n_<timestamp>_<random>` (see workflowCanvas.js's generateNodeId), so two
    independently created projects colliding on one is practically impossible; this relies on
    that instead of rewriting ids and every field that references one (connections, plus a
    handful of node-type-specific fields like samplerNodeId or savedFrom). Asset ids are a
    sha256 of the image bytes, so the same is true for merging the two assets dicts — a matching
    id is guaranteed to already be the same file, never a real conflict.

    The two canvases may be saved in different formats. The app brings each node to the current
    one by the fields it carries when it opens the result (app/src/canvasFormat.js).
    """
    if target_id == source_id:
        raise HTTPException(400, "Cannot merge a project into itself.")
    with _lock:
        target_data = _read_project(target_id)
        source_data = _read_project(source_id)

        target_state = dict(target_data.get("state") or {})
        source_state = dict(source_data.get("state") or {})
        target_nodes = list(target_state.get("nodes") or [])
        source_nodes = [dict(n) for n in (source_state.get("nodes") or [])]

        # Shift the incoming nodes to sit to the right of whatever's already on the canvas, so
        # they land in open space instead of stacked on top of existing ones.
        if target_nodes and source_nodes:
            target_right_edge = max((n.get("left") or 0) for n in target_nodes)
            source_left_edge = min((n.get("left") or 0) for n in source_nodes)
            offset = (target_right_edge + 400) - source_left_edge
            for node in source_nodes:
                node["left"] = (node.get("left") or 0) + offset

        target_state["nodes"] = target_nodes + source_nodes
        target_state["connections"] = list(target_state.get("connections") or []) + list(source_state.get("connections") or [])

        target_assets = dict(target_data.get("assets") or {})
        source_assets = source_data.get("assets") or {}
        source_root = _assets_root(source_id)
        target_root = _assets_root(target_id)
        for asset_id, asset in source_assets.items():
            if asset_id in target_assets:
                continue
            src_file = (source_root / asset["path"]).resolve()
            if not src_file.is_relative_to(source_root.resolve()) or not src_file.is_file():
                continue  # skip anything unreadable rather than failing the whole merge over one image
            dst_file = target_root / asset["path"]
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            if not dst_file.exists():
                dst_file.write_bytes(src_file.read_bytes())
            target_assets[asset_id] = asset

        target_data["state"] = target_state
        target_data["assets"] = target_assets
        target_history = _read_history_bundle(target_id)
        source_history = _read_history_bundle(source_id)
        merged_records = dict(target_history["records"])
        for record_id, record in source_history["records"].items():
            if record_id in merged_records and merged_records[record_id] != record:
                raise HTTPException(409, f"History record ID conflicts during merge: {record_id}")
            merged_records[record_id] = record
        merged_entries = list(target_history["index"]["records"])
        known_ids = {entry["id"] for entry in merged_entries}
        merged_entries.extend(entry for entry in source_history["index"]["records"] if entry["id"] not in known_ids)
        if merged_entries:
            _write_history_bundle(target_id, {"index": {"version": 1, "records": merged_entries}, "records": merged_records})
        known_runs = {record.get("id") for record in target_data.get("runRecords") or []}
        target_data["runRecords"] = list(target_data.get("runRecords") or []) + [
            record for record in source_data.get("runRecords") or [] if record.get("id") not in known_runs]
        target_data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(target_id), target_data)

    state = dict(target_state)
    state["assets"] = target_assets
    return {"id": target_id, "name": (target_data.get("meta") or {}).get("name"), "state": state}


@router.post("/{project_id}/assets/import")
async def import_assets(project_id: str, files: list[UploadFile] = File(...)):
    from PIL import Image

    _read_project(project_id)  # 404s if the project doesn't exist

    prepared = []
    for upload in files:
        raw = await upload.read()
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(400, f"Image must be under 30 MB: {upload.filename}")
        mime = detect_image_mime(raw)
        if not mime:
            raise HTTPException(400, f"Unsupported image: {upload.filename}. Use PNG, JPEG or WebP.")
        if is_animated_image(raw, mime):
            raise HTTPException(400, "Animated images are not supported. Import a still image.")
        try:
            with Image.open(io.BytesIO(raw)) as img:
                width, height = img.size
        except Exception:
            raise HTTPException(400, f"Cannot decode image: {upload.filename}")
        digest = hashlib.sha256(raw).hexdigest()
        prepared.append({
            "raw": raw, "digest": digest, "mime": mime, "width": width, "height": height,
            "name": upload.filename or f"{digest}.{_MIME_EXT[mime]}",
        })

    root = _assets_root(project_id)
    originals = root / "originals"
    result = []
    with _lock:
        data = _read_project(project_id)
        assets = data.get("assets") or {}
        originals.mkdir(parents=True, exist_ok=True)
        for item in prepared:
            asset_id = f"sha256:{item['digest']}"
            relative = f"originals/{item['digest']}.{_MIME_EXT[item['mime']]}"
            target = root / relative
            if not target.exists():
                target.write_bytes(item["raw"])
            record = {
                "path": relative, "name": item["name"], "mime": item["mime"],
                "bytes": len(item["raw"]), "width": item["width"], "height": item["height"],
            }
            assets[asset_id] = record
            result.append({"id": asset_id, **record})
        data["assets"] = assets
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return result


@router.post("/{project_id}/assets/import-pdfs")
async def import_pdf_assets(project_id: str, files: list[UploadFile] = File(...)):
    """Same shape as /assets/import, for PDFs (registered as attachments, not parsed)."""
    _read_project(project_id)  # 404s if the project doesn't exist

    prepared = []
    for upload in files:
        raw = await upload.read()
        if len(raw) > MAX_PDF_BYTES:
            raise HTTPException(400, f"PDF must be under {MAX_PDF_BYTES // (1024 * 1024)} MB: {upload.filename}")
        if not detect_pdf_mime(raw):
            raise HTTPException(400, f"Not a PDF: {upload.filename}")
        digest = hashlib.sha256(raw).hexdigest()
        prepared.append({
            "raw": raw, "digest": digest,
            "name": upload.filename or f"{digest}.pdf",
        })

    root = _assets_root(project_id)
    originals = root / "originals"
    result = []
    with _lock:
        data = _read_project(project_id)
        assets = data.get("assets") or {}
        originals.mkdir(parents=True, exist_ok=True)
        for item in prepared:
            asset_id = f"sha256:{item['digest']}"
            relative = f"originals/{item['digest']}.pdf"
            target = root / relative
            if not target.exists():
                target.write_bytes(item["raw"])
            record = {
                "path": relative, "name": item["name"], "mime": "application/pdf",
                "bytes": len(item["raw"]),
            }
            assets[asset_id] = record
            result.append({"id": asset_id, **record})
        data["assets"] = assets
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return result


class AssetPruneRequest(BaseModel):
    usedIds: list[str] = []
    dryRun: bool = False


@router.post("/{project_id}/assets/prune")
def prune_unused_assets(project_id: str, body: AssetPruneRequest):
    """Deletes any tracked asset not in body.usedIds — the web counterpart of
    projectAssets.js's pruneUnusedAssets(). With dryRun, only reports what would be removed."""
    used = set(body.usedIds or [])
    with _lock:
        data = _read_project(project_id)
        for entry in _read_history_index(project_id)["records"]:
            ids = entry.get("assetIds")
            if not isinstance(ids, list):
                ids = _history_asset_ids(json.loads(_history_record_file(project_id, entry["id"]).read_text(encoding="utf-8")))
            used.update(ids)
        assets = data.get("assets") or {}
        unused = {aid: a for aid, a in assets.items() if aid not in used}
        if not unused:
            return {"removed": [], "freedBytes": 0}
        if body.dryRun:
            return {
                "removed": [{"id": aid, "name": a.get("name")} for aid, a in unused.items()],
                "freedBytes": sum(a.get("bytes", 0) for a in unused.values()),
            }
        root = _assets_root(project_id)
        removed = []
        freed_bytes = 0
        for aid, asset in unused.items():
            target = (root / asset["path"]).resolve()
            if target.is_relative_to(root.resolve()) and target.is_file():
                target.unlink()
            del assets[aid]
            freed_bytes += asset.get("bytes", 0)
            removed.append({"id": aid, "name": asset.get("name")})
        data["assets"] = assets
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return {"removed": removed, "freedBytes": freed_bytes}


@router.get("/{project_id}/assets/{asset_id}/preview")
def preview_asset(project_id: str, asset_id: str, thumbnail: bool = True):
    data = _read_project(project_id)
    asset = (data.get("assets") or {}).get(asset_id)
    if not asset:
        raise HTTPException(404, "Image is not in the current project.")
    raw = _read_asset_bytes(project_id, asset, asset_id)
    if thumbnail:
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as img:
            width = min(160, img.width)
            height = max(1, round(img.height * (width / img.width)))
            img = img.convert("RGBA").resize((width, height))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
        url = f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
    else:
        url = f"data:{asset['mime']};base64,{base64.b64encode(raw).decode('ascii')}"
    return {**asset, "id": asset_id, "url": url}


@router.post("/{project_id}/assets/prepare")
def prepare_assets(project_id: str):
    data = _read_project(project_id)
    assets = data.get("assets") or {}
    if not assets:
        return {}
    return {"project_session_id": create_session(_assets_root(project_id), assets)}


@router.get("/{project_id}/run-records")
def get_run_records(project_id: str):
    return {"records": _read_project(project_id).get("runRecords") or []}


@router.put("/{project_id}/run-records")
def save_run_records(project_id: str, body: RunRecordsSave):
    with _lock:
        data = _read_project(project_id)
        data["runRecords"] = body.records
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return {"ok": True}


@router.get("/{project_id}/agent-conversations")
def get_agent_conversations(project_id: str):
    data = _read_project(project_id)
    session = data.get("agentSession")
    return session if session else {"activeConversationId": "", "conversations": []}


@router.put("/{project_id}/agent-conversations")
def save_agent_conversations(project_id: str, body: AgentConversationsSave):
    with _lock:
        data = _read_project(project_id)
        data["agentSession"] = body.model_dump()
        data.setdefault("meta", {})["updatedAt"] = time.time()
        _atomic_write_json(_project_file(project_id), data)
    return {"ok": True}


@router.get("/{project_id}/history")
def get_history_index(project_id: str):
    _read_project(project_id)
    return _read_history_index(project_id)


@router.get("/{project_id}/history/{record_id}")
def get_history_record(project_id: str, record_id: str):
    _read_project(project_id)
    try:
        return json.loads(_history_record_file(project_id, record_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise HTTPException(404, "History record not found.")


@router.put("/{project_id}/history/{record_id}")
def save_history_record(project_id: str, record_id: str, body: HistoryRecordSave):
    record = dict(body.record)
    if not _ID_RE.fullmatch(record_id or "") or record.get("id") != record_id:
        raise HTTPException(400, "History record ID is invalid.")
    if record.get("kind") not in ("run", "process", "score", "review") or record.get("status") not in ("running", "stopped", "completed", "failed"):
        raise HTTPException(400, "History record kind or status is invalid.")
    if not isinstance(record.get("nodeId"), str) or not record["nodeId"] or not isinstance(record.get("signature"), str) or not record["signature"]:
        raise HTTPException(400, "History record node or signature is missing.")
    if not isinstance(record.get("inputs"), dict):
        raise HTTPException(400, "History record inputs are invalid.")
    with _lock:
        _read_project(project_id)
        index = _read_history_index(project_id)
        path = _history_record_file(project_id, record_id)
        existing = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
        if existing:
            for key in ("id", "nodeId", "kind", "signature", "inputs"):
                if record.get(key) != existing.get(key):
                    raise HTTPException(409, "History record inputs cannot change.")
            if existing.get("status") == "completed" and existing.get("kind") in ("run", "process") and record != existing:
                raise HTTPException(409, "Completed history records cannot change.")
        elif record.get("kind") not in ("run", "process") and any(
                entry.get("nodeId") == record["nodeId"] and entry.get("signature") == record["signature"]
                for entry in index["records"]):
            raise HTTPException(409, "This input already has a history record.")
        summary = {key: record.get(key) for key in ("id", "nodeId", "kind", "signature", "status", "createdAt", "updatedAt", "summary", "sourceRecordIds")}
        summary["assetIds"] = sorted(_history_asset_ids(record))
        entries = [entry for entry in index["records"] if entry.get("id") != record_id]
        entries.append(summary)
        _atomic_write_json(path, record)
        _atomic_write_json(_history_root(project_id) / "index.json", {"version": 1, "records": entries})
    return {"ok": True}


@router.post("/{project_id}/history/delete")
def delete_history_records(project_id: str, body: HistoryDelete):
    with _lock:
        _read_project(project_id)
        bundle = _read_history_bundle(project_id)
        removed = _dependent_history_ids(bundle["records"], body.record_id)
        if removed != set(body.expected_ids) or len(body.expected_ids) != len(removed):
            raise HTTPException(409, "History changed. Review the deletion again.")
        if any(bundle["records"][id].get("status") == "running" for id in removed):
            raise HTTPException(409, "A dependent history record is running.")
        entries = [entry for entry in bundle["index"]["records"] if entry["id"] not in removed]
        _atomic_write_json(_history_root(project_id) / "index.json", {"version": 1, "records": entries})
        for record_id in removed:
            _history_record_file(project_id, record_id).unlink(missing_ok=True)
    return {"removed": sorted(removed)}


@router.post("/{project_id}/export/dataset")
def export_dataset(project_id: str, body: DatasetExport):
    data = _read_project(project_id)
    assets = data.get("assets") or {}

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        written = set()
        rows_out = []
        for row in body.rows:
            out_row = []
            for cell in row:
                kind = cell.get("kind") if isinstance(cell, dict) else None
                if kind not in ("images", "pdf"):
                    out_row.append("" if cell is None else str(cell))
                    continue
                folder = "images" if kind == "images" else "pdfs"
                label = "image" if kind == "images" else "PDF"
                names = []
                for asset_id in cell.get("assetIds", []):
                    asset = assets.get(asset_id)
                    if not asset:
                        raise HTTPException(400, f"Missing {label}: {asset_id}")
                    arcname = f"{folder}/{Path(asset['path']).name}"
                    if arcname not in written:
                        zf.writestr(arcname, _read_asset_bytes(project_id, asset, asset_id))
                        written.add(arcname)
                    names.append(arcname)
                out_row.append(json.dumps(names))
            rows_out.append(out_row)

        def csv_field(value):
            return '"' + str(value).replace('"', '""') + '"'

        csv_lines = [",".join(csv_field(v) for v in body.headers)]
        csv_lines += [",".join(csv_field(v) for v in row) for row in rows_out]
        zf.writestr("dataset.csv", "﻿" + "\r\n".join(csv_lines))
        zf.writestr("dataset.schema.json", json.dumps(
            {"headers": body.headers, "columnTypes": body.columnTypes}, indent=2))

    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip", headers={
        "Content-Disposition": 'attachment; filename="dataset.zip"',
    })


@router.get("/{project_id}/export/yc")
def export_yc(project_id: str):
    data = _read_project(project_id)
    assets = data.get("assets") or {}
    asset_blobs = {
        asset_id: base64.b64encode(_read_asset_bytes(project_id, asset, asset_id)).decode("ascii")
        for asset_id, asset in assets.items()
    }
    payload = {
        "bundleVersion": BUNDLE_VERSION,
        "project": {**(data.get("state") or {}), "schemaVersion": 2, "assets": assets},
        "assetBlobs": asset_blobs,
        "agentSession": data.get("agentSession"),
        "runRecords": data.get("runRecords") or [],
        "history": _read_history_bundle(project_id),
    }
    name = (data.get("meta") or {}).get("name") or "project"
    body = json.dumps(payload, indent=2).encode("utf-8")
    return Response(content=body, media_type="application/json", headers={
        "Content-Disposition": _bundle_content_disposition(name),
    })


@router.post("/import/yc")
async def import_yc(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(400, "Not a valid project file.")
    if not isinstance(payload, dict) or payload.get("bundleVersion") != BUNDLE_VERSION or not isinstance(payload.get("project"), dict):
        raise HTTPException(400, "Unrecognized project file format.")

    state = dict(payload["project"])
    assets = state.pop("assets", {}) or {}
    asset_blobs = payload.get("assetBlobs") or {}

    project_id = uuid.uuid4().hex
    root = _assets_root(project_id)
    with _lock:
        (root / "originals").mkdir(parents=True, exist_ok=True)
        for asset_id, asset in assets.items():
            encoded = asset_blobs.get(asset_id)
            if not encoded:
                raise HTTPException(400, f"Missing bundled image data: {asset.get('name', asset_id)}")
            target = root / asset["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(encoded))
        now = time.time()
        name = Path(file.filename or "Imported Project").stem
        data = {
            "meta": {"name": name, "createdAt": now, "updatedAt": now},
            "state": state,
            "assets": assets,
            "agentSession": payload.get("agentSession"),
            "runRecords": payload.get("runRecords") if isinstance(payload.get("runRecords"), list) else [],
        }
        _atomic_write_json(_project_file(project_id), data)
        if payload.get("history"):
            _write_history_bundle(project_id, payload["history"])
    return {"id": project_id}
