"""
Reason-guided compositional optimization: split improved sentence into substrings,
per-segment candidates via LLM; Thompson-sampling search is done in the frontend.
"""

from __future__ import annotations

import json
import logging
from llm import _extract_json_array_from_text, _extract_json_from_text, chat as llm_chat
from safe_stdio import safe_print as _print

logger = logging.getLogger(__name__)


def _clip(s: str, n: int) -> str:
    t = (s or "").strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def _preview(s: str, max_len: int = 140) -> str:
    t = (s or "").replace("\r\n", "\n").strip()
    return t if len(t) <= max_len else t[: max_len - 1] + "…"


def compositional_optimization_segments(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int,
    old_sentence: str,
    new_sentence: str,
    improvement_rationale: str,
    max_segments: int = 5,
) -> list[str]:
    new_sentence = (new_sentence or "").strip()
    if not new_sentence:
        return []

    ms = max(2, min(8, int(max_segments or 5)))

    prompt = (
        "You split ONE improved prompt sentence into contiguous parts for localized rewriting later.\n\n"
        "Original sentence in the prompt template (context only):\n---\n"
        f"{_clip(old_sentence, 2000)}\n---\n\n"
        "Improved replacement sentence (split THIS string only — each part must be copied exactly from it; "
        "concatenating parts with no extra characters must equal the full improved sentence):\n---\n"
        f"{_clip(new_sentence, 8000)}\n---\n\n"
        "Improvement rationale (what this change fixes — split on phrase boundaries that align with this intent):\n---\n"
        f"{_clip(improvement_rationale, 4000)}\n---\n\n"
        f"Task: Split the improved sentence into between 1 and {ms} contiguous substrings in order, "
        "so that concatenating them reproduces the improved sentence exactly (character-for-character as a join with no inserted separators).\n\n"
        'Return ONLY valid JSON: {"segments": ["...", "..."]}\n'
        "Rules:\n"
        "- 1 segment is allowed only if the sentence is short or cannot be split naturally.\n"
        f"- Prefer 2–{ms} segments for longer sentences.\n"
        '- No markdown, no keys other than "segments".'
    )

    _print(f"\n[Optimization] ── STEP 1: Split sentence ({len(new_sentence)} chars) ────────────────")
    _print(f"[Optimization]   model: {model}")
    _print(f"[Optimization]   sentence: {new_sentence!r}")
    _print(f"[Optimization] ── LLM response ────────────────────────────────────────")

    try:
        text = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=min(4096, int(max_tokens or 8192)),
        )
        for line in (text or "").splitlines():
            _print(f"[Optimization]   {line}")
        raw = _extract_json_from_text(text)
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        _print(f"[Optimization] ✘ JSON parse failed: {e}  → fallback to single segment")
        logger.warning("compositional optimization segments JSON parse failed: %s", e)
        return [new_sentence]

    if not isinstance(data, dict):
        _print(f"[Optimization] ✘ unexpected data type {type(data)}  → fallback")
        return [new_sentence]
    segs = data.get("segments")
    if not isinstance(segs, list) or not segs:
        _print("[Optimization] ✘ no 'segments' list in response  → fallback")
        return [new_sentence]

    parts: list[str] = []
    for x in segs:
        s = str(x).strip() if x is not None else ""
        if s:
            parts.append(s)

    if not parts:
        _print("[Optimization] ✘ all segments empty  → fallback")
        return [new_sentence]

    # Log concat status (informational only — we trust the LLM split)
    joined = "".join(parts)
    if joined != new_sentence:
        _print(f"[Optimization] ⚠ concat differs from original (likely punctuation/encoding diff); continuing with LLM split")

    # Cap at max_segments by merging chunks
    if len(parts) > ms:
        merged: list[str] = []
        chunk = (len(parts) + ms - 1) // ms
        i = 0
        while i < len(parts):
            merged.append("".join(parts[i : i + chunk]))
            i += chunk
        parts = merged

    _print(f"[Optimization] ── {len(parts)} segment(s) ────────────────────────────────────────")
    for i, p in enumerate(parts):
        _print(f"[Optimization]   [{i}] {p!r}")
    _print("")

    return parts


