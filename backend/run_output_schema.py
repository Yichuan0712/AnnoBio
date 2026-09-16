"""
Build a Pydantic structured-output model from the app's `output_schema` shape, and decide whether an
LLM's structured response is "empty" (used by the Run job worker, and by any review method that needs to
execute a candidate prompt through the LLM the same way — e.g. GEPA's task-model calls in review_gepa.py).

Extracted from main.py so a review method can reuse this without importing from main.py (main.py imports
review methods, not the other way around — keep it one-directional).
"""

from __future__ import annotations

from typing import Any, List, Optional
import re

from pydantic import BaseModel, Field, create_model


def sanitize_field_name(key: str) -> str:
    """Turn schema key into valid Pydantic field name (alphanumeric + underscore)."""
    s = re.sub(r"[^\w]", "_", str(key).strip())
    return s or "field"


def build_output_model(fields: list[dict]) -> type[BaseModel]:
    """Build a Pydantic model from app output_schema.fields (key, type, description, allow_none)."""
    type_map = {
        "str": (str, ...),
        "float": (float, ...),
        "list_str": (list[str], ...),
        "list_float": (list[float], ...),
    }
    field_defs: dict[str, Any] = {}
    for f in fields:
        key = f.get("key") or "field"
        name = sanitize_field_name(key)
        if name in field_defs:
            n = 1
            while f"{name}_{n}" in field_defs:
                n += 1
            name = f"{name}_{n}"
        raw_type = (f.get("type") or "str").strip().lower()
        desc = (f.get("description") or "").strip() or None
        allow_none = f.get("allow_none") or f.get("allowNone") is True
        if raw_type not in type_map:
            raw_type = "str"
        typ, _ = type_map[raw_type]
        if allow_none:
            typ = Optional[typ]
            field_defs[name] = (typ, Field(default=None, description=desc or key))
        else:
            field_defs[name] = (typ, Field(..., description=desc or key))
    return create_model("StructuredOutput", **field_defs)


def build_table_output_model(row_model: type[BaseModel]) -> type[BaseModel]:
    """Build a Pydantic model with one field 'rows': list[row_model] for return_shape=table."""
    return create_model("TableOutput", rows=(List[row_model], Field(default_factory=list)))


def run_field_value_non_empty(v: object) -> bool:
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, list):
        return any(run_field_value_non_empty(x) for x in v)
    if isinstance(v, dict):
        return bool(v) and any(run_field_value_non_empty(x) for x in v.values())
    return True


def run_structured_output_is_empty(out: object, return_shape: str, output_fields: list[dict]) -> bool:
    """True if model returned no substantive values for schema fields (used when persisting run rows, not Score filtering)."""
    keys = [str(f.get("key") or "").strip() for f in (output_fields or []) if f.get("key")]
    if return_shape == "table":
        if not isinstance(out, list) or len(out) == 0:
            return True
        for row in out:
            if not isinstance(row, dict):
                continue
            if keys:
                if any(run_field_value_non_empty(row.get(k)) for k in keys):
                    return False
            elif any(run_field_value_non_empty(v) for v in row.values()):
                return False
        return True
    if not isinstance(out, dict):
        return True
    if keys:
        return not any(run_field_value_non_empty(out.get(k)) for k in keys)
    return not any(run_field_value_non_empty(v) for v in out.values())
