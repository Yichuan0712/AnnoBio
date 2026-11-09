"""Standalone snapshot of the original backend prompt-span resolver.

Copied from backend/review_pipeline.py; no runtime import of the application.
Only change: lazy optional RapidFuzz import. Exactish, truncation extension,
Markdown/typographic prefix matching and uniqueness rules are retained.
"""
from __future__ import annotations

import re

_MD_NUMBERED_ITEM_START = re.compile(r"\s*\d+\.\s")

def _normalize_typographic_quotes(s: str) -> str:
    return (
        (s or "")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
    )


def _build_nc_and_ranges(content: str) -> tuple[str, list[tuple[int, int]]]:
    nc_parts: list[str] = []
    ranges: list[tuple[int, int]] = []
    j = 0
    while j < len(content):
        if content.startswith("\r\n", j):
            nc_parts.append("\n")
            ranges.append((j, j + 2))
            j += 2
        elif content[j] == "\r":
            nc_parts.append("\n")
            ranges.append((j, j + 1))
            j += 1
        else:
            nc_parts.append(content[j])
            ranges.append((j, j + 1))
            j += 1
    return "".join(nc_parts), ranges


def _span_from_nc_match(content: str, old_normalized: str) -> str | None:
    if not old_normalized:
        return None
    nc, ranges = _build_nc_and_ranges(content)
    pos = nc.find(old_normalized)
    if pos < 0:
        return None
    end_pos = pos + len(old_normalized) - 1
    if end_pos >= len(ranges):
        return None
    start = ranges[pos][0]
    end = ranges[end_pos][1]
    return content[start:end]


def _loose_match_key_and_starts(text: str) -> tuple[str, list[int]]:
    """
    Build a comparison key from `text` and map each key index to the start index in `text`.

    Strips Markdown ``**``, normalizes newlines (``\\r\\n`` / ``\\r`` → ``\\n``), curly quotes → ASCII,
    unicode dashes → ``-``. Same rules apply to the prompt text and to Phase 2 ``old_sentence``.
    """
    src = text or ""
    key_chars: list[str] = []
    starts: list[int] = []
    i = 0
    while i < len(src):
        if src.startswith("**", i):
            i += 2
            continue
        if src.startswith("\r\n", i):
            key_chars.append("\n")
            starts.append(i)
            i += 2
            continue
        if src[i] == "\r":
            key_chars.append("\n")
            starts.append(i)
            i += 1
            continue
        ch = src[i]
        if ch in ("\u201c", "\u201d"):
            ch = '"'
        elif ch in ("\u2018", "\u2019"):
            ch = "'"
        elif ch in ("\u2013", "\u2014", "\u2212"):
            ch = "-"
        key_chars.append(ch)
        starts.append(i)
        i += 1
    return "".join(key_chars), starts


def _expand_span_to_logical_end(content: str, start: int, end: int, max_expand: int = 12000) -> int:
    """
    Extend ``end`` forward so truncated fuzzy matches cover the rest of a list item / paragraph.

    Stops at blank line (``\\n\\n``) or a new top-level numbered line (``\\n`` + optional ws + ``digits.``).
    """
    n = len(content)
    if end >= n:
        return end
    limit = min(n, end + max(400, max_expand))
    pos = end
    while pos < limit:
        if pos + 1 < n and content[pos : pos + 2] == "\n\n":
            return pos
        if content[pos] == "\n" and _MD_NUMBERED_ITEM_START.match(content, pos + 1):
            return pos
        pos += 1
    return limit


def _slice_with_truncation_extension(content: str, d0: int, d1: int, old: str, score: float) -> str:
    """Return ``content[d0:d1]``, optionally extending ``d1`` when ``old`` looks truncated or ends mid-token."""
    ost = old.strip()
    if d0 < 0 or d1 > len(content) or d0 >= d1 or not ost:
        return content[d0:d1] if d0 >= 0 and d1 <= len(content) and d0 < d1 else ""
    extend = False
    if d1 < len(content):
        span_len = d1 - d0
        if score >= 85.0 and span_len < len(ost) - 1:
            extend = True
        elif content[d1].isalnum() and ost[-1].isalnum():
            extend = True
        elif len(ost) >= 28 and ost[-1] not in ".!?:\n\r" and content[d1] not in "\n\r":
            extend = True
    if extend:
        d1 = _expand_span_to_logical_end(content, d0, d1)
    return content[d0:d1]


