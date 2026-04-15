"""Append compositional finetune inspect logs to backend/data/compositional_finetune_inspect/{run_id}.md"""

from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from pathlib import Path

_INSPECT_ROOT = Path(__file__).resolve().parent / "data" / "compositional_finetune_inspect"
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _fs_safe_run_id(run_id: str) -> str:
    s = (run_id or "").strip()
    if not s:
        return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_utc")
    s = re.sub(r"[^\w.\-]+", "_", s, flags=re.ASCII)
    return s[:160] if len(s) > 160 else s


def _path_for(run_id: str) -> Path:
    _INSPECT_ROOT.mkdir(parents=True, exist_ok=True)
    return _INSPECT_ROOT / f"{_fs_safe_run_id(run_id)}.md"


def _lock_for(run_id: str) -> threading.Lock:
    key = _fs_safe_run_id(run_id)
    with _locks_guard:
        if key not in _locks:
            _locks[key] = threading.Lock()
        return _locks[key]


def _utc_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _fence(s: str) -> str:
    return f"```text\n{(s or '').rstrip()}\n```\n"


def inspect_write_segments(
    run_id: str,
    *,
    old_sentence: str,
    new_sentence: str,
    improvement_rationale: str,
    segments: list[str],
) -> Path:
    """Create/overwrite opening section for a run (first step)."""
    path = _path_for(run_id)
    lines = [
        "# Compositional finetune — inspect log\n",
        f"- **Run id:** `{_fs_safe_run_id(run_id)}`\n",
        f"- **Written:** {_utc_ts()}\n",
        "\n## Improvement rationale\n\n",
        _fence(improvement_rationale),
        "\n## Original sentence (span)\n\n",
        _fence(old_sentence),
        "\n## Improved sentence (full, before split)\n\n",
        _fence(new_sentence),
        "\n## Segments after split\n\n",
    ]
    for i, seg in enumerate(segments):
        lines.append(f"### Segment [{i}] ({len(seg)} chars)\n\n")
        lines.append(_fence(seg))
    with _lock_for(run_id):
        path.write_text("".join(lines), encoding="utf-8")
    return path


def inspect_append_segment_candidates(
    run_id: str,
    *,
    segment_index: int,
    prefix: str,
    suffix: str,
    segment_text: str,
    candidates: list[str],
) -> None:
    path = _path_for(run_id)
    parts = [
        f"\n## Segment [{segment_index}] — rewrite candidates *({_utc_ts()})*\n\n",
        "### Context\n\n",
        f"**Prefix** ({len(prefix)} chars):\n\n",
        _fence(prefix),
        f"\n**Suffix** ({len(suffix)} chars):\n\n",
        _fence(suffix),
        f"\n**Focus fragment** ({len(segment_text)} chars):\n\n",
        _fence(segment_text),
        "\n### Candidate list\n\n",
    ]
    for j, c in enumerate(candidates):
        parts.append(f"#### Arm [{segment_index}][{j}] ({len(c)} chars)\n\n")
        parts.append(_fence(c))
    with _lock_for(run_id):
        with path.open("a", encoding="utf-8") as f:
            f.write("".join(parts))


def inspect_append_lattice(run_id: str, *, segments: list[str], lattice: list[list[str]]) -> None:
    path = _path_for(run_id)
    lines = [f"\n## Lattice summary (all arms) *({_utc_ts()})*\n\n"]
    for i, row in enumerate(lattice):
        seg = segments[i] if i < len(segments) else ""
        lines.append(f"### Segment {i} — base ({len(seg)} chars) — {len(row)} arms\n\n")
        lines.append(_fence(seg))
        for j, c in enumerate(row):
            lines.append(f"**[{i}][{j}]** ({len(c)} chars)\n\n")
            lines.append(_fence(c))
    with _lock_for(run_id):
        with path.open("a", encoding="utf-8") as f:
            f.write("".join(lines))


def inspect_append_trial(
    run_id: str,
    *,
    round_n: int,
    picks: list[int],
    composed_preview: str,
    pass_rate: float | None,
    ok: bool,
    note: str | None = None,
) -> None:
    path = _path_for(run_id)
    pr = "n/a" if pass_rate is None else f"{float(pass_rate):.4f}"
    parts = [
        f"\n### Thompson trial {round_n} *({_utc_ts()})*\n\n",
        f"- picks: `{list(picks)}`\n",
        f"- pass_rate: `{pr}`\n",
        f"- ok: `{ok}`\n",
    ]
    if note:
        parts.append(f"- note: `{note}`\n")
    parts.append("\n**Composed preview:**\n\n")
    parts.append(_fence(composed_preview))
    with _lock_for(run_id):
        with path.open("a", encoding="utf-8") as f:
            f.write("".join(parts))
