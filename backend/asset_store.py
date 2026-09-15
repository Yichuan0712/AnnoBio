"""Project-scoped immutable image references. Registration is restricted to Electron."""
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


class Registration(BaseModel):
    root: str
    assets: dict


@router.post('/api/assets/register')
def register(body: Registration, x_asset_token: str = Header(default='')):
    expected = os.environ.get('PROMPT_STUDIO_ASSET_TOKEN', '')
    if not expected or not hmac.compare_digest(x_asset_token, expected):
        raise HTTPException(403, 'Project registration requires the desktop application.')
    root = Path(body.root).resolve()
    session_id = str(uuid.uuid4())
    with _lock:
        _sessions[session_id] = (root, body.assets)
    return {'project_session_id': session_id}


def image_data_url(session_id, asset_id):
    with _lock:
        session = _sessions.get(session_id)
    if not session:
        raise ValueError('Image project session expired. Reopen the project or retry the run.')
    root, assets = session
    entry = assets.get(asset_id)
    if not entry:
        raise ValueError(f'Image is not registered in this project: {asset_id}')
    target = (root / entry['path']).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError(f'Image file is missing or outside the project: {asset_id}')
    if target.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError('Image exceeds the 30 MB application limit.')
    data = target.read_bytes()
    if 'sha256:' + hashlib.sha256(data).hexdigest() != asset_id:
        raise ValueError(f'Image contents changed: {asset_id}. Import it as a new image.')
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif data.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        raise ValueError('Only PNG, JPEG and WebP images are supported.')
    return f'data:{mime};base64,' + base64.b64encode(data).decode('ascii')


def resolve_content(parts, session_id):
    output = []
    for part in parts:
        if part.get('type') == 'text':
            output.append({'type': 'text', 'text': str(part.get('text', ''))})
        elif part.get('type') == 'image_ref':
            output.append({'type': 'image_url', 'image_url': {'url': image_data_url(session_id, part['asset_id'])}})
        else:
            raise ValueError('Unsupported input content block.')
    return output


def review_content(text, rows, session_id):
    parts = [{'type': 'text', 'text': text}]
    seen = set()
    for row in rows:
        row = row if isinstance(row, dict) else row.model_dump()
        for name, value in (row.get('row_input') or {}).items():
            if not isinstance(value, dict) or value.get('kind') != 'images':
                continue
            for index, asset_id in enumerate(value.get('assetIds', [])):
                key = (row.get('input_row_index'), name, index, asset_id)
                if key in seen:
                    continue
                seen.add(key)
                parts.append({'type': 'text', 'text': f'\nInput row {row.get("input_row_index")}, {name}, image {index + 1}:\n'})
                parts.append({'type': 'image_ref', 'asset_id': asset_id})
    return resolve_content(parts, session_id) if seen else text
