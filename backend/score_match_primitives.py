"""
Python port of app/src/scoreMatchPrimitives.js — pure comparison primitives shared by the frontend
Score detail modal and Review's verify/optimize path.

This is a faithful, byte-for-byte-behavior port, not a rewrite: every function here must return exactly
what its JS counterpart returns, including its quirks (JS `parseFloat` accepting "12abc" as 12, `Math.round`
half-up semantics, JS's ASCII-only `\\w`). Known, deliberate divergences from the JS source (where exact
parity is impractical) are called out in comments at the point they occur — search this file for "DIVERGENCE"
before trusting a result near one of those, and prefer fixing the divergence over living with it if it turns
out to matter.

Do not "improve" behavior here independently of the JS source — if the JS side changes, port the change here
too, and vice versa. A parity test (see backend/tests or scripts/score_match_parity — check before assuming
one exists) is supposed to catch drift between the two; keep it in sync with any change to either side.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable

SCORE_GT_ROW_INDEX_COLUMN = "__score_gt_row_index__"

DEFAULT_MATCH_FLAGS: dict[str, Any] = {
    "semanticAlign": False,
    "embeddingSimilarity": False,
    "contains": False,
    "ignoreCase": False,
    "ignoreSymbols": False,
    "ignoreWhitespace": False,
    "numericMode": "exact",
    "numericAbsEpsilon": 0,
    "numericRelEpsilon": 0,
    "numericDecimalPlaces": 2,
}


def is_valid_run_output_for_score_row(r: Any, output_fields: Any = None) -> bool:
    """True when this run row should participate in Score / Review pairing and tables."""
    del output_fields
    if not r:
        return False
    row_index = r.get("row_index") if isinstance(r, dict) else getattr(r, "row_index", None)
    return isinstance(row_index, (int, float)) and not isinstance(row_index, bool) and not _is_nan(row_index)


def _is_nan(x: Any) -> bool:
    try:
        return math.isnan(x)
    except TypeError:
        return False


def _as_finite_number(x: Any) -> float | None:
    try:
        n = float(x)
    except (TypeError, ValueError):
        return None
    return n if not (math.isnan(n)) else None


def canonicalize_match_flags(f: dict[str, Any] | None) -> dict[str, Any]:
    merged = {**DEFAULT_MATCH_FLAGS, **(f if isinstance(f, dict) else {})}
    mode = merged.get("numericMode") if merged.get("numericMode") in ("exact", "abs", "rel", "decimals") else "exact"

    abs_e = _as_finite_number(merged.get("numericAbsEpsilon"))
    abs_e = abs_e if abs_e is not None and abs_e >= 0 else 0

    rel_e = _as_finite_number(merged.get("numericRelEpsilon"))
    rel_e = rel_e if rel_e is not None and rel_e >= 0 else 0

    dec = _as_finite_number(merged.get("numericDecimalPlaces"))
    dec = math.floor(dec) if dec is not None else 2
    dec = max(0, min(20, dec))

    embedding_similarity = bool(merged.get("embeddingSimilarity"))
    semantic_align = bool(merged.get("semanticAlign"))
    if embedding_similarity and semantic_align:
        semantic_align = False
    soft_string = embedding_similarity or semantic_align

    return {
        "semanticAlign": semantic_align,
        "embeddingSimilarity": embedding_similarity,
        "contains": False if soft_string else bool(merged.get("contains")),
        "ignoreCase": False if soft_string else bool(merged.get("ignoreCase")),
        "ignoreSymbols": False if soft_string else bool(merged.get("ignoreSymbols")),
        "ignoreWhitespace": False if soft_string else bool(merged.get("ignoreWhitespace")),
        "numericMode": mode,
        "numericAbsEpsilon": abs_e,
        "numericRelEpsilon": rel_e,
        "numericDecimalPlaces": dec,
    }


def get_match_flags(rule: Any) -> dict[str, Any]:
    f = rule.get("matchFlags") if isinstance(rule, dict) else getattr(rule, "matchFlags", None)
    return canonicalize_match_flags(f)


# JS `parseFloat` parses a leading numeric prefix and ignores trailing garbage (e.g. "12abc" -> 12),
# unlike Python's `float()`, which raises on any non-numeric suffix. This regex mirrors JS's grammar
# closely enough for scored data: optional sign, "Infinity", or a decimal literal with optional exponent.
_JS_PARSE_FLOAT_RE = re.compile(r"^[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")


def js_parse_float(s: str) -> float:
    """Port of JS `parseFloat`: leading-numeric-prefix parse; returns NaN (float('nan')) when no prefix matches."""
    text = (s or "").strip()
    m = _JS_PARSE_FLOAT_RE.match(text)
    if not m:
        return float("nan")
    try:
        return float(m.group(0))
    except ValueError:
        return float("nan")


def _js_is_finite(n: float) -> bool:
    """`Number.isFinite`: false for NaN and +/-Infinity."""
    return math.isfinite(n)


def _js_round(n: float) -> float:
    """`Math.round`: half rounds toward +Infinity (not Python's round-half-to-even)."""
    return math.floor(n + 0.5)


def _round_to_decimals(n: float, places: int) -> float:
    p = max(0, min(20, math.floor(places)))
    m = 10**p
    return _js_round(n * m) / m


def numeric_pair_matches(run_trimmed_str: Any, gt_trimmed_str: Any, flags: dict[str, Any]) -> bool:
    """
    Compare two trimmed string forms of numbers per numericMode (and parameters) on flags.
    If either side is not a finite number, falls back to string equality.
    """
    run_norm = "" if run_trimmed_str is None else str(run_trimmed_str).strip()
    gt_norm = "" if gt_trimmed_str is None else str(gt_trimmed_str).strip()
    run_num = js_parse_float(run_norm)
    gt_num = js_parse_float(gt_norm)
    if not _js_is_finite(run_num) or not _js_is_finite(gt_num):
        return run_norm == gt_norm

    mode = flags.get("numericMode") or "exact"
    if mode == "abs":
        eps = _as_finite_number(flags.get("numericAbsEpsilon"))
        e = eps if eps is not None and eps >= 0 else 0
        return abs(run_num - gt_num) <= e
    if mode == "rel":
        rel = _as_finite_number(flags.get("numericRelEpsilon"))
        r = rel if rel is not None and rel >= 0 else 0
        denom = max(abs(run_num), abs(gt_num), 1e-15)
        return abs(run_num - gt_num) / denom <= r
    if mode == "decimals":
        p = _as_finite_number(flags.get("numericDecimalPlaces"))
        p = math.floor(p) if p is not None else 2
        p = max(0, min(20, p))
        return _round_to_decimals(run_num, p) == _round_to_decimals(gt_num, p)
    return run_num == gt_num


# DIVERGENCE: JS `\w` is ASCII-only (`[A-Za-z0-9_]`) even with the `u` flag; Python's default `\w` on a
# `str` pattern is Unicode-aware and also matches non-ASCII letters/digits (e.g. Chinese characters).
# Using Python's default `\w` here would silently stop stripping "symbols" around CJK text where the JS
# side does strip them (JS treats CJK characters as non-word, i.e. as symbols to remove under
# `ignoreSymbols`). This ASCII-only pattern reproduces the JS behavior intentionally.
_JS_ASCII_WORD_OR_SPACE_COMPLEMENT_RE = re.compile(r"[^A-Za-z0-9_\s]")
_WHITESPACE_RUN_RE = re.compile(r"\s+")


def normalize_for_match(s: Any, flags: dict[str, Any], is_numeric: bool) -> str:
    """Port of JS `normalizeForMatch`. Numeric mode ignores flags entirely (trim only)."""
    text = "" if s is None else str(s).strip()
    if is_numeric:
        return text
    if flags.get("ignoreWhitespace"):
        text = _WHITESPACE_RUN_RE.sub(" ", text).strip()
    if flags.get("ignoreCase"):
        text = text.lower()
    if flags.get("ignoreSymbols"):
        text = _JS_ASCII_WORD_OR_SPACE_COMPLEMENT_RE.sub("", text)
        text = _WHITESPACE_RUN_RE.sub(" ", text).strip()
    return text


def migrate_legacy_match_type(match_type: str | None) -> str:
    if match_type in ("contains", "gt-contains-run"):
        return "exact"
    return match_type or "exact"


def legacy_match_type_was_contains(match_type: str | None) -> bool:
    return match_type in ("contains", "gt-contains-run")


def strings_match_contains(run_val: Any, gt_val: Any) -> bool:
    """Mutual substring match. Empty vs empty matches; one empty vs non-empty does not."""
    r = "" if run_val is None else str(run_val)
    g = "" if gt_val is None else str(gt_val)
    if len(r) == 0 and len(g) == 0:
        return True
    if len(r) == 0 or len(g) == 0:
        return False
    return g in r or r in g


_SEMANTIC_ALIGN_DICE_THRESHOLD = 0.65


def _normalize_semantic_align_input(v: Any) -> str:
    return _WHITESPACE_RUN_RE.sub(" ", ("" if v is None else str(v)).strip().lower())


def _string_char_bigrams(s: str) -> list[str]:
    # DIVERGENCE: JS iterates UTF-16 code units, so a character outside the Basic Multilingual Plane
    # (rare emoji, some CJK Extension B+ characters) counts as two "characters" there but one Unicode
    # code point here. This only affects bigram counts for such rare characters.
    if len(s) < 2:
        return []
    return [s[i : i + 2] for i in range(len(s) - 1)]


def strings_match_semantic_align(run_val: Any, gt_val: Any) -> bool:
    """Sørensen-Dice similarity on character bigrams. Not a real embedding model."""
    a = _normalize_semantic_align_input(run_val)
    b = _normalize_semantic_align_input(gt_val)
    if len(a) == 0 and len(b) == 0:
        return True
    if len(a) == 0 or len(b) == 0:
        return False
    if a == b:
        return True
    if len(a) < 2 or len(b) < 2:
        return a == b
    ba = _string_char_bigrams(a)
    bb = _string_char_bigrams(b)
    counts: dict[str, int] = {}
    for x in ba:
        counts[x] = counts.get(x, 0) + 1
    inter = 0
    for x in bb:
        c = counts.get(x, 0)
        if c > 0:
            inter += 1
            counts[x] = c - 1
    dice = (2 * inter) / (len(ba) + len(bb))
    return dice >= _SEMANTIC_ALIGN_DICE_THRESHOLD


EMBEDDING_COSINE_THRESHOLD = 0.76


def _cosine_map_key(a: str, b: str) -> str:
    """Same key shape as the JS side's `JSON.stringify([a, b])`, so a map built one way is lookupable the other."""
    return json.dumps([a, b], ensure_ascii=False)


def embedding_pair_matches(run_val_raw: Any, gt_val_raw: Any, embedding_cosine_map: dict[str, float]) -> bool:
    a = "" if run_val_raw is None else str(run_val_raw)
    b = "" if gt_val_raw is None else str(gt_val_raw)
    if len(a) == 0 and len(b) == 0:
        return True
    if len(a) == 0 or len(b) == 0:
        return False
    c = embedding_cosine_map.get(_cosine_map_key(a, b))
    if not isinstance(c, (int, float)) or not math.isfinite(c):
        return False
    return c >= EMBEDDING_COSINE_THRESHOLD


def build_embedding_cosine_map_via_local_model(pairs: list[tuple[str, str]]) -> dict[str, float]:
    """
    Backend-native equivalent of the frontend's `prefetchEmbeddingCosineMap`, which calls
    POST /api/embeddings/pair-similarities over HTTP. Running in the same process as that endpoint,
    we can call the underlying `embedding_service.compute_pair_cosine_similarities` directly.
    """
    from embedding_service import compute_pair_cosine_similarities

    unique_pairs: list[list[str]] = []
    seen: set[str] = set()
    for a, b in pairs:
        key = _cosine_map_key(a, b)
        if key in seen:
            continue
        seen.add(key)
        unique_pairs.append([a, b])
    if not unique_pairs:
        return {}
    cosines = compute_pair_cosine_similarities(unique_pairs)
    return {_cosine_map_key(a, b): c for (a, b), c in zip(unique_pairs, cosines)}