def _resolve_old_sentence_span_exactish(content: str, old_sentence: str) -> str | None:
    """Cheap path before ``rapidfuzz``: substring, typographic quotes, 1:1 normalized index, newline-normalized slice."""
    o = old_sentence or ""
    if not o.strip():
        return None

    def _span(needle: str) -> str | None:
        i = content.find(needle)
        return content[i : i + len(needle)] if i >= 0 else None

    hit = _span(o)
    if hit is not None:
        return hit
    oq = _normalize_typographic_quotes(o)
    hit = _span(oq)
    if hit is not None:
        return hit
    cq = _normalize_typographic_quotes(content)
    if len(cq) == len(content) and oq in cq:
        i = cq.find(oq)
        if i >= 0:
            return content[i : i + len(oq)]
    span = _span_from_nc_match(content, oq.replace("\r\n", "\n").replace("\r", "\n"))
    return span


def _resolve_old_sentence_span_fuzzy(content: str, old_sentence: str) -> str | None:
    """``rapidfuzz.partial_ratio_alignment`` + same truncation extension as exact hits."""
    try:
        from rapidfuzz import fuzz, utils
    except ImportError:
        return None
    o = (old_sentence or "").strip()
    if not o or not content:
        return None
    align = fuzz.partial_ratio_alignment(o, content, processor=utils.default_process, score_cutoff=76.0)
    if align is None:
        return None
    d0, d1 = int(align.dest_start), int(align.dest_end)
    if d0 < 0 or d1 > len(content) or d0 >= d1:
        return None
    return _slice_with_truncation_extension(content, d0, d1, o, float(align.score))


def _resolve_old_sentence_span_unique_prefix_loose(content: str, old_sentence: str) -> str | None:
    """When fuzzy fails: longest ``old`` loose-key prefix that occurs **once** in ``content`` loose key."""
    key_c, starts_c = _loose_match_key_and_starts(content)
    key_o, _ = _loose_match_key_and_starts(old_sentence)
    if not key_o or not key_c:
        return None
    min_l = min(20, len(key_o))
    for L in range(len(key_o), min_l - 1, -1):
        pref = key_o[:L]
        pos = key_c.find(pref)
        if pos < 0:
            continue
        if key_c.find(pref, pos + 1) >= 0:
            continue
        p1 = pos + L
        if pos >= len(starts_c) or p1 > len(starts_c) or p1 <= pos:
            continue
        c0 = starts_c[pos]
        c1 = starts_c[p1 - 1] + 1
        exp = _expand_span_to_logical_end(content, c0, c1)
        return content[c0:exp]
    return None


def _resolve_old_sentence_span(prompt: str, old_sentence: str) -> str | None:
    """
    Map Phase 2 ``old_sentence`` to the verbatim substring of ``prompt`` for Accept/Revert.

    Order: cheap exactish → ``rapidfuzz`` → unique-prefix loose (markdown-tolerant).
    """
    content = prompt or ""
    o = old_sentence or ""
    if not o.strip():
        return None

    hit = _resolve_old_sentence_span_exactish(content, o)
    if hit is not None:
        i = content.find(hit)
        if i >= 0:
            return _slice_with_truncation_extension(content, i, i + len(hit), o, 100.0)
        return hit

    hit = _resolve_old_sentence_span_fuzzy(content, o)
    if hit is not None:
        return hit

    return _resolve_old_sentence_span_unique_prefix_loose(content, o)


def _resolve_old_sentence_unique(prompt: str, raw_old: str) -> str | None:
    """Return the resolved verbatim span when it occurs **exactly once** in ``prompt``; else ``None``."""
    if not (prompt or "").strip() or not (raw_old or "").strip():
        return None
    span = _resolve_old_sentence_span(prompt, raw_old)
    if not span or prompt.count(span) != 1:
        return None
    return span
