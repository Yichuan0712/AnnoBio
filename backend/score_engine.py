"""
Backend row scoring (matched / not matched) that returns exactly the verdict the app's Verify computes.

This module is a complete port of the frontend's `evaluateScoreOutputGt` (app/src/scoreOutputGtMatcher.js)
together with everything it calls: the v2 score bundle parser (scoreMappingBundle.js), the match primitives
(scoreMatchPrimitives.js), the greedy run -> ground-truth pairing and the AND/OR fold (scoreRunGtPairing.js),
and the "Match by code" client (scoreCodeRunClient.js + buildCodeMatchRunToGt in scoreDetailModal.js), whose
Python predicate runs through match_exec.run_match_pairs exactly as POST /api/score/match/run runs it.

Parity is proven by a fixture the real JavaScript writes (app/tests/scoreParityFixture.mjs ->
backend/test_fixtures/score_parity_cases.json.gz) and backend/test_score_engine.py, which must agree on every
case; app/tests/scoreParityFixture.test.mjs fails when the JavaScript no longer produces the committed fixture.
If either side changes, regenerate the fixture (`node app/tests/scoreParityFixture.mjs`) and rerun both.

Verify scores with the bundle's output tree only; the input tree (Input -> Ground truth rules) is not used there,
so it is not used here either.

Entry points
------------
* `evaluate_score_output_gt(...)` - same arguments and result as the JavaScript function (any number of
  inputs at once, the shape Verify passes), plus a per-input breakdown under "inputs".
* `score_input(...)` - one input given plainly: its input row, its run output row(s), its ground-truth rows.
* `score_inputs(inputs, ...)` - a batch of `score_input` inputs sharing one bundle / match code and one
  embedding / concept cache (what backend callers and POST /api/score/evaluate use).

Result of `evaluate_score_output_gt`::

    {
      "verifyRows": [{"output", "error", "gt", "gtNum", "matched"}, ...],  # identical to the JS result
      "matchedCount": int, "total": int,                                   # identical to the JS result
      "inputs": [{                                                         # backend-only breakdown
        "promptIndex": k, "inputIndex": inputEntries[k][0],
        "verifyRowStart": s, "verifyRowEnd": e,      # this input's slice of verifyRows
        "matchedCount": int, "total": int,
        "runRows": [{"rowIndex", "gtRowIndex", "paired", "matched", "rules"}],
        "gtRows": [{"gtRowIndex", "gtNum", "runRowIndex", "matched"}],
      }, ...],
    }

`gtRowIndex` is the 0-based row of the ground-truth table (gtNum - 1); `rules` lists the output-rule leaf
verdicts (depth-first order) for a paired run row in rules mode, else None.

Why a new module rather than the older port (score_match_primitives.py, score_run_gt_pairing.py,
score_mapping_bundle.py): that port is used by the GEPA / DSPy / TextGrad review methods, whose behaviour must
not change yet, and it differs from the JavaScript in ways that change verdicts (see the "Fixed relative to the
older port" notes next to the functions below). JavaScript value semantics are reproduced explicitly: JS
whitespace for trim and \\s, JS String() / Number() / parseFloat / Math.round, JS truthiness, UTF-16 code units
for the bigram measure and string ordering, and JS `in` on plain objects.

Known limit (not produced by the app): a run row whose `output` is a JSON *array* and a rule key naming an
Array.prototype method (e.g. "map") reads that method in JavaScript; here such a key reads nothing.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Callable, Iterable

# ---------------------------------------------------------------------------------------------------------
# JavaScript value semantics
# ---------------------------------------------------------------------------------------------------------

# ECMAScript WhiteSpace + LineTerminator: what String.prototype.trim removes and what /\s/ matches.
# Fixed relative to the older port: Python's str.strip()/\s also treat \x1c-\x1f and \x85 as whitespace and
# miss ﻿, so "a﻿" vs "a" or "a\x85" vs "a" compared differently there.
JS_WHITESPACE = (
    "\t\n\v\f\r              "
    "    　﻿"
)
_WS_CLASS = "".join("\\x{:02x}".format(ord(c)) if ord(c) < 0x100 else "\\u{:04x}".format(ord(c)) for c in JS_WHITESPACE)
_WS_RUN_RE = re.compile("[" + _WS_CLASS + "]+")
# /[^\w\s]/gu: JS \w is ASCII-only even with the u flag, so every non-ASCII letter counts as a symbol.
_NOT_WORD_OR_SPACE_RE = re.compile("[^A-Za-z0-9_" + _WS_CLASS + "]")
# parseFloat grammar (StrDecimalLiteral prefix, ASCII digits only). Fixed relative to the older port: Python's
# \d also accepts non-ASCII digits ("٣", "１"), which JS parseFloat rejects.
_PARSE_FLOAT_RE = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_NUMBER_DEC_RE = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)\Z")
_NUMBER_RADIX_RE = re.compile(r"0(?:([xX])([0-9a-fA-F]+)|([oO])([0-7]+)|([bB])([01]+))\Z")

_MISSING = object()  # JavaScript `undefined` where it differs from null

# Object.prototype members that `key in plainObject` finds on every JSON object (getRunValue uses `in`).
_OBJECT_PROTOTYPE_STRINGS = {
    "constructor": "function Object() { [native code] }",
    "__proto__": "[object Object]",
    **{
        name: "function %s() { [native code] }" % name
        for name in (
            "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "toLocaleString",
        )
    },
}


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _as_double(v: Any) -> float:
    """A JSON number as the IEEE double JavaScript holds (Python ints are exact, JS numbers are not)."""
    try:
        return float(v)
    except OverflowError:
        return math.inf if v > 0 else -math.inf


def _num_key(v: Any) -> Any:
    """Hashable key with JS SameValueZero semantics (Map keys): numbers by value, bools apart from 1/0."""
    if isinstance(v, bool):
        return ("bool", v)
    if _is_number(v):
        d = _as_double(v)
        return ("num", 0.0 if d == 0 else d)
    if v is None:
        return ("null",)
    if isinstance(v, str):
        return ("str", v)
    return ("obj", id(v))


def js_truthy(v: Any) -> bool:
    if v is None or v is False:
        return False
    if v is True:
        return True
    if _is_number(v):
        d = _as_double(v)
        return not (d == 0 or d != d)
    if isinstance(v, str):
        return len(v) > 0
    return True  # objects and arrays, even empty ones


def js_number_to_string(x: Any) -> str:
    """Number.prototype.toString() for a finite or infinite double."""
    d = _as_double(x)
    if d != d:
        return "NaN"
    if d == math.inf:
        return "Infinity"
    if d == -math.inf:
        return "-Infinity"
    if d == 0:
        return "0"
    if d < 0:
        return "-" + js_number_to_string(-d)
    # repr() gives the shortest round-tripping digits, the same digits ECMAScript Number::toString picks.
    mantissa, _, exp_part = repr(d).partition("e")
    exp = int(exp_part) if exp_part else 0
    int_part, _, frac_part = mantissa.partition(".")
    all_digits = int_part + frac_part
    stripped = all_digits.lstrip("0")
    n = len(int_part) + exp - (len(all_digits) - len(stripped))
    digits = stripped.rstrip("0")
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    if k == 1:
        return f"{digits}e{sign}{abs(e)}"
    return f"{digits[0]}.{digits[1:]}e{sign}{abs(e)}"


def js_to_string(v: Any) -> str:
    """String(v) for a JSON value (null -> "null")."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return v
    if _is_number(v):
        return js_number_to_string(v)
    if isinstance(v, list):
        return ",".join("" if item is None else js_to_string(item) for item in v)
    return "[object Object]"


