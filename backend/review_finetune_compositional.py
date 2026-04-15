"""
Reason-guided compositional finetune: split improved sentence into substrings, per-segment candidates via LLM; search is done in the app (Thompson-style updates).
"""

from __future__ import annotations

import json
import logging
from llm import _extract_json_array_from_text, _extract_json_from_text, chat as llm_chat
from safe_stdio import safe_print as _finetune_print

logger = logging.getLogger(__name__)


def _term_preview(s: str, max_len: int = 140) -> str:
    t = (s or "").replace("\r\n", "\n").strip()
    if len(t) <= max_len:
        return t
    return t[: max_len - 1] + "…"


def _clip(s: str, n: int) -> str:
    t = (s or "").strip()
    if len(t) <= n:
        return t
    return t[: n - 1] + "…"


def compositional_finetune_segments(
    *,
    provider: str,
    model: str,
    api_key: str,
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

    prompt = f"""You split ONE improved prompt sentence into contiguous parts for localized rewriting later.

Original sentence in the prompt template (context only):
---
{_clip(old_sentence, 2000)}
---

Improved replacement sentence (split THIS string only — each part must be copied exactly from it; concatenating parts with no extra characters must equal the full improved sentence):
---
{_clip(new_sentence, 8000)}
---

Improvement rationale (what this change fixes — split on phrase boundaries that align with this intent):
---
{_clip(improvement_rationale, 4000)}
---

Task: Split the improved sentence into between 1 and {ms} contiguous substrings in order, so that concatenating them reproduces the improved sentence exactly (character-for-character as a join with no inserted separators).

Return ONLY valid JSON: {{"segments": ["...", "..."]}}
Rules:
- 1 segment is allowed only if the sentence is short or cannot be split naturally.
- Prefer 2–4 segments for longer sentences.
- No markdown, no keys other than "segments"."""

    try:
        text = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=min(4096, int(max_tokens or 8192)),
        )
        raw = _extract_json_from_text(text)
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        logger.warning("compositional segments JSON parse failed: %s", e)
        return [new_sentence]

    if not isinstance(data, dict):
        return [new_sentence]
    segs = data.get("segments")
    if not isinstance(segs, list) or not segs:
        return [new_sentence]

    parts: list[str] = []
    for x in segs:
        s = str(x).strip() if x is not None else ""
        if s:
            parts.append(s)

    if not parts:
        return [new_sentence]

    joined = "".join(parts)
    if joined != new_sentence:
        logger.warning("compositional segments join mismatch; fallback to single segment")
        return [new_sentence]

    if len(parts) > ms:
        merged: list[str] = []
        chunk_size = (len(parts) + ms - 1) // ms
        i = 0
        while i < len(parts):
            merged.append("".join(parts[i : i + chunk_size]))
            i += chunk_size
        parts = merged

    _finetune_print("[compositional finetune] --- sentence split ---")
    _finetune_print(f"[compositional finetune] full improved sentence ({len(new_sentence)} chars): {_term_preview(new_sentence, 200)!r}")
    for i, p in enumerate(parts):
        _finetune_print(f"[compositional finetune]   segment[{i}] ({len(p)} chars): {_term_preview(p, 160)!r}")
    _finetune_print(f"[compositional finetune] --- end split ({len(parts)} segments) ---")

    return parts


def compositional_finetune_segment_candidates(
    *,
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
    old_sentence: str,
    new_sentence: str,
    improvement_rationale: str,
    segment_text: str,
    prefix: str,
    suffix: str,
    num_candidates: int = 4,
) -> list[str]:
    new_sentence = (new_sentence or "").strip()
    seg = (segment_text or "").strip()
    pfx = prefix or ""
    sfx = suffix or ""
    if not new_sentence or not seg:
        return [seg]
    if pfx + seg + sfx != new_sentence:
        logger.warning("compositional candidates prefix/segment/suffix mismatch")
        return [seg]

    n = max(2, min(8, int(num_candidates or 4)))

    prompt = f"""You write alternative phrasings for ONE part of an improved prompt instruction.

Rationale for the overall change:
---
{_clip(improvement_rationale, 4000)}
---

Original sentence in template (context):
---
{_clip(old_sentence, 2000)}
---

Full improved sentence:
---
{_clip(new_sentence, 8000)}
---

The improved sentence is: prefix + FOCUS + suffix (all verbatim below).

Prefix (do not output this; keep compatible):
---
{pfx}
---
Suffix (do not output this; keep compatible):
---
{sfx}
---
FOCUS segment to paraphrase (produce alternatives for this piece only):
---
{seg}
---

Task: Output exactly {n} alternative strings that can replace the FOCUS segment only. Each alternative must work as a drop-in: fluent with the prefix and suffix, preserve the rationale's intent, and stay similar in tone and length unless the rationale clearly needs a shorter or clearer phrase.

Return ONLY a JSON array of {n} strings. No markdown, no commentary."""

    try:
        text = llm_chat(
            provider=provider,
            model=model,
            api_key=api_key,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=min(4096, int(max_tokens or 8192)),
        )
        raw = _extract_json_array_from_text(text)
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        logger.warning("compositional candidates JSON parse failed: %s", e)
        return [seg]

    if not isinstance(data, list):
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

    if seg.casefold() not in seen:
        out.insert(0, seg)
        seen.add(seg.casefold())

    final = out if out else [seg]
    _finetune_print("[compositional finetune] --- segment paraphrase candidates ---")
    _finetune_print(f"[compositional finetune] focus segment ({len(seg)} chars): {_term_preview(seg, 160)!r}")
    _finetune_print(f"[compositional finetune] prefix ({len(pfx)} chars): {_term_preview(pfx, 80)!r} | suffix ({len(sfx)} chars): {_term_preview(sfx, 80)!r}")
    for j, c in enumerate(final):
        _finetune_print(f"[compositional finetune]   cand[{j}]: {_term_preview(c, 160)!r}")
    _finetune_print(f"[compositional finetune] --- end candidates ({len(final)} for this segment) ---")

    return final
