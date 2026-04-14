"""Append Run (workflow LLM) inspect logs to backend/data/run_inspect/{key}.md"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_INSPECT_ROOT = Path(__file__).resolve().parent / "data" / "run_inspect"
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _fs_safe_key(key: str) -> str:
    s = (key or "").strip()
    if not s:
        return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_utc")
    s = re.sub(r"[^\w.\-]+", "_", s, flags=re.ASCII)
    return s[:160] if len(s) > 160 else s


def _path_for(key: str) -> Path:
    _INSPECT_ROOT.mkdir(parents=True, exist_ok=True)
    return _INSPECT_ROOT / f"{_fs_safe_key(key)}.md"


def _lock_for(key: str) -> threading.Lock:
    k = _fs_safe_key(key)
    with _locks_guard:
        if k not in _locks:
            _locks[k] = threading.Lock()
        return _locks[k]


def _utc_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _fence_text(s: str) -> str:
    return f"```text\n{(s or '').rstrip()}\n```\n"


def run_inspect_begin(
    file_key: str,
    *,
    job_run_id: str,
    run_node_id: str | None,
    credential_id: str,
    provider: str,
    model: str,
    return_shape: str,
    total_rows: int,
    output_schema: dict[str, Any],
) -> Path:
    """Create / overwrite inspect file for this run."""
    path = _path_for(file_key)
    schema_json = json.dumps(output_schema, ensure_ascii=False, indent=2)
    lines = [
        "# Run — inspect log\n",
        f"- **Written:** {_utc_ts()}\n",
        f"- **Job run_id:** `{job_run_id}`\n",
    ]
    if run_node_id:
        lines.append(f"- **Run node id:** `{run_node_id}`\n")
    lines.extend(
        [
            f"- **Credential id:** `{credential_id}`\n",
            f"- **Provider / model:** `{provider}` / `{model}`\n",
            f"- **return_shape:** `{return_shape}`\n",
            f"- **Input rows (prompts):** {total_rows}\n",
            "\n## output_schema\n\n",
            f"```json\n{schema_json}\n```\n",
            "\n## Rows (prompt → structured output)\n\n",
        ]
    )
    with _lock_for(file_key):
        path.write_text("".join(lines), encoding="utf-8")
    return path


def run_inspect_append_row(
    file_key: str,
    *,
    row_index: int,
    prompt: str,
    row_items: list[dict[str, Any]],
) -> None:
    """Append one input row's final prompt and LLM result(s). row_items: {output, error} per sub-row."""
    path = _path_for(file_key)
    parts = [f"### Input row {row_index} *({_utc_ts()})*\n\n", "**Prompt:**\n\n", _fence_text(prompt)]
    if not row_items:
        parts.append("\n*(no result items)*\n\n")
    else:
        for j, it in enumerate(row_items):
            err = it.get("error")
            out = it.get("output")
            if len(row_items) > 1:
                parts.append(f"\n**Sub-output [{j}]** (same input row)\n\n")
            if err:
                parts.append("**Error:**\n\n")
                parts.append(_fence_text(str(err)))
            else:
                parts.append("**LLM output (JSON):**\n\n")
                try:
                    body = json.dumps(out, ensure_ascii=False, indent=2, default=str)
                except TypeError:
                    body = repr(out)
                parts.append(f"```json\n{body}\n```\n")
    with _lock_for(file_key):
        with path.open("a", encoding="utf-8") as f:
            f.write("".join(parts))


def run_inspect_append_note(file_key: str, *, title: str, body: str) -> None:
    path = _path_for(file_key)
    block = f"\n## {title} *({_utc_ts()})*\n\n{_fence_text(body)}"
    with _lock_for(file_key):
        with path.open("a", encoding="utf-8") as f:
            f.write(block)