def js_to_number(v: Any) -> float:
    """Number(v) for a JSON value."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if _is_number(v):
        return _as_double(v)
    if isinstance(v, (list, dict)):
        return js_to_number(js_to_string(v))
    if isinstance(v, str):
        s = js_trim(v)
        if s == "":
            return 0.0
        if _NUMBER_DEC_RE.match(s):
            return float(s)
        m = _NUMBER_RADIX_RE.match(s)
        if m:
            if m.group(1):
                return _as_double(int(m.group(2), 16))
            if m.group(3):
                return _as_double(int(m.group(4), 8))
            return _as_double(int(m.group(6), 2))
        return math.nan
    return math.nan


def js_parse_float(s: Any) -> float:
    """parseFloat(String(s))."""
    text = js_to_string(s).lstrip(JS_WHITESPACE)
    m = _PARSE_FLOAT_RE.match(text)
    if not m:
        return math.nan
    return float(m.group(0))


def js_is_integer(v: Any) -> bool:
    """Number.isInteger(v)."""
    if not _is_number(v):
        return False
    d = _as_double(v)
    return math.isfinite(d) and d == math.floor(d)


def _int_or_double(v: Any) -> Any:
    """Normalize a JS number for use as an index / dict key: integral finite values become int."""
    d = _as_double(v)
    if math.isfinite(d) and d == math.floor(d):
        return int(d)
    return d


def js_math_round(x: float) -> float:
    """Math.round. Fixed relative to the older port: floor(x + 0.5) is wrong for 0.49999999999999994 and for
    large odd values, and raises on infinities."""
    if not math.isfinite(x) or x == 0:
        return x
    r = math.floor(x)
    return float(r + 1) if x - r >= 0.5 else float(r)


def _utf16_units(s: str) -> list[int]:
    b = s.encode("utf-16-le", "surrogatepass")
    return [b[i] | (b[i + 1] << 8) for i in range(0, len(b), 2)]


def js_string_sort_key(s: str) -> bytes:
    """Default Array.prototype.sort / `<` order on strings: by UTF-16 code units."""
    return s.encode("utf-16-be", "surrogatepass")


def _js_canonical_index(key: Any) -> int | None:
    """The array index a property key names (number or canonical numeric string), else None."""
    if _is_number(key):
        d = _as_double(key)
        return int(d) if math.isfinite(d) and d >= 0 and d == math.floor(d) and d < 2**32 - 1 else None
    if isinstance(key, str) and key and (key == "0" or (key[0] in "123456789" and key.isascii() and key.isdigit())):
        n = int(key)
        return n if n < 2**32 - 1 else None
    return None


def _js_index(arr: Any, key: Any) -> Any:
    """`arr[key]` for a JSON array (None when absent)."""
    if not isinstance(arr, list):
        return None
    idx = _js_canonical_index(key)
    if idx is None or idx >= len(arr):
        return None
    return arr[idx]


def _prop(obj: Any, key: str) -> Any:
    """`obj.key` / `obj?.key` for a JSON value (None for anything that is not an object)."""
    return obj.get(key) if isinstance(obj, dict) else None


def _prop_strict(obj: Any, key: str) -> Any:
    """`obj.key` where JavaScript would throw on null."""
    if obj is None:
        raise TypeError(f"Cannot read properties of null (reading '{key}')")
    return _prop(obj, key)


def _nullish(v: Any) -> bool:
    return v is None


def _js_own_keys(d: dict) -> list:
    """Object property order: array-index keys ascending, then the rest in insertion order."""
    index_keys = sorted((k for k in d if _js_canonical_index(k) is not None and isinstance(k, str)), key=int)
    return index_keys + [k for k in d if not (isinstance(k, str) and _js_canonical_index(k) is not None)]


def _same_value_zero(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return _as_double(a) == _as_double(b)
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if a is None or b is None:
        return a is None and b is None
    return a is b


def _strict_equals(a: Any, b: Any) -> bool:
    return _same_value_zero(a, b)


# ---------------------------------------------------------------------------------------------------------
# Cells (datasetContent.js)
# ---------------------------------------------------------------------------------------------------------

def _is_asset_cell(v: Any) -> bool:
    return isinstance(v, dict) and v.get("kind") in ("images", "pdf") and isinstance(v.get("assetIds"), list)


def display_cell(v: Any) -> str:
    if _is_asset_cell(v):
        names = v.get("names")
        items = names if isinstance(names, list) and len(names) > 0 else v["assetIds"]
        return ", ".join("" if item is None else js_to_string(item) for item in items)
    return "" if v is None else js_to_string(v)


def clone_cell(v: Any) -> Any:
    if _is_asset_cell(v):
        names = v.get("names")
        names = names if js_truthy(names) else []
        return {"kind": v["kind"], "assetIds": list(v["assetIds"]), "names": list(names) if isinstance(names, list) else names}
    return "" if v is None else js_to_string(v)


def to_compare_str(v: Any) -> str:
    """scoreOutputGtMatcher.toCompareStr."""
    if v is None:
        return ""
    if isinstance(v, str):
        return js_trim(v)
    if isinstance(v, list):
        return js_trim(", ".join(to_compare_str(item) for item in v))
    return js_trim(display_cell(v))


# ---------------------------------------------------------------------------------------------------------
# Match flags and primitives (scoreMatchPrimitives.js)
# ---------------------------------------------------------------------------------------------------------

SCORE_GT_ROW_INDEX_COLUMN = "__score_gt_row_index__"
EMBEDDING_COSINE_THRESHOLD = 0.76
SEMANTIC_ALIGN_DICE_THRESHOLD = 0.65
SMART_FLAGS = ("embeddingSimilarity", "semanticAlign", "rxnormMatch", "meshMatch", "hgncMatch", "pubchemMatch", "ontologyMatch")

DEFAULT_MATCH_FLAGS: dict[str, Any] = {
    "semanticAlign": False,
    "embeddingSimilarity": False,
    "rxnormMatch": False,
    "meshMatch": False,
    "hgncMatch": False,
    "pubchemMatch": False,
    "ontologyMatch": False,
    "ontologySource": "go",
    "contains": False,
    "ignoreCase": False,
    "ignoreSymbols": False,
    "ignoreWhitespace": False,
    "numericMode": "exact",
    "numericAbsEpsilon": 0,
    "numericRelEpsilon": 0,
    "numericDecimalPlaces": 2,
}


def canonicalize_match_flags(f: Any) -> dict[str, Any]:
    """Fixed relative to the older port: parameters go through JS Number() (so "" and null mean 0, "0x2" means 2,
    "1_0" and "inf" mean NaN), non-finite values fall back as in JS instead of raising or surviving, and flags use
    JS truthiness ([] and {} are true)."""
    merged = {**DEFAULT_MATCH_FLAGS, **(f if isinstance(f, dict) else {})}
    mode = merged.get("numericMode")
    mode = mode if isinstance(mode, str) and mode in ("exact", "abs", "rel", "decimals") else "exact"
    abs_e = js_to_number(merged.get("numericAbsEpsilon"))
    if not math.isfinite(abs_e) or abs_e < 0:
        abs_e = 0.0
    rel_e = js_to_number(merged.get("numericRelEpsilon"))
    if not math.isfinite(rel_e) or rel_e < 0:
        rel_e = 0.0
    dec_raw = js_to_number(merged.get("numericDecimalPlaces"))
    dec = math.floor(dec_raw) if math.isfinite(dec_raw) else 2
    dec = max(0, min(20, dec))
    smart: dict[str, bool] = {}
    soft_string = False
    for name in SMART_FLAGS:
        smart[name] = (not soft_string) and js_truthy(merged.get(name))
        soft_string = soft_string or smart[name]
    source = merged.get("ontologySource")
    return {
        **smart,
        "ontologySource": source if isinstance(source, str) and source in ("go", "chebi", "mondo") else "go",
        "contains": False if soft_string else js_truthy(merged.get("contains")),
        "ignoreCase": False if soft_string else js_truthy(merged.get("ignoreCase")),
        "ignoreSymbols": False if soft_string else js_truthy(merged.get("ignoreSymbols")),
        "ignoreWhitespace": False if soft_string else js_truthy(merged.get("ignoreWhitespace")),
        "numericMode": mode,
        "numericAbsEpsilon": abs_e,
        "numericRelEpsilon": rel_e,
        "numericDecimalPlaces": dec,
    }


def medical_concept_source(flags: dict) -> str | None:
    if flags.get("rxnormMatch"):
        return "rxnorm"
    if flags.get("meshMatch"):
        return "mesh"
    if flags.get("hgncMatch"):
        return "hgnc"
    if flags.get("pubchemMatch"):
        return "pubchem"
    if flags.get("ontologyMatch"):
        return flags.get("ontologySource") or "go"
    return None


def migrate_legacy_match_type(match_type: Any) -> Any:
    if match_type == "contains" or match_type == "gt-contains-run":
        return "exact"
    return match_type if js_truthy(match_type) else "exact"


def legacy_match_type_was_contains(match_type: Any) -> bool:
    return match_type == "contains" or match_type == "gt-contains-run"


def _round_to_decimals(n: float, places: int) -> float:
    p = max(0, min(20, math.floor(places)))
    m = float(10**p)
    return js_math_round(n * m) / m


def numeric_pair_matches(run_str: str, gt_str: str, flags: dict) -> bool:
    run_norm = js_trim(run_str)
    gt_norm = js_trim(gt_str)
    run_num = js_parse_float(run_norm)
    gt_num = js_parse_float(gt_norm)
    if not math.isfinite(run_num) or not math.isfinite(gt_num):
        return run_norm == gt_norm
    mode = flags.get("numericMode") or "exact"
    if mode == "abs":
        return abs(run_num - gt_num) <= flags["numericAbsEpsilon"]
    if mode == "rel":
        denom = max(abs(run_num), abs(gt_num), 1e-15)
        return abs(run_num - gt_num) / denom <= flags["numericRelEpsilon"]
    if mode == "decimals":
        p = flags["numericDecimalPlaces"]
        return _round_to_decimals(run_num, p) == _round_to_decimals(gt_num, p)
    return run_num == gt_num


def normalize_for_match(value: str, flags: dict, is_numeric: bool) -> str:
    text = js_trim(value)
    if is_numeric:
        return text
    if flags.get("ignoreWhitespace"):
        text = js_trim(_WS_RUN_RE.sub(" ", text))
    if flags.get("ignoreCase"):
        text = text.lower()
    if flags.get("ignoreSymbols"):
        text = js_trim(_WS_RUN_RE.sub(" ", _NOT_WORD_OR_SPACE_RE.sub("", text)))
    return text


def strings_match_contains(run_val: str, gt_val: str) -> bool:
    if len(run_val) == 0 and len(gt_val) == 0:
        return True
    if len(run_val) == 0 or len(gt_val) == 0:
        return False
    return gt_val in run_val or run_val in gt_val


def strings_match_semantic_align(run_val: str, gt_val: str) -> bool:
    """Bigram Dice >= 0.65. Fixed relative to the older port: bigrams and lengths count UTF-16 code units, as JS
    does (a character outside the BMP is two units)."""
    a = _WS_RUN_RE.sub(" ", js_trim(run_val).lower())
    b = _WS_RUN_RE.sub(" ", js_trim(gt_val).lower())
    ua, ub = _utf16_units(a), _utf16_units(b)
    if len(ua) == 0 and len(ub) == 0:
        return True
    if len(ua) == 0 or len(ub) == 0:
        return False
    if a == b:
        return True
    if len(ua) < 2 or len(ub) < 2:
        return a == b
    ba = [(ua[i], ua[i + 1]) for i in range(len(ua) - 1)]
    bb = [(ub[i], ub[i + 1]) for i in range(len(ub) - 1)]
    counts: dict[tuple, int] = {}
    for x in ba:
        counts[x] = counts.get(x, 0) + 1
    inter = 0
    for x in bb:
        c = counts.get(x, 0)
        if c > 0:
            inter += 1
            counts[x] = c - 1
    return (2 * inter) / (len(ba) + len(bb)) >= SEMANTIC_ALIGN_DICE_THRESHOLD


def embedding_pair_matches(run_val: str, gt_val: str, cosine_map: dict) -> bool:
    if len(run_val) == 0 and len(gt_val) == 0:
        return True
    if len(run_val) == 0 or len(gt_val) == 0:
        return False
    c = cosine_map.get((run_val, gt_val))
    if not _is_number(c) or not math.isfinite(_as_double(c)):
        return False
    return c >= EMBEDDING_COSINE_THRESHOLD


def concept_pair_matches(run_val: str, gt_val: str, concept_map: dict, source: str | None) -> bool:
    if len(run_val) == 0 and len(gt_val) == 0:
        return True
    if len(run_val) == 0 or len(gt_val) == 0:
        return False

    def lookup(term: str) -> Any:
        if source and (source, term) in concept_map:
            return concept_map[(source, term)]
        return concept_map.get(term)

    ra, rb = lookup(run_val), lookup(gt_val)
    if not js_truthy(ra) or not js_truthy(rb):
        return False
    if _prop(ra, "status") == "ambiguous" or _prop(rb, "status") == "ambiguous":
        return False
    sa, sb = _prop(ra, "source"), _prop(rb, "source")
    if js_truthy(sa) and js_truthy(sb) and not _strict_equals(sa, sb):
        return False
    ca = _prop(ra, "concept_id")
    return js_truthy(ca) and _strict_equals(ca, _prop(rb, "concept_id"))


# ---------------------------------------------------------------------------------------------------------
# Score bundle (scoreMappingBundle.js)
# ---------------------------------------------------------------------------------------------------------

def empty_score_rule_group() -> dict:
    return {"type": "group", "ops": [], "children": []}


def _plain_flags(v: Any) -> dict:
    return v if isinstance(v, dict) else {}


def _normalize_score_mapping_to_rules(arr: Any) -> list[dict]:
    if not isinstance(arr, list) or len(arr) == 0:
        return []
    first = arr[0]
    if isinstance(first, (dict, list)) and isinstance(_prop(first, "gtColumns"), list):
        out = []
        for r in arr:
            raw = _prop_strict(r, "matchType")
            raw = raw if js_truthy(raw) else "exact"
            base_f = _plain_flags(_prop(r, "matchFlags")) if js_truthy(_prop(r, "matchFlags")) else {}
            gt_cols = _prop(r, "gtColumns")
            rule = {
                "outputKey": _prop(r, "outputKey") if js_truthy(_prop(r, "outputKey")) else "",
                "gtColumns": [c for c in gt_cols if js_truthy(c)] if isinstance(gt_cols, list) else [],
                "matchType": migrate_legacy_match_type(raw),
                "matchFlags": {**DEFAULT_MATCH_FLAGS, **base_f,
                               "contains": js_truthy(base_f.get("contains")) or legacy_match_type_was_contains(raw)},
            }
            if js_truthy(rule["outputKey"]) or len(rule["gtColumns"]) > 0:
                out.append(rule)
        return out
    pairs: list[dict] = []

    def push(r: Any) -> None:
        ok = _prop_strict(r, "outputKey")
        col = _prop(r, "gtColumn")
        mt = _prop(r, "matchType")
        pairs.append({"outputKey": ok if js_truthy(ok) else "", "gtColumn": col if js_truthy(col) else "",
                      "matchType": mt if js_truthy(mt) else "exact"})

    if js_truthy(first) and isinstance(first, dict) and "outputKey" in first and not js_truthy(first.get("rules")):
        for r in arr:
            push(r)
    elif js_truthy(first) and js_truthy(_prop(first, "rules")):
        for g in arr:
            rules = _prop_strict(g, "rules")
            for r in (rules if js_truthy(rules) else []):
                push(r)
    else:
        return []
    by_key: dict[str, dict] = {}
    for p in pairs:
        raw = p["matchType"] if js_truthy(p["matchType"]) else "exact"
        key = js_to_string(p["outputKey"])
        if key not in by_key:
            by_key[key] = {"outputKey": p["outputKey"], "gtColumns": [], "matchType": migrate_legacy_match_type(raw),
                           "anyContains": False}
        if legacy_match_type_was_contains(raw):
            by_key[key]["anyContains"] = True
        by_key[key]["matchType"] = migrate_legacy_match_type(raw)
        if js_truthy(p["gtColumn"]) and not any(_same_value_zero(c, p["gtColumn"]) for c in by_key[key]["gtColumns"]):
            by_key[key]["gtColumns"].append(p["gtColumn"])
    out = []
    for key in _js_own_keys(by_key):
        r = by_key[key]
        if js_truthy(r["outputKey"]) or len(r["gtColumns"]) > 0:
            out.append({"outputKey": r["outputKey"], "gtColumns": r["gtColumns"], "matchType": r["matchType"],
                        "matchFlags": {**DEFAULT_MATCH_FLAGS, "contains": r["anyContains"]}})
    return out


def _ensure_group_ops(data: Any, children: list) -> list[str]:
    length = max(0, len(children) - 1)
    ops = _prop(data, "ops")
    if isinstance(ops, list) and len(ops) >= length:
        return ["OR" if o == "OR" else "AND" for o in ops[:length]]
    default_op = "OR" if js_truthy(data) and _prop(data, "op") == "OR" else "AND"
    return [default_op] * length


def _normalize_bundle_child(c: Any) -> dict:
    if not js_truthy(c) or _prop(c, "type") == "rule":
        raw_mt = _prop(c, "matchType") if js_truthy(c) else None
        raw_mt = raw_mt if js_truthy(raw_mt) else "exact"
        flags_src = _prop(c, "matchFlags") if js_truthy(c) else None
        f = {**DEFAULT_MATCH_FLAGS, **(_plain_flags(flags_src) if js_truthy(flags_src) else {})}
        if legacy_match_type_was_contains(raw_mt):
            f["contains"] = True
        output_key = _prop(c, "outputKey") if js_truthy(c) else None
        gt_cols = _prop(c, "gtColumns") if js_truthy(c) else None
        return {
            "type": "rule",
            "outputKey": output_key if js_truthy(output_key) else "",
            "gtColumns": [col for col in gt_cols if js_truthy(col)] if isinstance(gt_cols, list) else [],
            "matchType": migrate_legacy_match_type(raw_mt),
            "matchFlags": canonicalize_match_flags(f),
        }
    return _normalize_bundle_group_child(c)


def _normalize_bundle_group_child(c: Any) -> dict:
    raw_children = _prop(c, "children")
    raw_children = raw_children if js_truthy(raw_children) else []
    children = [
        _normalize_bundle_group_child(ch) if (js_truthy(ch) and _prop(ch, "type") == "group") else _normalize_bundle_child(ch)
        for ch in raw_children
    ]
    out = {"type": "group", "ops": _ensure_group_ops(c, children), "children": children}
    gid = _prop(c, "groupId")
    if js_is_integer(gid) and gid > 0:
        out["groupId"] = gid
    return out


def parse_score_tree_only(data: Any) -> dict:
    if not js_truthy(data):
        return empty_score_rule_group()
    if _prop(data, "type") == "group" and isinstance(_prop(data, "children"), list):
        children = [
            _normalize_bundle_group_child(c) if (js_truthy(c) and _prop(c, "type") == "group") else _normalize_bundle_child(c)
            for c in data["children"]
        ]
        out = {"type": "group", "ops": _ensure_group_ops(data, children), "children": children}
        gid = _prop(data, "groupId")
        if js_is_integer(gid) and gid > 0:
            out["groupId"] = gid
        return out
    rules = _normalize_score_mapping_to_rules(data if isinstance(data, list) else [])
    children = [{
        "type": "rule",
        "outputKey": r["outputKey"] if js_truthy(r["outputKey"]) else "",
        "gtColumns": list(r["gtColumns"]),
        "matchType": migrate_legacy_match_type(r["matchType"] if js_truthy(r["matchType"]) else "exact"),
        "matchFlags": {**DEFAULT_MATCH_FLAGS, **_plain_flags(r["matchFlags"])},
    } for r in rules]
    return {"type": "group", "ops": ["AND"] * max(0, len(children) - 1), "children": children}


def _reject_constant(name: str) -> Any:
    raise ValueError(f"invalid JSON constant {name}")


def parse_score_mapping_bundle(raw: Any) -> tuple[dict, dict]:
    """Returns (input_root, output_root) exactly as parseScoreMappingBundle does (group ids aside, which do not
    affect scoring). Fixed relative to score_mapping_bundle.py: rules are normalized (legacy matchType
    "contains"/"gt-contains-run" become exact + contains, flags canonicalized, falsy gtColumns dropped, ops padded)
    and legacy single-tree / array mappings are read instead of yielding no rules."""
    if isinstance(raw, str):
        try:
            data = json.loads(raw or "{}", parse_constant=_reject_constant)
        except (ValueError, TypeError):
            data = {}
    else:
        data = raw
    if (
        js_truthy(data) and _is_number(_prop(data, "v")) and _prop(data, "v") == 2
        and js_truthy(_prop(data, "input")) and js_truthy(_prop(data, "output"))
        and _prop(data["input"], "type") == "group" and _prop(data["output"], "type") == "group"
    ):
        return parse_score_tree_only(data["input"]), parse_score_tree_only(data["output"])
    return empty_score_rule_group(), parse_score_tree_only(data)


def flatten_score_rules(node: Any) -> list[dict]:
    if not js_truthy(node):
        return []
    if _prop(node, "type") == "rule":
        return [node]
    if _prop(node, "type") == "group" and isinstance(_prop(node, "children"), list):
        out: list[dict] = []
        for child in node["children"]:
            out.extend(flatten_score_rules(child))
        return out
    return []


# ---------------------------------------------------------------------------------------------------------
# Rule evaluation, tree fold and greedy pairing (scoreOutputGtMatcher.js, scoreRunGtPairing.js)
# ---------------------------------------------------------------------------------------------------------

def _get_run_value(run_result: Any, output_key: Any, row_index: Any, run_ws: Any, original_input_by_prompt: dict) -> str:
    if output_key == "#" or output_key == "[#]":
        return to_compare_str(row_index)
    key = js_trim(js_to_string(output_key if js_truthy(output_key) else ""))
    if not key:
        return ""
    if key.startswith("[") and key.endswith("]") and len(key) >= 2:
        header = js_trim(key[1:-1])
        rows = run_ws.get("rows") if isinstance(run_ws, dict) and isinstance(run_ws.get("rows"), list) else []
        headers = run_ws.get("headers") if isinstance(run_ws, dict) and isinstance(run_ws.get("headers"), list) else []
        col = next((i for i, h in enumerate(headers) if js_trim(js_to_string(h)) == header), -1)
        prompt_idx = _prop(run_result, "input_row_index")
        prompt_idx = row_index if _nullish(prompt_idx) else prompt_idx
        original = original_input_by_prompt.get(_num_key(prompt_idx))
        if col >= 0 and js_is_integer(original):
            row = _js_index(rows, original)
            if js_truthy(row):
                return to_compare_str(_js_index(row, col) if isinstance(row, list) else None)
        return ""
    output = _prop(run_result, "output")
    if js_truthy(output) and isinstance(output, (dict, list)):
        if isinstance(output, dict):
            if key in output:
                return to_compare_str(output[key])
            if key in _OBJECT_PROTOTYPE_STRINGS:
                return js_trim(_OBJECT_PROTOTYPE_STRINGS[key])
        else:
            if key == "length":
                return js_number_to_string(len(output))
            idx = _js_canonical_index(key)
            if idx is not None and idx < len(output):
                return to_compare_str(output[idx])
    error = _prop(run_result, "error")
    if js_truthy(error):
        return to_compare_str(error)
    return ""


def _get_gt_value(gt_subset: dict, local_index: int, column: Any) -> str:
    col_name = js_trim(js_to_string(column))
    if col_name == SCORE_GT_ROW_INDEX_COLUMN:
        src = gt_subset["sourceRowIndices"]
        source_idx = src[local_index] if 0 <= local_index < len(src) else None
        return to_compare_str(source_idx) if js_is_integer(source_idx) and source_idx >= 0 else ""
    headers = gt_subset["headers"]
    rows = gt_subset["rows"]
    col = next((i for i, h in enumerate(headers) if js_trim(js_to_string(h)) == col_name), -1)
    row = rows[local_index] if 0 <= local_index < len(rows) else None
    if col < 0 or not isinstance(row, list):
        return ""
    return to_compare_str(row[col] if col < len(row) else None)


class _Context:
    """Per-call state: rows, prompt-index map and the prefetched embedding / concept maps."""

    def __init__(self, run_ws: dict, original_input_by_prompt: dict, cosine_map: dict, concept_map: dict):
        self.run_ws = run_ws
        self.original_input_by_prompt = original_input_by_prompt
        self.cosine_map = cosine_map
        self.concept_map = concept_map

    def run_value(self, run_result: Any, output_key: Any, row_index: Any) -> str:
        return _get_run_value(run_result, output_key, row_index, self.run_ws, self.original_input_by_prompt)

    def rule_matches_row(self, rule: dict, run_row_index: Any, gt_index: int, results_by_index: dict, gt_subset: dict) -> bool:
        run_result = results_by_index.get(_num_key(run_row_index))
        run_raw = self.run_value(run_result, rule.get("outputKey"), run_row_index)
        gt_raws = [_get_gt_value(gt_subset, gt_index, col) for col in (rule.get("gtColumns") or [])]
        mt = rule.get("matchType")
        match_type = js_trim(js_to_string(mt if js_truthy(mt) else "exact")) or "exact"
        flags = canonicalize_match_flags(rule.get("matchFlags"))
        if match_type == "numeric":
            run_norm = normalize_for_match(run_raw, flags, True)
            return any(numeric_pair_matches(run_norm, normalize_for_match(g, flags, True), flags) for g in gt_raws)
        if match_type == "exact" and flags["embeddingSimilarity"]:
            return any(embedding_pair_matches(run_raw, g, self.cosine_map) for g in gt_raws)
        if match_type == "exact" and flags["semanticAlign"]:
            return any(strings_match_semantic_align(run_raw, g) for g in gt_raws)
        source = medical_concept_source(flags)
        if match_type == "exact" and source:
            return any(concept_pair_matches(run_raw, g, self.concept_map, source) for g in gt_raws)
        run_val = normalize_for_match(run_raw, flags, False)
        for g in gt_raws:
            gt_norm = normalize_for_match(g, flags, False)
            if match_type == "exact" and flags["contains"]:
                if strings_match_contains(run_val, gt_norm):
                    return True
            elif run_val == gt_norm:
                return True
        return False

    def evaluate_tree(self, node: Any, run_row_index: Any, gt_index: int, results_by_index: dict, gt_subset: dict) -> bool:
        if not js_truthy(node):
            return False
        if _prop(node, "type") == "rule":
            return self.rule_matches_row(node, run_row_index, gt_index, results_by_index, gt_subset)
        children = _prop(node, "children")
        if _prop(node, "type") == "group" and isinstance(children, list):
            if len(children) == 0:
                return False
            ops = node.get("ops")
            if not js_truthy(ops):
                ops = ["AND"] * max(0, len(children) - 1)
            r = self.evaluate_tree(children[0], run_row_index, gt_index, results_by_index, gt_subset)
            for i in range(1, len(children)):
                nxt = self.evaluate_tree(children[i], run_row_index, gt_index, results_by_index, gt_subset)
                op = _js_index(ops, i - 1) if isinstance(ops, list) else None
                r = (r or nxt) if op == "OR" else (r and nxt)
            return r
        return False


def _band_key(run_row_index: Any, results_by_index: dict) -> str:
    """computeRunInputBandKey with an empty input tree (Verify never passes input rules)."""
    rr = results_by_index.get(_num_key(run_row_index)) if _is_number(run_row_index) and run_row_index >= 0 else None
    if rr is not None:
        idx = rr.get("input_row_index")
        idx = run_row_index if _nullish(idx) else idx
    else:
        idx = run_row_index
    return "__ir__:" + js_to_string(idx)


class JsRangeError(ValueError):
    """`new Array(n)` with a fractional or out-of-range n, which aborts Verify in the app."""


def _check_array_length(n: float) -> None:
    if not (n >= 0 and n == math.floor(n) and n <= 2**32 - 1):
        raise JsRangeError("Invalid array length")


def _greedy_run_to_gt(ctx: _Context, output_root: dict, results: list, gt_subset: dict, input_row_count: int) -> dict:
    """computeGreedyRunToGtPairing with an empty input tree and the per-band order Verify uses.
    Returns {run row key: local GT index}. Fixed relative to score_run_gt_pairing.py: run rows are keyed by value
    (a negative or fractional row_index neither wraps around a Python list nor raises), and the band key treats a
    null input_row_index like a missing one."""
    results_by_index: dict = {}
    for r in results:
        if r:
            results_by_index[_num_key(r["row_index"])] = r
    run_row_indices: list = []
    seen: set = set()
    for r in results:
        k = _num_key(r["row_index"])
        if k not in seen:
            seen.add(k)
            run_row_indices.append(r["row_index"])
    gt_count = len(gt_subset["rows"])
    max_run_row = max((_as_double(i) for i in run_row_indices), default=-1)
    _check_array_length(max(input_row_count, max_run_row + 1, gt_count))
    leaves = flatten_score_rules(output_root)
    pairs = []
    for i in run_row_indices:
        for j in range(gt_count):
            if leaves:
                vec = [1 if ctx.rule_matches_row(rule, i, j, results_by_index, gt_subset) else 0 for rule in leaves]
                score = sum(vec)
            else:
                vec, score = [], 0
            if score > 0:
                pairs.append((i, j, score, vec))
    by_band: dict[str, list] = {}
    for p in pairs:
        by_band.setdefault(_band_key(p[0], results_by_index), []).append(p)
    run_to_gt: dict = {}
    gt_used = [False] * gt_count
    for band in sorted(by_band, key=js_string_sort_key):
        band_pairs = sorted(by_band[band], key=lambda p: (-p[2], tuple(-v for v in p[3]), _as_double(p[0]), p[1]))
        for i, j, _score, _vec in band_pairs:
            if run_to_gt.get(_num_key(i), -1) >= 0 or gt_used[j]:
                continue
            run_to_gt[_num_key(i)] = j
            gt_used[j] = True
    return run_to_gt


# ---------------------------------------------------------------------------------------------------------
# Embedding / concept maps (prefetchEmbeddingCosineMap / prefetchConceptIdMap, in-process)
# ---------------------------------------------------------------------------------------------------------

EmbeddingProvider = Callable[[list[tuple[str, str]]], list]
ConceptProvider = Callable[[str, list[str]], dict]


def default_embedding_provider(pairs: list[tuple[str, str]]) -> list:
    """What POST /api/embeddings/pair-similarities returns, computed in-process."""
    from embedding_service import compute_pair_cosine_similarities

    return list(compute_pair_cosine_similarities([[a, b] for a, b in pairs]))


def default_concept_provider(source: str, terms: list[str]) -> dict:
    """What POST /api/terminology/normalize returns, computed in-process."""
    from terminology_client import resolve_concepts_bulk

    return resolve_concepts_bulk(list(terms), source=source)


def coerce_embedding_map(value: Any) -> dict:
    """{(run, gt): cosine} from a dict with tuple keys or a list of [run, gt, cosine]."""
    if isinstance(value, dict):
        return dict(value)
    out: dict = {}
    for item in value or []:
        a, b, c = item
        out[(a, b)] = c
    return out


def coerce_concept_map(value: Any) -> dict:
    """{(source, term) or term: result} from a dict or a list of [source, term, result] (source None = plain term)."""
    if isinstance(value, dict):
        return dict(value)
    out: dict = {}
    for item in value or []:
        source, term, result = item
        out[(source, term) if source else term] = result
    return out


def _collect_embedding_pairs(ctx: _Context, leaves: list, results: list, gt_subset: dict) -> list[tuple[str, str]]:
    rules = [r for r in leaves if migrate_legacy_match_type(r.get("matchType")) == "exact"
             and canonicalize_match_flags(r.get("matchFlags"))["embeddingSimilarity"]]
    if not rules:
        return []
    results_by_index = {_num_key(r["row_index"]): r for r in results}
    run_row_indices = list({_num_key(r["row_index"]): r["row_index"] for r in results}.values())
    seen: set = set()
    pairs: list[tuple[str, str]] = []
    for i in run_row_indices:
        run_result = results_by_index.get(_num_key(i))
        for j in range(len(gt_subset["rows"])):
            for rule in rules:
                a = ctx.run_value(run_result, rule.get("outputKey"), i)
                for col in rule.get("gtColumns") or []:
                    pair = (a, _get_gt_value(gt_subset, j, col))
                    if pair not in seen:
                        seen.add(pair)
                        pairs.append(pair)
    return pairs


def _collect_concept_terms(ctx: _Context, leaves: list, results: list, gt_subset: dict) -> dict[str, list[str]]:
    rules = [r for r in leaves if migrate_legacy_match_type(r.get("matchType")) == "exact"
             and medical_concept_source(canonicalize_match_flags(r.get("matchFlags")))]
    terms_by_source: dict[str, dict[str, None]] = {}
    if not rules:
        return {}
    results_by_index = {_num_key(r["row_index"]): r for r in results}
    run_row_indices = list({_num_key(r["row_index"]): r["row_index"] for r in results}.values())
    for rule in rules:
        source = medical_concept_source(canonicalize_match_flags(rule.get("matchFlags")))
        seen = terms_by_source.setdefault(source, {})
        for i in run_row_indices:
            value = ctx.run_value(results_by_index.get(_num_key(i)), rule.get("outputKey"), i)
            if js_trim(value):
                seen[value] = None
        for j in range(len(gt_subset["rows"])):
            for col in rule.get("gtColumns") or []:
                value = _get_gt_value(gt_subset, j, col)
                if js_trim(value):
                    seen[value] = None
    return {source: list(terms) for source, terms in terms_by_source.items()}


def _build_cosine_map(ctx, leaves, results, gt_subset, static_map, provider) -> dict:
    if not any(canonicalize_match_flags(r.get("matchFlags"))["embeddingSimilarity"] for r in leaves):
        return {}
    if static_map is not None:
        return coerce_embedding_map(static_map)
    pairs = _collect_embedding_pairs(ctx, leaves, results, gt_subset)
    if not pairs:
        return {}
    cosines = (provider or default_embedding_provider)(pairs)
    if not isinstance(cosines, list) or len(cosines) != len(pairs):
        raise RuntimeError("Invalid embedding API response")
    return dict(zip(pairs, cosines))


def _build_concept_map(ctx, leaves, results, gt_subset, static_map, provider) -> dict:
    if not any(medical_concept_source(canonicalize_match_flags(r.get("matchFlags"))) for r in leaves):
        return {}
    if static_map is not None:
        return coerce_concept_map(static_map)
    out: dict = {}
    for source, terms in _collect_concept_terms(ctx, leaves, results, gt_subset).items():
        terms = [t for t in terms if len(t) > 0]
        if not terms:
            continue
        found = (provider or default_concept_provider)(source, terms)
        if not isinstance(found, dict):
            raise RuntimeError("Invalid terminology API response")
        for term in terms:
            out[(source, term)] = found.get(term)
    return out


# ---------------------------------------------------------------------------------------------------------
# Code mode (scoreCodeRunClient.js + buildCodeMatchRunToGt), predicate run by match_exec.run_match_pairs
# ---------------------------------------------------------------------------------------------------------

PYTHON_PATH_MISSING = "Set a Python interpreter path in Settings → Python first."


def _output_row_dict(result: Any) -> dict:
    output = _prop(result, "output")
    if not (js_truthy(output) and isinstance(output, (dict, list))):
        return {}
    items = [(str(i), v) for i, v in enumerate(output)] if isinstance(output, list) else [(k, output[k]) for k in _js_own_keys(output)]
    return {k: ("" if v is None else js_to_string(v)) for k, v in items}


def _row_dict(headers: list, values: Any) -> dict:
    values = values if isinstance(values, list) else []
    out: dict = {}
    for idx, h in enumerate(headers):
        out["" if h is None else js_to_string(h)] = clone_cell(values[idx] if idx < len(values) else None)
    return out


def build_code_match_payload(outputs: list, input_headers: list, input_values: Any, local_gt: dict) -> dict:
    """buildCodeMatchInputs as runScoreCode calls it from Verify: every output row sees the input's row."""
    if not outputs:
        raise ValueError("No model outputs to match.")
    if not local_gt["rows"]:
        raise ValueError("Ground truth dataset has no rows.")
    input_row = _row_dict(input_headers, input_values)
    return {
        "runRowIndices": [r["row_index"] for r in outputs],
        "runRows": [{"input_row": dict(input_row), "output_row": _output_row_dict(r)} for r in outputs],
        "gtRows": [{"gt_row": _row_dict(local_gt["headers"], row)} for row in local_gt["rows"]],
    }