def compositional_optimization_segment_candidates(
    *,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    max_tokens: int,
    old_sentence: str,
    new_sentence: str,
    improvement_rationale: str,
    segment_text: str,
    prefix: str,
    suffix: str,
    prompt_context: str = "",
    num_candidates: int = 4,
    segment_index: int = 0,
    total_segments: int = 1,
) -> list[str]:
    new_sentence = (new_sentence or "").strip()
    seg = (segment_text or "").strip()
    pfx = prefix or ""
    sfx = suffix or ""
    if not new_sentence or not seg:
        return [seg]

    n = max(2, min(8, int(num_candidates or 4)))

    context_block = (
        "The prompt paragraph that contains the sentence being changed (read-only context — do NOT output this):\n---\n"
        f"{_clip(prompt_context, 6000)}\n---\n\n"
    ) if (prompt_context or "").strip() else ""

    prompt = (
        "You write alternative phrasings for ONE part of an improved prompt instruction.\n\n"
        "Rationale for the overall change:\n---\n"
        f"{_clip(improvement_rationale, 4000)}\n---\n\n"
        f"{context_block}"
        "Original sentence being replaced (the sentence inside the paragraph above that is being improved):\n---\n"
        f"{_clip(old_sentence, 2000)}\n---\n\n"
        "Full improved replacement sentence:\n---\n"
        f"{_clip(new_sentence, 8000)}\n---\n\n"
        "The improved sentence is split as: prefix + FOCUS + suffix (all verbatim below).\n\n"
        f"Prefix (do not output; keep compatible):\n---\n{pfx}\n---\n"
        f"Suffix (do not output; keep compatible):\n---\n{sfx}\n---\n"
        f"FOCUS segment to paraphrase (produce alternatives for this piece only):\n---\n{seg}\n---\n\n"
        f"Task: Output exactly {n} alternative strings that can replace the FOCUS segment only. "
        "Each alternative must fit in the paragraph context, be fluent with the prefix and suffix, "
        "preserve the rationale's intent, and stay similar in tone and length unless the rationale needs a shorter or clearer phrase.\n\n"
        f"Return ONLY a JSON array of {n} strings. No markdown, no commentary."
    )

    _print(f"\n[Optimization] ── STEP 2: Candidates for segment [{segment_index}/{total_segments - 1}] ────────────")
    _print(f"[Optimization]   focus: {seg!r}")
    _print(f"[Optimization] ── LLM response ────────────────────────────────────────")

    try:
        text = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            base_url=base_url,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=min(4096, int(max_tokens or 8192)),
        )
        for line in (text or "").splitlines():
            _print(f"[Optimization]   {line}")
        raw = _extract_json_array_from_text(text)
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        _print(f"[Optimization] ✘ JSON parse failed: {e}  → fallback to original segment")
        logger.warning("compositional optimization candidates JSON parse failed: %s", e)
        return [seg]

    if not isinstance(data, list):
        _print(f"[Optimization] ✘ unexpected type {type(data)}  → fallback")
        return [seg]

    out: list[str] = []
    seen: set[str] = set()
    for x in data:
        s = str(x).strip() if x is not None else ""
        if not s:
            continue
        key = s.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= n:
            break

    # Always include original segment
    if seg.casefold() not in seen:
        out.insert(0, seg)

    final = out if out else [seg]

    _print(f"[Optimization] ── {len(final)} candidate(s) ───────────────────────────────────────")
    for j, c in enumerate(final):
        orig_marker = "  ← original" if c == seg else ""
        _print(f"[Optimization]   [{j}] {c!r}{orig_marker}")
    _print("")

    return final
