"""
Python port of app/src/runInputBuilder.js's `compileInput` — text-only. The frontend version also handles
image-cell placeholders (multimodal content blocks); this port does not, since it exists for review methods
(currently just GEPA) that call the LLM directly from the backend for text-only task execution. A row whose
placeholders resolve to an image cell is reported as an error by `compile_input_text`, not silently mishandled.

Faithful port of the *text* path: same placeholder syntax, same "leave `{key}` literal when unresolved"
behavior. See score_match_primitives.py's module docstring for the general parity-port contract.
"""

from __future__ import annotations

import re
from typing import Any

# Same as JS: `(?<!\{)\{([^{}]+)\}(?!\})` — a `{key}` not immediately preceded by `{` or followed by `}`,
# so `{{literal}}` (escaped) is left alone.
_PLACEHOLDER_RE = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")


def _asset_cell_kind(value: Any) -> str | None:
    if isinstance(value, dict) and isinstance(value.get("assetIds"), list):
        if value.get("kind") == "images":
            return "image"
        if value.get("kind") == "pdf":
            return "PDF"
    return None


def compile_input_text(template: str, values: dict[str, Any]) -> tuple[str, str | None]:
    """
    Substitute `{key}` placeholders in `template` from `values`. Returns (text, error) — error is set (and
    text is best-effort / possibly incomplete) when a placeholder resolves to an image/PDF cell, which this
    text-only port cannot render.
    """
    out: list[str] = []
    end = 0
    template = str(template)
    for m in _PLACEHOLDER_RE.finditer(template):
        out.append(template[end : m.start()])
        key = m.group(1)
        if key not in values:
            out.append(m.group(0))
        else:
            value = values[key]
            asset_kind = _asset_cell_kind(value)
            if asset_kind:
                return "".join(out), f'Input "{key}" is an {asset_kind}; GEPA task execution is text-only.'
            out.append("" if value is None else str(value))
        end = m.end()
    out.append(template[end:])
    return "".join(out), None