def _code_run_to_gt(run_row_indices: list, outcomes: list, gt_count: int) -> dict:
    _check_array_length(max(max((_as_double(i) for i in run_row_indices), default=-1) + 1, gt_count))
    run_to_gt: dict = {}
    for k, outcome in enumerate(outcomes):
        i = run_row_indices[k] if k < len(run_row_indices) else None
        if not _is_number(i) or i < 0:
            continue
        mgi = _prop(outcome, "matched_gt_index")
        if js_truthy(_prop(outcome, "ok")) and _is_number(mgi):
            run_to_gt[_num_key(i)] = mgi
    return run_to_gt


def _run_match_code(code: str, payload: dict, python_path: str | None, project_session_id: str | None, match_runner) -> list:
    python_path = js_trim(python_path or "")
    if not python_path:
        raise ValueError(PYTHON_PATH_MISSING)
    from asset_store import resolve_cell_for_code

    run_rows = resolve_cell_for_code(payload["runRows"], project_session_id)
    gt_rows = resolve_cell_for_code(payload["gtRows"], project_session_id)
    if match_runner is None:
        from match_exec import run_match_pairs as match_runner
    outcomes: list = []
    match_runner(python_path, code, run_rows, gt_rows, lambda _index, outcome: outcomes.append(outcome), lambda: False)
    return outcomes


