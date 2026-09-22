"""Project-scoped immutable image/PDF references. Registration is restricted to Electron."""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import threading
import uuid

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

router = APIRouter()
_sessions = {}
_lock = threading.Lock()
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_PDF_BYTES = 50 * 1024 * 1024  # sanity ceiling, not tied to any one provider's exact limit -- a model that can't take a file this big fails clearly at the provider call instead


class Registration(BaseModel):
    root: str
    assets: dict


def create_session(root: Path, assets: dict) -> str:
    """Register a (root, assets) pair for image_ref resolution during a run. Shared by the
    HTTP endpoint below (desktop, token-gated) and project_store.py (web, same-process call —
    the project store already knows its own asset root, so there's nothing to authenticate)."""
    root = Path(root).resolve()
    session_id = str(uuid.uuid4())
    with _lock:
        _sessions[session_id] = (root, assets)
    return session_id


def detect_image_mime(data: bytes) -> str | None:
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return None


def is_animated_image(data: bytes, mime: str) -> bool:
    if mime == 'image/png':
        return b'acTL' in data
    if mime == 'image/webp':
        return b'ANIM' in data
    return False


def detect_pdf_mime(data: bytes) -> str | None:
    return 'application/pdf' if data[:5] == b'%PDF-' else None


@router.post('/api/assets/register')
def register(body: Registration, x_asset_token: str = Header(default='')):
    expected = os.environ.get('PROMPT_STUDIO_ASSET_TOKEN', '')
    if not expected or not hmac.compare_digest(x_asset_token, expected):
        raise HTTPException(403, 'Project registration requires the desktop application.')
    return {'project_session_id': create_session(body.root, body.assets)}


def _validated_asset(session_id, asset_id, max_bytes, label):
    """Resolves + integrity-checks an asset, returning (path, data)."""
    with _lock:
        session = _sessions.get(session_id)
    if not session:
        raise ValueError('Project session expired. Reopen the project or retry the run.')
    root, assets = session
    entry = assets.get(asset_id)
    if not entry:
        raise ValueError(f'{label} is not registered in this project: {asset_id}')
    target = (root / entry['path']).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError(f'{label} file is missing or outside the project: {asset_id}')
    if target.stat().st_size > max_bytes:
        raise ValueError(f'{label} exceeds the {max_bytes // (1024 * 1024)} MB application limit.')
    data = target.read_bytes()
    if 'sha256:' + hashlib.sha256(data).hexdigest() != asset_id:
        raise ValueError(f'{label} contents changed: {asset_id}. Import it again.')
    return target, data


def _asset_bytes(session_id, asset_id, max_bytes, label):
    _, data = _validated_asset(session_id, asset_id, max_bytes, label)
    return data


_MAX_BYTES_BY_KIND = {'images': MAX_IMAGE_BYTES, 'pdf': MAX_PDF_BYTES}
_LABEL_BY_KIND = {'images': 'Image', 'pdf': 'PDF'}


def resolve_asset_paths(kind, asset_ids, session_id):
    """A cell's assetIds -> real filesystem paths, for handing to code that runs on the same
    machine (Process/Score custom code) instead of embedding file bytes into its input — the
    code opens the file itself only if/when it actually needs the contents."""
    max_bytes = _MAX_BYTES_BY_KIND[kind]
    label = _LABEL_BY_KIND[kind]
    return [str(_validated_asset(session_id, asset_id, max_bytes, label)[0]) for asset_id in asset_ids]


def resolve_cell_for_code(value, session_id):
    """Recursively replaces every image/pdf cell in `value` (a row dict, a list of rows, or a
    bare cell) with a plain list of real file paths — see resolve_asset_paths. Non-asset values
    pass through unchanged. Raises if an asset cell is present but session_id is falsy."""
    if isinstance(value, dict) and value.get('kind') in ('images', 'pdf') and isinstance(value.get('assetIds'), list):
        if not session_id:
            raise ValueError('Image/PDF inputs require a project session.')
        return resolve_asset_paths(value['kind'], value['assetIds'], session_id)
    if isinstance(value, dict):
        return {k: resolve_cell_for_code(v, session_id) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_cell_for_code(v, session_id) for v in value]
    return value


def image_data_url(session_id, asset_id):
    data = _asset_bytes(session_id, asset_id, MAX_IMAGE_BYTES, 'Image')
    mime = detect_image_mime(data)
    if not mime:
        raise ValueError('Only PNG, JPEG and WebP images are supported.')
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')


def pdf_data_url(session_id, asset_id):
    data = _asset_bytes(session_id, asset_id, MAX_PDF_BYTES, 'PDF')
    if not detect_pdf_mime(data):
        raise ValueError('Only PDF files are supported.')
    return 'data:application/pdf;base64,' + base64.b64encode(data).decode('ascii')


def resolve_content(parts, session_id):
    output = []
    for part in parts:
        if part.get('type') == 'text':
            output.append({'type': 'text', 'text': str(part.get('text', ''))})
        elif part.get('type') == 'image_ref':
            output.append({'type': 'image_url', 'image_url': {'url': image_data_url(session_id, part['asset_id'])}})
        elif part.get('type') == 'pdf_ref':
            output.append({'type': 'file', 'file': {'file_data': pdf_data_url(session_id, part['asset_id']), 'format': 'application/pdf'}})
        else:
            raise ValueError('Unsupported input content block.')
    return output


def review_content(text, rows, session_id):
    parts = [{'type': 'text', 'text': text}]
    seen = set()
    for row in rows:
        row = row if isinstance(row, dict) else row.model_dump()
        for name, value in (row.get('row_input') or {}).items():
            kind = value.get('kind') if isinstance(value, dict) else None
            if kind not in ('images', 'pdf'):
                continue
            label = 'image' if kind == 'images' else 'PDF'
            for index, asset_id in enumerate(value.get('assetIds', [])):
                key = (row.get('input_row_index'), name, index, asset_id)
                if key in seen:
                    continue
                seen.add(key)
                parts.append({'type': 'text', 'text': f'\nInput row {row.get("input_row_index")}, {name}, {label} {index + 1}:\n'})
                parts.append({'type': 'pdf_ref' if kind == 'pdf' else 'image_ref', 'asset_id': asset_id})
    return resolve_content(parts, session_id) if seen else text