# ---------------------------------------------------------------------------------------------------------
# evaluateScoreOutputGt
# ---------------------------------------------------------------------------------------------------------

def _source_index(gt_row: Any) -> float:
    raw = _prop(gt_row, "gtRowIndex")
    if _nullish(raw):
        num = js_to_number(_prop(gt_row, "gtNum"))
        raw = num - 1 if math.isfinite(num) else math.nan
    return js_to_number(raw)


def _valid_result(r: Any) -> bool:
    if not isinstance(r, dict):
        return False
    ri = r.get("row_index")
    return _is_number(ri) and not (isinstance(ri, float) and ri != ri)


def evaluate_score_output_gt(
    *,
    score_mapping: Any = None,
    score_match_code: Any = "",
    results: list | None = None,
    input_entries: list | None = None,
    output_fields: list | None = None,
    run_ws: dict | None = None,
    gt_content: dict | None = None,
    embedding_cosines: Any = None,
    concept_ids: Any = None,
    embedding_provider: EmbeddingProvider | None = None,
    concept_provider: ConceptProvider | None = None,
    python_path: str | None = None,
    project_session_id: str | None = None,
    match_runner: Callable | None = None,
) -> dict:
    """Port of evaluateScoreOutputGt (same arguments, same verifyRows / matchedCount / total).

    score_mapping       the Score node's serialized v2 bundle (string or parsed object); its output tree is used.
    score_match_code    Python source defining match(input_row, output_row, gt_row); when set, rules are unused.
    results             run result rows: {row_index, input_row_index (position in input_entries), output, error}.
    input_entries       [[original input row index, {"gtRows": [{"gtRowIndex": i} or {"gtNum": i + 1}, ...]}], ...].
    run_ws              the input table {headers, rows} (rows indexed by original input row index).
    gt_content          the ground-truth table {headers, rows}.
    embedding_cosines   prefetched {(run, gt): cosine} / [[run, gt, cosine]]; else embedding_provider (default:
                        the in-process FastEmbed model) is asked for the pairs Verify would request.
    concept_ids         prefetched {(source, term): result} / [[source, term, result]]; else concept_provider
                        (default: terminology_client.resolve_concepts_bulk).
    python_path         interpreter for code mode (required there, as Settings -> Python is in the app).
    match_runner        replaces match_exec.run_match_pairs (same signature), for tests.
    """
    output_fields = output_fields or []
    run_ws = run_ws if isinstance(run_ws, dict) else {"headers": [], "rows": []}
    gt_content = gt_content if isinstance(gt_content, dict) else {"headers": [], "rows": []}
    _input_root, output_root = parse_score_mapping_bundle(score_mapping if score_mapping is not None else "{}")
    leaves = flatten_score_rules(output_root)
    code_mode = js_truthy(score_match_code)
    if not code_mode and not leaves:
        raise ValueError("No Evaluate output->gt rules configured.")

    entries = list(input_entries or [])
    # buildGtSubset
    headers = list(gt_content["headers"]) if isinstance(gt_content.get("headers"), list) else []
    all_rows = gt_content["rows"] if isinstance(gt_content.get("rows"), list) else []
    source_indices: list[int] = []
    seen_src: set = set()
    entries = [(e[0] if len(e) > 0 else None, e[1] if len(e) > 1 else None) for e in entries]
    for entry in entries:
        for gt_row in (_prop(entry[1], "gtRows") or []):
            idx = _source_index(gt_row)
            if not js_is_integer(idx) or idx < 0 or int(idx) in seen_src:
                continue
            seen_src.add(int(idx))
            source_indices.append(int(idx))
    gt_subset = {
        "headers": headers,
        "rows": [all_rows[i] if i < len(all_rows) and isinstance(all_rows[i], list) else [] for i in source_indices],
        "sourceRowIndices": source_indices,
    }
    local_by_source = {src: local for local, src in enumerate(source_indices)}

    enriched = []
    for entry in entries:
        local_indices = []
        for gt_row in (_prop(entry[1], "gtRows") or []):
            idx = _source_index(gt_row)
            local = local_by_source.get(int(idx)) if js_is_integer(idx) else None
            if local is not None:
                local_indices.append(local)
        enriched.append((entry[0], local_indices))
    original_input_by_prompt = {_num_key(k): original for k, (original, _locals) in enumerate(enriched)}

    valid_results = [r for r in (results or []) if _valid_result(r)]
    ctx = _Context(run_ws, original_input_by_prompt, {}, {})
    if not code_mode:
        ctx.cosine_map = _build_cosine_map(ctx, leaves, valid_results, gt_subset, embedding_cosines, embedding_provider)
        ctx.concept_map = _build_concept_map(ctx, leaves, valid_results, gt_subset, concept_ids, concept_provider)

    outputs_by_prompt: dict = {}
    for r in valid_results:
        p = r.get("input_row_index")
        outputs_by_prompt.setdefault(_num_key(0 if _nullish(p) else p), []).append(r)

    verify_rows: list[dict] = []
    per_input: list[dict] = []
    matched_count = 0
    total = 0

    def display_gt(local: int) -> dict:
        if code_mode:
            # Object.fromEntries: a later duplicate header wins; a cell past the row's end is undefined, which
            # JSON drops (so the key disappears even if an earlier duplicate had a value).
            row = gt_subset["rows"][local]
            cells: dict = {}
            for i, h in enumerate(headers):
                cells[js_to_string(h)] = row[i] if i < len(row) else _MISSING
            return {k: v for k, v in cells.items() if v is not _MISSING}
        out: dict = {}
        seen_keys: set = set()
        for rule in leaves:
            for col in rule.get("gtColumns") or []:
                raw_key = js_trim(js_to_string(col if js_truthy(col) else ""))
                if not raw_key or raw_key in seen_keys:
                    continue
                seen_keys.add(raw_key)
                if raw_key == SCORE_GT_ROW_INDEX_COLUMN:
                    num = js_number_to_string(source_indices[local] + 1)
                    out["Ground truth: #"] = "" if num == "0" else num
                else:
                    out[raw_key] = _get_gt_value(gt_subset, local, raw_key)
        return out

    for prompt_idx, (original_index, allowed) in enumerate(enriched):
        outputs = outputs_by_prompt.get(_num_key(prompt_idx), [])
        local_gt = {
            "headers": headers,
            "rows": [gt_subset["rows"][i] for i in allowed],
            "sourceRowIndices": [source_indices[i] for i in allowed],
        }
        if code_mode:
            run_to_gt: dict = {}
            if outputs and local_gt["rows"]:
                input_values = _js_index(run_ws.get("rows"), original_index)
                payload = build_code_match_payload(outputs, run_ws.get("headers") or [], input_values if js_truthy(input_values) else [], local_gt)
                outcomes = _run_match_code(str(score_match_code), payload, python_path, project_session_id, match_runner)
                run_to_gt = _code_run_to_gt(payload["runRowIndices"], outcomes, len(local_gt["rows"]))
        else:
            ws_rows = run_ws.get("rows")
            run_to_gt = _greedy_run_to_gt(ctx, output_root, outputs, local_gt, len(ws_rows) if isinstance(ws_rows, list) else 0)
        results_by_index = {_num_key(r["row_index"]): r for r in outputs}

        remaining = list(allowed)
        assignments = []
        for out_row in outputs:
            ri = out_row["row_index"]
            paired_local = run_to_gt.get(_num_key(ri), -1) if ri >= 0 else -1
            paired = js_is_integer(paired_local) and paired_local >= 0
            rules = None
            if paired and not code_mode:
                rules = [ctx.rule_matches_row(rule, ri, int(paired_local), results_by_index, local_gt) for rule in leaves]
            matched = paired and (code_mode or ctx.evaluate_tree(output_root, ri, int(paired_local), results_by_index, local_gt))
            global_local = None
            if paired:
                pl = int(paired_local)
                global_local = allowed[pl] if pl < len(allowed) else None
                if global_local is not None and global_local in remaining:
                    remaining.remove(global_local)
            assignments.append({"out": out_row, "local": global_local, "paired": paired, "matched": matched,
                                "pairedLocal": global_local, "rules": rules})
        cursor = 0
        for a in assignments:
            if a["local"] is None and cursor < len(remaining):
                a["local"] = remaining[cursor]
                cursor += 1

        start = len(verify_rows)
        input_matched = 0
        run_rows_info = []
        gt_matched: dict[int, bool] = {}
        gt_run: dict[int, Any] = {}
        for a in assignments:
            local = a["local"]
            verify_rows.append({
                "output": a["out"].get("output"),
                "error": a["out"].get("error"),
                "gt": display_gt(local) if local is not None else None,
                "gtNum": source_indices[local] + 1 if local is not None else None,
                "matched": a["matched"],
            })
            total += 1
            if a["matched"]:
                matched_count += 1
                input_matched += 1
            paired_src = source_indices[a["pairedLocal"]] if a["pairedLocal"] is not None else None
            run_rows_info.append({"rowIndex": a["out"]["row_index"], "gtRowIndex": paired_src, "paired": a["paired"],
                                  "matched": a["matched"], "rules": a["rules"]})
            if paired_src is not None:
                gt_run.setdefault(paired_src, a["out"]["row_index"])
                gt_matched[paired_src] = gt_matched.get(paired_src, False) or a["matched"]
        for local in remaining[cursor:]:
            verify_rows.append({
                "output": None,
                "error": None,
                "gt": display_gt(local),
                "gtNum": source_indices[local] + 1,
                "matched": False,
            })
            total += 1
        gt_rows_info = []
        for src in dict.fromkeys(source_indices[i] for i in allowed):
            gt_rows_info.append({"gtRowIndex": src, "gtNum": src + 1, "runRowIndex": gt_run.get(src),
                                 "matched": gt_matched.get(src, False)})
        per_input.append({
            "promptIndex": prompt_idx,
            "inputIndex": original_index,
            "verifyRowStart": start,
            "verifyRowEnd": len(verify_rows),
            "matchedCount": input_matched,
            "total": len(verify_rows) - start,
            "runRows": run_rows_info,
            "gtRows": gt_rows_info,
        })

    return {"verifyRows": verify_rows, "matchedCount": matched_count, "total": total, "inputs": per_input}


# ---------------------------------------------------------------------------------------------------------
# One input / a batch of inputs (backend callers, POST /api/score/evaluate)
# ---------------------------------------------------------------------------------------------------------

def _memo_embedding_provider(provider: EmbeddingProvider | None) -> EmbeddingProvider:
    cache: dict = {}

    def run(pairs: list[tuple[str, str]]) -> list:
        missing = [p for p in dict.fromkeys(pairs) if p not in cache]
        if missing:
            values = (provider or default_embedding_provider)(missing)
            if not isinstance(values, list) or len(values) != len(missing):
                raise RuntimeError("Invalid embedding API response")
            cache.update(zip(missing, values))
        return [cache[p] for p in pairs]

    return run


def _memo_concept_provider(provider: ConceptProvider | None) -> ConceptProvider:
    cache: dict = {}

    def run(source: str, terms: list[str]) -> dict:
        missing = [t for t in dict.fromkeys(terms) if (source, t) not in cache]
        if missing:
            found = (provider or default_concept_provider)(source, missing)
            if not isinstance(found, dict):
                raise RuntimeError("Invalid terminology API response")
            for t in missing:
                cache[(source, t)] = found.get(t)
        return {t: cache[(source, t)] for t in terms}

    return run


def score_input(
    *,
    score_mapping: Any = None,
    score_match_code: Any = "",
    input_headers: list | None = None,
    input_row: list | None = None,
    run_rows: list | None = None,
    gt_headers: list | None = None,
    gt_rows: list | None = None,
    output_fields: list | None = None,
    embedding_cosines: Any = None,
    concept_ids: Any = None,
    embedding_provider: EmbeddingProvider | None = None,
    concept_provider: ConceptProvider | None = None,
    python_path: str | None = None,
    project_session_id: str | None = None,
    match_runner: Callable | None = None,
) -> dict:
    """Scores one input as Verify scores it.

    input_headers/input_row  the input table's headers and this input's row (for "[column]" rules and code mode).
    run_rows                 the run's result row(s) for this input, each {"output": {...}, "error": ..., and
                             optionally "row_index"}; several rows for a table output. row_index defaults to the
                             position (it is what a "#" rule compares).
    gt_headers/gt_rows       this input's ground-truth rows (lists aligned with gt_headers); gtRowIndex / gtNum /
                             a "Ground truth: #" rule refer to positions in gt_rows.

    Returns {"verifyRows", "matchedCount", "total", "runRows", "gtRows"} with the meaning documented at the top.
    """
    results = []
    for pos, row in enumerate(run_rows or []):
        row = dict(row) if isinstance(row, dict) else {"output": row}
        if "row_index" not in row or not _is_number(row.get("row_index")):
            row["row_index"] = pos
        row["input_row_index"] = 0
        results.append(row)
    gt_rows = list(gt_rows or [])
    full = evaluate_score_output_gt(
        score_mapping=score_mapping,
        score_match_code=score_match_code,
        results=results,
        input_entries=[[0, {"gtRows": [{"gtRowIndex": i} for i in range(len(gt_rows))]}]],
        output_fields=output_fields,
        run_ws={"headers": list(input_headers or []), "rows": [list(input_row or [])]},
        gt_content={"headers": list(gt_headers or []), "rows": gt_rows},
        embedding_cosines=embedding_cosines,
        concept_ids=concept_ids,
        embedding_provider=embedding_provider,
        concept_provider=concept_provider,
        python_path=python_path,
        project_session_id=project_session_id,
        match_runner=match_runner,
    )
    one = full["inputs"][0]
    return {"verifyRows": full["verifyRows"], "matchedCount": full["matchedCount"], "total": full["total"],
            "runRows": one["runRows"], "gtRows": one["gtRows"]}


def score_inputs(
    inputs: Iterable[dict],
    *,
    score_mapping: Any = None,
    score_match_code: Any = "",
    input_headers: list | None = None,
    gt_headers: list | None = None,
    output_fields: list | None = None,
    embedding_cosines: Any = None,
    concept_ids: Any = None,
    embedding_provider: EmbeddingProvider | None = None,
    concept_provider: ConceptProvider | None = None,
    python_path: str | None = None,
    project_session_id: str | None = None,
    match_runner: Callable | None = None,
) -> dict:
    """Batch of `score_input` inputs ({"input_row", "run_rows", "gt_rows"} each) with shared headers, bundle /
    code and embedding / concept caches. Returns {"results": [score_input result per input], "matchedCount",
    "total"} (sums over the inputs)."""
    emb = None if embedding_cosines is not None else _memo_embedding_provider(embedding_provider)
    con = None if concept_ids is not None else _memo_concept_provider(concept_provider)
    if embedding_cosines is not None:
        embedding_cosines = coerce_embedding_map(embedding_cosines)
    if concept_ids is not None:
        concept_ids = coerce_concept_map(concept_ids)
    out = []
    for item in inputs:
        out.append(score_input(
            score_mapping=score_mapping, score_match_code=score_match_code,
            input_headers=input_headers, input_row=item.get("input_row"), run_rows=item.get("run_rows"),
            gt_headers=gt_headers, gt_rows=item.get("gt_rows"), output_fields=output_fields,
            embedding_cosines=embedding_cosines, concept_ids=concept_ids,
            embedding_provider=emb, concept_provider=con,
            python_path=python_path, project_session_id=project_session_id, match_runner=match_runner,
        ))
    return {"results": out, "matchedCount": sum(r["matchedCount"] for r in out), "total": sum(r["total"] for r in out)}
