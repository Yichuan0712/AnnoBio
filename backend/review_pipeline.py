"""
Review analyze pipeline, separate from FastAPI main module.

Phase 1 — per **failed input**: same dataset input; the prompt gives **model output** and **expected output** in **separate sections** (never paired or column-aligned; only non-empty rows appear per section). Then rough opinion.

Phase 1.5 — **cluster** Phase‑1 issues that share the same root cause / fix strategy (one LLM call **only when** there are **more than 5** Phase‑1 issues; otherwise each issue is its own cluster and the clustering LLM is skipped). Fallback when using the LLM: group by `problem_category_hint`.

Phase 2 — **one LLM call per issue cluster** (sequential); **exactly one** localized `prompt_edit` per cluster must fix **all** findings in that cluster together (no duplicate edits for the same cluster). Identical spans across clusters are still **deduped** once before emit.

Extraction-style tasks: **under-coverage** and **over-coverage** are both failures; Phase 1 instructs the model accordingly.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from rapidfuzz import fuzz, utils

from llm import run_structured as llm_run_structured
from safe_stdio import safe_print

logger = logging.getLogger(__name__)

# Server-side cap on validated edits (response size / UI); not stated in LLM prompts.
_MAX_VALIDATED_PROMPT_EDITS = 64

# Phase 1.5: skip clustering LLM when Phase‑1 issue count ≤ this (singleton cluster per issue).
_PHASE15_SKIP_CLUSTERING_LLM_AT_MOST = 5


def _review_json_for_print(obj: Any) -> str:
    try:
        if isinstance(obj, BaseModel):
            data = obj.model_dump() if hasattr(obj, "model_dump") else obj.dict()
        else:
            data = obj
        return json.dumps(data, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return repr(obj)


def _print_review_result_banner(phase: str, body: str) -> None:
    safe_print(
        "\n" + "=" * 80 + f"\nREVIEW {phase} RESULT\n" + "=" * 80 + "\n" + body + "\n" + "=" * 80 + "\n",
        flush=True,
    )


def _sec_name_content(sec: Any) -> tuple[str, str]:
    if isinstance(sec, dict):
        return (str(sec.get("name") or "").strip() or "(unnamed)", str(sec.get("content") or ""))
    return (str(getattr(sec, "name", "") or "").strip() or "(unnamed)", str(getattr(sec, "content", "") or ""))


def _format_prompt_for_review(prompt_sections: list[Any]) -> str:
    parts: list[str] = []
    for i, sec in enumerate(prompt_sections or []):
        name, content = _sec_name_content(sec)
        parts.append(f"### Section {i}: {name}\n\n{content.strip() or '(empty)'}")
    return "\n\n".join(parts) if parts else "(No prompt sections)"


def _row_to_dict(row: Any) -> dict[str, Any]:
    if hasattr(row, "model_dump"):
        return row.model_dump()
    return dict(row) if isinstance(row, dict) else {}


def _score_row_one_based(d: dict[str, Any]) -> int:
    """1-based row label for LLM/UI: Score # when present, else comparison row_index + 1."""
    st = d.get("score_table_row")
    if st is not None:
        try:
            n = int(st)
            if n >= 1:
                return n
        except (TypeError, ValueError):
            pass
    try:
        return int(d.get("row_index", -1)) + 1
    except (TypeError, ValueError):
        return 0


def _phase1_anchor_comparison_index(group_rows: list[Any]) -> int:
    """Smallest failed comparison `row_index` in the group, else smallest any — never from the LLM."""
    failed: list[int] = []
    all_idx: list[int] = []
    for r in group_rows:
        d = _row_to_dict(r)
        try:
            ri = int(d.get("row_index", -1))
        except (TypeError, ValueError):
            continue
        if ri < 0:
            continue
        all_idx.append(ri)
        if not d.get("matched", False):
            failed.append(ri)
    if failed:
        return int(min(failed))
    if all_idx:
        return int(min(all_idx))
    return 0


def _phase1_input_one_based_from_group(group_rows: list[Any]) -> int:
    """
    1-based worksheet input label for Phase 1 identity / UI (matches ``input_row_index + 1``).
    When ``input_row_index`` is absent, falls back to ``anchor_comparison_row_index + 1`` (1:1 layouts).
    """
    if not group_rows:
        return 1
    d0 = _row_to_dict(group_rows[0])
    iri = d0.get("input_row_index")
    if iri is not None:
        try:
            ii = int(iri)
            if ii >= 0:
                return ii + 1
        except (TypeError, ValueError):
            pass
    anchor = _phase1_anchor_comparison_index(group_rows)
    return int(anchor) + 1


def _cluster_fallback_target_score_labels(
    comparison_rows: list[Any],
    cluster_pairs: list[tuple[PerRowOpinion, list[int]]],
) -> list[int]:
    """1-based Score # labels for all comparison rows in this cluster (server-side; not shown to LLM)."""
    s: set[int] = set()
    for _op, ridxs in cluster_pairs:
        for ri in ridxs or []:
            try:
                ii = int(ri)
            except (TypeError, ValueError):
                continue
            if ii < 0:
                continue
            lbl = _label_one_based_from_comparison_rows(comparison_rows, ii)
            if lbl >= 1:
                s.add(lbl)
    return sorted(s) if s else [1]


def _label_one_based_from_comparison_rows(comparison_rows: list[Any], row_index: int) -> int:
    for r in comparison_rows or []:
        d = _row_to_dict(r)
        try:
            if int(d.get("row_index", -2)) == int(row_index):
                return _score_row_one_based(d)
        except (TypeError, ValueError):
            continue
    try:
        return int(row_index) + 1
    except (TypeError, ValueError):
        return 0


def _valid_comparison_indices(comparison_rows: list[Any]) -> set[int]:
    out: set[int] = set()
    for r in comparison_rows or []:
        d = _row_to_dict(r)
        try:
            out.add(int(d.get("row_index", -3)))
        except (TypeError, ValueError):
            continue
    return {i for i in out if i >= 0}


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
    unicode dashes → ``-``. Same rules apply to section body and to Phase 2 ``old_sentence``.
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


_MD_NUMBERED_ITEM_START = re.compile(r"\s*\d+\.\s")


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


def _resolve_old_sentence_span(section_body: str, old_sentence: str) -> str | None:
    """
    Map Phase 2 ``old_sentence`` to the verbatim substring of ``section_body`` for Accept/Revert.

    Order: cheap exactish → ``rapidfuzz`` → unique-prefix loose (markdown-tolerant).
    """
    content = section_body or ""
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


def _resolve_old_sentence_unique_across_sections(sections: list[Any], raw_old: str) -> str | None:
    """Return the resolved verbatim span when ``raw_old`` matches **exactly one** section body; else ``None``."""
    n = len(sections or [])
    if n == 0 or not (raw_old or "").strip():
        return None
    hits: list[str] = []
    for i in range(n):
        _, cbody = _sec_name_content(sections[i])
        sp = _resolve_old_sentence_span(cbody, raw_old)
        if sp is not None:
            hits.append(sp)
    if len(hits) == 1:
        return hits[0]
    return None


def _targets_zero_based_from_llm(values: list[Any], comparison_rows: list[Any]) -> list[int]:
    """Map Phase 2 list to 0-based comparison row_index: prefer Score # match, then 1-based, then 0-based."""
    valid_idx = _valid_comparison_indices(comparison_rows)
    by_score: dict[int, int] = {}
    for r in comparison_rows or []:
        d = _row_to_dict(r)
        try:
            ri = int(d.get("row_index", -3))
        except (TypeError, ValueError):
            continue
        if ri < 0:
            continue
        st = d.get("score_table_row")
        if st is not None:
            try:
                n = int(st)
                if n >= 1:
                    by_score[n] = ri
            except (TypeError, ValueError):
                pass
    ri_out: list[int] = []
    for x in values or []:
        try:
            v = int(x)
        except (TypeError, ValueError):
            continue
        if v < 0:
            continue
        if v in by_score:
            ri_out.append(by_score[v])
        elif v >= 1 and (v - 1) in valid_idx:
            ri_out.append(v - 1)
        elif v in valid_idx:
            ri_out.append(v)
    return sorted(set(ri_out))


def _input_identity_key(d: dict[str, Any]) -> str:
    """Stable key to group comparison rows that share the same dataset input (1 input → N outputs)."""
    iri = d.get("input_row_index")
    if iri is not None:
        try:
            return f"in:{int(iri)}"
        except (TypeError, ValueError):
            pass
    ri = d.get("row_input")
    if isinstance(ri, dict) and ri:
        return "inp:" + json.dumps(ri, ensure_ascii=False, sort_keys=True, default=str)
    try:
        return f"row:{int(d.get('row_index', -1))}"
    except (TypeError, ValueError):
        return f"row:{d.get('row_index', -1)!s}"


def _group_comparison_rows_by_input(rows: list[Any]) -> list[list[Any]]:
    buckets: dict[str, list[Any]] = {}
    order: list[str] = []
    for r in rows:
        key = _input_identity_key(_row_to_dict(r))
        if key not in buckets:
            order.append(key)
            buckets[key] = []
        buckets[key].append(r)
    groups = [buckets[k] for k in order]
    for g in groups:
        g.sort(key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    return groups


class Phase1LlmOutput(BaseModel):
    """Phase 1 structured output from the LLM only (no row identifiers — server picks anchor row)."""

    card_title: str = Field(
        default="",
        description="Short plain-English UI headline for the failure; not snake_case or a code identifier.",
    )
    issue_summary: str = Field(
        ...,
        description="One or two sentences: what went wrong, relative to the expected output when relevant",
    )
    rough_modification_opinion: str = Field(
        ...,
        description="Rough, prompt-level advice (criteria, wording, format)—not a full rewritten prompt",
    )
    problem_category_hint: str = Field(
        default="",
        description="Short English snake_case or hyphen tag for grouping similar failures.",
    )


class PerRowOpinion(BaseModel):
    """Phase 1 opinion after server fills ``input_index`` (**1-based worksheet input** for UI/events)."""

    input_index: int = Field(
        ...,
        description="1-based worksheet input (input_row_index+1); set server-side, not by the LLM.",
    )
    card_title: str = Field(default="", description="UI headline from Phase 1 LLM")
    issue_summary: str = Field(..., description="Diagnosis from Phase 1 LLM")
    rough_modification_opinion: str = Field(..., description="Rough fix idea from Phase 1 LLM")
    problem_category_hint: str = Field(default="", description="Grouping tag from Phase 1 LLM")


class PromptEditLlm(BaseModel):
    """Phase 2 LLM output for one edit (no target row ids — server fills from cluster)."""

    name: str = Field(
        default="Prompt edit",
        description="Short title for this edit (shown in UI); always set a distinct label when possible",
    )
    phase1_addresses: list[str] = Field(
        ...,
        min_length=1,
        max_length=3,
        description=(
            "1–3 strings naming cluster-diagnosis items this edit fixes; merge when many bullets share one failure class"
        ),
    )
    old_sentence: str = Field(
        ...,
        description="Contiguous substring copied from the stored prompt (unique across sections when possible)",
    )
    new_sentence: str = Field(
        default="",
        description="Replacement; empty string for pure deletion",
    )
    reason: str = Field(
        ...,
        description="How this old→new change implements the fix for the phase1_addresses items (1–2 sentences)",
    )


class PromptEditSuggestion(PromptEditLlm):
    """Same as Phase 2 LLM edit plus comparison-row targets (filled server-side; not in LLM schema)."""

    model_config = ConfigDict(populate_by_name=True)

    target_score_row_indices: list[int] = Field(
        ...,
        min_length=1,
        validation_alias=AliasChoices("target_score_row_indices", "target_input_row_indices"),
        description="Server-filled 1-based Score # labels for this cluster; sanitize maps to 0-based row_index.",
    )


class Phase2ModificationsLlm(BaseModel):
    """Structured output from the Phase 2 LLM (targets added server-side)."""

    prompt_edits: list[PromptEditLlm] = Field(
        default_factory=list,
        description=(
            "Exactly **one** edit for this cluster: one old→new span that fixes **all** Phase‑1 cases grouped here. "
            "Each old_sentence must be resolvable in the stored prompt (prefer spans unique across the full prompt)."
        ),
    )


class Phase15IssueCluster(BaseModel):
    """One cluster of Phase‑1 case ids before Phase 2."""

    member_indices: list[int] = Field(
        ...,
        description="Case ids (0..n-1) from the Phase 1.5 list; each id in exactly one cluster across all clusters",
    )
    group_label: str = Field(
        default="",
        description="Very short optional English label for the cluster.",
    )


class Phase15Clustering(BaseModel):
    """LLM output: partition Phase‑1 issues into non-overlapping clusters."""

    clusters: list[Phase15IssueCluster] = Field(
        ...,
        description="Disjoint clusters; merge only issues one prompt change could fix together",
    )


def _heuristic_issue_cluster_indices(opinions: list[tuple[PerRowOpinion, list[int]]]) -> list[list[int]]:
    """Fallback: group by normalized problem_category_hint (stable order)."""
    buckets: dict[str, list[int]] = {}
    order_keys: list[str] = []
    for i, (op, _) in enumerate(opinions):
        raw = (op.problem_category_hint or "").strip().lower() or "uncategorized"
        key = raw.replace(" ", "_")[:80]
        if key not in buckets:
            order_keys.append(key)
            buckets[key] = []
        buckets[key].append(i)
    return [sorted(buckets[k]) for k in order_keys]


def _normalize_cluster_member_indices(n: int, clusters: list[Phase15IssueCluster]) -> list[list[int]]:
    """Ensure each index0..n-1 appears at most once; append singletons for gaps."""
    assigned = [False] * n
    out: list[list[int]] = []
    for c in clusters or []:
        members: list[int] = []
        for i in c.member_indices or []:
            try:
                ii = int(i)
            except (TypeError, ValueError):
                continue
            if 0 <= ii < n and not assigned[ii]:
                assigned[ii] = True
                members.append(ii)
        if members:
            out.append(sorted(members))
    for i in range(n):
        if not assigned[i]:
            out.append([i])
    return out


def _build_phase15_clustering_prompt(*, opinions: list[tuple[PerRowOpinion, list[int]]]) -> str:
    lines: list[str] = []
    for i, (op, ridxs) in enumerate(opinions):
        head = (op.card_title or "").strip() or op.issue_summary
        summ = (op.issue_summary or "").strip().replace("\n", " ")
        if len(summ) > 220:
            summ = summ[:217] + "..."
        cat = (op.problem_category_hint or "uncategorized").strip()
        lines.append(
            f"- **Case {i}** | [{cat}] **{head}**\n"
            f"  Summary: {summ}"
        )
    issues_block = "\n".join(lines) if lines else "(no issues)"
    return f"""Cluster Phase‑1 diagnoses for the next step: one prompt-edit pass per cluster.

Phase 2 will output **one** merged prompt change per cluster (not several edits that all fix the same clustered cases).

Case IDs are **0 … {len(opinions) - 1}** only (not worksheet or score row ids). Cases are a **linear list**; do not pair or align cases unless the text itself links them.

Rules:
- Same cluster only if **one** instruction change can fix **both** with the same root cause.
- Do not merge unrelated failure types.
- Each case id appears in **exactly one** cluster.
- Prefer fewer clusters; use a singleton when unsure.

Cases:

{issues_block}

Return JSON **`clusters`** only: each item has `member_indices` (ints from the case id list) and optional `group_label`.
"""


def _cluster_opinions_for_phase2(
    *,
    opinions: list[tuple[PerRowOpinion, list[int]]],
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
    is_cancelled: Callable[[], bool],
) -> list[list[int]]:
    n = len(opinions)
    result_source = ""
    final: list[list[int]]
    llm_parsed: Phase15Clustering | None = None

    if n == 0:
        final = []
        result_source = "no_llm_empty_issue_list"
        safe_print(
            "\n"
            + "=" * 80
            + "\nREVIEW PHASE 1.5 — skipped (0 Phase-1 issues)\n"
            + "=" * 80
            + "\n",
            flush=True,
        )
    elif n <= _PHASE15_SKIP_CLUSTERING_LLM_AT_MOST:
        final = [[i] for i in range(n)]
        result_source = f"no_llm_n_le_{_PHASE15_SKIP_CLUSTERING_LLM_AT_MOST}_singleton_clusters"
        safe_print(
            "\n"
            + "=" * 80
            + f"\nREVIEW PHASE 1.5 PROMPT — skipped ({n} Phase-1 issue(s) ≤ {_PHASE15_SKIP_CLUSTERING_LLM_AT_MOST}; "
            "one cluster per issue, no clustering LLM)\n"
            + "=" * 80
            + "\n",
            flush=True,
        )
    elif is_cancelled():
        final = [[i] for i in range(n)]
        result_source = "no_llm_cancelled"
        safe_print(
            "\n"
            + "=" * 80
            + "\nREVIEW PHASE 1.5 PROMPT — skipped (cancelled before LLM)\n"
            + "=" * 80
            + "\n",
            flush=True,
        )
    else:
        prompt = _build_phase15_clustering_prompt(opinions=opinions)
        safe_print(
            "\n"
            + "=" * 80
            + "\nREVIEW PHASE 1.5 PROMPT (issue clustering)"
            + f" ({n} issues, {len(prompt)} chars)\n"
            + "=" * 80
            + "\n"
            + prompt
            + "\n"
            + "=" * 80
            + "\n",
            flush=True,
        )
        try:
            out, _ = llm_run_structured(
                provider=provider,
                model=model,
                api_key=api_key,
                prompt=prompt,
                response_model=Phase15Clustering,
                max_tokens=max_tokens,
            )
            if isinstance(out, dict):
                parsed = Phase15Clustering(**out)
            elif isinstance(out, Phase15Clustering):
                parsed = out
            else:
                parsed = Phase15Clustering(
                    **(out.model_dump() if hasattr(out, "model_dump") else out.dict())
                )
            llm_parsed = parsed
            normalized = _normalize_cluster_member_indices(n, list(parsed.clusters or []))
            if len(normalized) == 0:
                final = _heuristic_issue_cluster_indices(opinions)
                result_source = "heuristic_empty_normalized_clusters"
            else:
                covered = sum(len(c) for c in normalized)
                if covered != n:
                    logger.warning("Phase 1.5 clustering covered %s/%s indices; using heuristic", covered, n)
                    final = _heuristic_issue_cluster_indices(opinions)
                    result_source = "heuristic_partial_index_coverage"
                else:
                    final = normalized
                    result_source = "llm"
        except Exception as e:
            logger.warning("Phase 1.5 clustering failed (%s); using heuristic buckets", e)
            final = _heuristic_issue_cluster_indices(opinions)
            result_source = "heuristic_after_exception"

    report: dict[str, Any] = {"how": result_source, "clusters_member_indices": final}
    if llm_parsed is not None:
        report["llm_structured_output"] = (
            llm_parsed.model_dump() if hasattr(llm_parsed, "model_dump") else llm_parsed.dict()
        )
    _print_review_result_banner("PHASE 1.5", _review_json_for_print(report))
    return final


def _phase1_row_has_no_model_output(d: dict[str, Any]) -> bool:
    """Match app `reviewPreviewRowHasNoModelOutput`: GT-only or empty run_output (all keys empty)."""
    if bool(d.get("gt_only")):
        return True
    ro = d.get("run_output")
    if not isinstance(ro, dict):
        ro = {}
    keys = list(ro.keys())
    if not keys:
        return True
    for _k, v in ro.items():
        if v is None:
            continue
        if isinstance(v, str) and not str(v).strip():
            continue
        if isinstance(v, list) and len(v) == 0:
            continue
        return False
    return True


def _is_model_facing_output_key(key: str) -> bool:
    """True when a ground_truth_output key should be shown to the LLM (skips internal metadata keys like [#], [rule_targets])."""
    k = str(key or "").strip()
    if not k or k in ("#", "[#]"):
        return False
    if len(k) >= 2 and k.startswith("[") and k.endswith("]"):
        return False
    return True


def _phase1_row_has_no_ground_truth(d: dict[str, Any]) -> bool:
    """Match app `reviewPreviewRowHasNoGroundTruth`: empty ground_truth_output and no expected text."""
    gto = d.get("ground_truth_output")
    if not isinstance(gto, dict):
        gto = {}
    keys = list(gto.keys())
    if not keys:
        gto_all_empty = True
    else:
        gto_all_empty = True
        for _k, v in gto.items():
            if v is None:
                continue
            if isinstance(v, str) and not str(v).strip():
                continue
            if isinstance(v, list) and len(v) == 0:
                continue
            gto_all_empty = False
            break
    exp = d.get("expected")
    exp_s = "" if exp is None else " ".join(str(exp).split()).strip()
    exp_empty = exp_s == "" or exp_s == "—"
    return gto_all_empty and exp_empty


def _phase1_format_nonempty_lines_json(items: list[tuple[int, dict[str, Any]]], *, empty_note: str) -> str:
    """Phase 1: only list rows that have content; single item → bare JSON; multiple → Line n labels + JSON each."""
    if not items:
        return empty_note
    if len(items) == 1:
        _i, d = items[0]
        return f"```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```"
    parts: list[str] = []
    for idx, d in items:
        parts.append(
            f"**Line {idx}**\n\n```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```"
        )
    return "\n\n".join(parts)


def _phase1_format_gt_lines_json(
    items: list[tuple[int | None, dict[str, Any]]], *, empty_note: str
) -> str:
    """Phase 1: format GT rows labeled by 1-based ground-truth row number ('Ground truth #N'); single item → bare JSON."""
    if not items:
        return empty_note
    if len(items) == 1:
        _gt_num, d = items[0]
        return f"```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```"
    parts: list[str] = []
    for gt_num, d in items:
        label = f"Ground truth #{gt_num}" if gt_num is not None else "Ground truth"
        parts.append(f"**{label}**\n\n```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```")
    return "\n\n".join(parts)


def _phase1_group_context_parts(group_rows: list[Any]) -> tuple[str, str]:
    """
    Shared Phase 1 row context: (scope paragraph, markdown from Placeholder substitutions through Expected output).
    Used by Phase 1 prompts and Phase 2 cluster blocks so the edit LLM sees the same input/model/GT as Phase 1.
    """
    if not group_rows:
        return ("", "")

    def _ground_truth_output_dict(d: dict[str, Any]) -> dict[str, Any]:
        gto = d.get("ground_truth_output")
        if isinstance(gto, dict):
            return dict(gto)
        return {}

    ordered_rows = sorted(group_rows, key=lambda x: int(_row_to_dict(x).get("row_index", 0)))

    first = _row_to_dict(ordered_rows[0])
    row_input: dict[str, Any] = first.get("row_input") or {}
    mo_items: list[tuple[int, dict[str, Any]]] = []
    gt_items: list[tuple[int | None, dict[str, Any]]] = []
    seen_gt_indices: set[int | None] = set()
    for i, r in enumerate(ordered_rows, start=1):
        d = _row_to_dict(r)
        if not _phase1_row_has_no_model_output(d):
            run_output = d.get("run_output") or {}
            mo = dict(run_output) if isinstance(run_output, dict) else {}
            mo_items.append((i, mo))
        if not _phase1_row_has_no_ground_truth(d):
            sgi = d.get("source_gt_row_index")
            gt_num = int(sgi) + 1 if sgi is not None else None
            if gt_num not in seen_gt_indices:
                seen_gt_indices.add(gt_num)
                gt_obj = {k: v for k, v in _ground_truth_output_dict(d).items() if _is_model_facing_output_key(k)}
                if gt_obj:
                    gt_items.append((gt_num, gt_obj))

    model_body = _phase1_format_nonempty_lines_json(
        mo_items,
        empty_note="*None — no model output on any row for this input.*",
    )
    expected_body = _phase1_format_gt_lines_json(
        gt_items,
        empty_note="*None — no expected output on any row for this input.*",
    )
    n_lines = len(ordered_rows)
    n_failed = sum(1 for r in group_rows if not _row_to_dict(r).get("matched", False))
    multi = n_lines > 1
    mixed = n_failed > 0 and n_failed < n_lines
    if multi:
        if mixed:
            scope = (
                "One dataset input; several scoring rows. Some rows satisfied the rubric, some did not. "
                "Infer what already works from the full picture; focus the diagnosis on incorrect or missing behavior."
            )
        else:
            scope = (
                "One dataset input; several scoring rows. **Model output** and **Expected output** are two independent sections. "
                "Each section lists only rows that have content for that section; completely empty rows are omitted."
            )
    else:
        scope = "One scoring row for this input; follow the layout rules below."

    input_num = _phase1_input_one_based_from_group(group_rows)
    subs_out = f"""## Input #{input_num} — Placeholder substitutions (values inserted into the template for this run)

```json
{json.dumps(row_input, ensure_ascii=False, indent=2)}
```

## Model output

What the task model returned.

{model_body}

## Expected output

Ground truth used for scoring.

{expected_body}"""
    return (scope, subs_out)


def _build_phase1_prompt_for_input_group(*, prompt_text: str, group_rows: list[Any]) -> str:
    if not group_rows:
        return ""
    scope, subs_out = _phase1_group_context_parts(group_rows)
    return f"""Diagnose scoring failures for **one** dataset input.

**Layout:** Do not treat **Model output** and **Expected output** as left/right columns or matched pairs. Read each section on its own. **Model output `Line n`** is the n-th model result listed; **`Ground truth #N`** identifies the expected output by its ground-truth row number. They are independent and do not pair by position.

{scope}

## Prompt template (placeholders not yet substituted)

{prompt_text}

{subs_out}

## Output (JSON only)

- **card_title**: Short plain-English headline; not snake_case or code-like.
- **issue_summary**: Describe the failure; reference the expected output when relevant; note missing or extra extractive items when relevant.
- **rough_modification_opinion**: Concrete prompt-level changes only; do not paste a full rewritten prompt.
- **problem_category_hint**: Short grouping tag in English snake_case or hyphen form.

When **Model output** is missing or empty, infer how the **prompt template** should be clearer or stricter so extraction is **more complete and reliable**—not generic “always emit output” unless the template truly lacks required fields or shape. When **Expected output** is missing or empty, still reason about tightening or clarifying the **prompt** so behavior is **more precise** where scoring is possible. When both sides have content, treat **extra** model items vs GT as over-generation (tighten constraints) and **missing** items as **under-spec**—including **partial** under-coverage (**fewer** extractive items, rows, or relations than expected, not only a wholly empty model section): say what is missing vs expected and how the prompt should be expanded, clarified, or exemplified. Never mention internal code, class, or schema names (e.g. Python types) in any field.

Return only those four fields.
"""


def _comparison_rows_by_indices(comparison_rows: list[Any], ridxs: list[int]) -> list[Any]:
    """Restore Phase 1 input-group rows from 0-based comparison ``row_index`` list."""
    want: set[int] = set()
    for x in ridxs or []:
        try:
            want.add(int(x))
        except (TypeError, ValueError):
            continue
    if not want:
        return []
    out = [r for r in comparison_rows if int(_row_to_dict(r).get("row_index", -2)) in want]
    out.sort(key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    return out


def _phase2_single_issue_block(*, op: PerRowOpinion, group_rows: list[Any]) -> str:
    rough = op.rough_modification_opinion.strip()
    if len(rough) > 1200:
        rough = rough[:1197] + "..."
    head = (op.card_title or "").strip() or op.issue_summary
    scope, subs_out = _phase1_group_context_parts(group_rows)
    if not subs_out.strip():
        data_section = "*No comparison row payloads matched this case (missing `row_index` data).*"
    else:
        data_section = (
            "**Run context (same subsections as Phase 1 for this worksheet input; the full prompt template is in `Stored prompt` above):**\n\n"
            "**Layout:** Do not treat **Model output** and **Expected output** as left/right columns or matched pairs. "
            "Read each section on its own. **Model output `Line n`** is the n-th model result listed; **`Ground truth #N`** identifies the expected output by its ground-truth row number. They are independent and do not pair by position.\n\n"
            f"{scope}\n\n"
            f"{subs_out}"
        )
    return (
        f"### Case — worksheet Input #{op.input_index}\n\n"
        f"{data_section}\n\n"
        f"#### Review diagnosis for this case\n"
        f"- **category:** `{op.problem_category_hint or 'uncategorized'}`\n"
        f"- **label:** {head}\n"
        f"- **detail:** {op.issue_summary}\n"
        f"- **rough_fix_idea:** {rough}"
    )


def _phase2_cluster_label(cluster_pairs: list[tuple[PerRowOpinion, list[int]]]) -> str:
    hints = sorted(
        {
            (op.problem_category_hint or "").strip()
            for op, _ in cluster_pairs
            if (op.problem_category_hint or "").strip()
        }
    )
    if hints:
        return ", ".join(hints[:3])
    t0 = (cluster_pairs[0][0].card_title or cluster_pairs[0][0].issue_summary or "").strip()
    return (t0[:120] if t0 else "issue cluster")


def _build_phase2_modifications_prompt(
    *,
    prompt_text: str,
    opinions_text: str,
    cluster_context: str = "",
) -> str:
    """One Phase 2 LLM call for one **cluster** of Phase 1 issues (single input group or merged related findings)."""
    scope_line = (
        f"**Cluster:** {cluster_context.strip()}\n\n" if (cluster_context or "").strip() else ""
    )
    coverage_rule = (
        "- Phase 1.5 placed **every finding below** in **this cluster** because they share **one** root-cause fix.\n"
        "- Return **`prompt_edits` with exactly one object**: a single `old_sentence`→`new_sentence` edit that fixes **all** of them together. "
        "Use `phase1_addresses` (and `reason`) to cite every diagnosis item this one change addresses.\n"
        "- Do **not** output two or more edits that both solve this same cluster (no redundant parallel fixes).\n"
        "- No generic polish unrelated to the cluster."
    )
    return f"""Produce minimal **localized** edits to the stored prompt so behavior matches the cluster diagnosis. Output only `prompt_edits`.

The **stored prompt** block and the **cluster diagnosis** block are separate—read in order; do not treat them as columns or side-by-side panels.

{scope_line}Rules:
- `old_sentence` must be copied verbatim from **one** place in the stored prompt below. Prefer a span that appears **only once** in the full prompt so the server can resolve it unambiguously.
- If the diagnosis lists any finding, return **exactly one** edit in `prompt_edits` (see coverage rules). Empty `prompt_edits` only when the stored prompt has no section bodies.
- Do not paste diagnosis markdown into `old_sentence`.
- Edits must improve **task prompt** extraction: **fuller** where the model under-delivers vs expected (including **partial** gaps—fewer items than expected—not only wholly empty model output), **stricter** where it over-generates vs expected. Prefer diagnosis-driven wording in the stored prompt over blanket “emit output every row” unless the template truly omits required output spec.
- **`name` and `reason`**: end-user plain English only; **never** Python/Pydantic/class names, `Phase1LlmOutput`, or other internal identifiers.

{coverage_rule}

## Stored prompt (same layout as Phase 1 review; sole source for `old_sentence`)

{prompt_text}

## Cluster diagnosis (never use as `old_sentence`)

Each **Case** block repeats **placeholder substitutions**, **model output**, and **expected output** for that worksheet input, then the **Review diagnosis** lines. The prompt template itself appears only in **Stored prompt** above.

{opinions_text}

## `prompt_edits` fields

- **name**: Short UI label.
- **phase1_addresses**: 1–3 strings; prefer diagnosis **label** lines.
- **old_sentence**: Contiguous substring from the stored prompt (see rules above).
- **new_sentence**: Replacement, or `""` to delete.
- **reason**: How this fixes the cited diagnosis items.

Invalid spans are dropped server-side.

Return **`prompt_edits`** only.
"""


def _phase2_old_sentence_smells_diagnosis_leak(raw: str) -> bool:
    """True if the model pasted cluster-diagnosis markdown into old_sentence (never valid)."""
    t = (raw or "").strip()
    if not t:
        return False
    head = t[:200]
    tl = head.lower()
    if "score row(s)" in tl:
        return True
    if t.startswith("#### Finding"):
        return True
    if t.startswith("- **category:**") or t.startswith("- **detail:**") or t.startswith("- **label:**"):
        return True
    if "**rough_fix_idea:**" in head:
        return True
    return False


def _sanitize_prompt_edits(
    sections: list[Any],
    edits: list[PromptEditSuggestion],
    comparison_rows: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Keep edits whose ``old_sentence`` resolves in **exactly one** section body (verbatim span for UI apply)."""
    out: list[dict[str, Any]] = []
    n = len(sections or [])
    if n == 0:
        return out
    cr = list(comparison_rows or [])
    for e in edits:
        raw_old = e.old_sentence or ""
        if not raw_old.strip():
            continue
        if _phase2_old_sentence_smells_diagnosis_leak(raw_old):
            safe_print(
                f"[Review] Phase 2 edit skipped (old_sentence is diagnosis text, not stored prompt): {raw_old[:120]!r}",
                flush=True,
            )
            continue
        old = _resolve_old_sentence_unique_across_sections(sections, raw_old)
        if old is None:
            continue
        new = e.new_sentence if e.new_sentence is not None else ""
        if not isinstance(new, str):
            new = str(new)
        raw_targets = getattr(e, "target_score_row_indices", None) or getattr(
            e, "target_input_row_indices", None
        )
        if not isinstance(raw_targets, list):
            raw_targets = []
        ri = _targets_zero_based_from_llm(raw_targets, cr)
        if not ri:
            continue
        p1: list[str] = []
        raw_p1 = getattr(e, "phase1_addresses", None)
        if isinstance(raw_p1, list):
            for x in raw_p1:
                s = str(x).strip()
                if s:
                    p1.append(s[:500])
                    if len(p1) >= 3:
                        break
        if not p1:
            continue
        out.append(
            {
                "name": (e.name or "Prompt edit").strip()[:200],
                "phase1_addresses": p1,
                "old_sentence": old,
                "new_sentence": new,
                "reason": (e.reason or "").strip(),
                "target_score_row_indices": ri,
                "row_indices": ri,
            }
        )
        if len(out) >= _MAX_VALIDATED_PROMPT_EDITS:
            break
    return out


_PHASE2_FALLBACK_ANCHOR_CANDIDATES: tuple[str, ...] = (
    "Providing these identifiers from the source ensures other scientists can accurately look up the entry in UniProt.",
    "Whenever possible, use standardized identifiers:",
)


def _phase2_edits_when_llm_abstains(
    sections: list[Any],
    cluster_pairs: list[tuple[PerRowOpinion, list[int]]],
) -> list[PromptEditLlm]:
    """
    If Phase2 returns an empty ``prompt_edits`` list, emit one anchored edit so the UI still receives suggestions.
    Anchors on the WORKFLOW **Normalize Names** paragraph when that wording exists in stored sections.
    """
    if not cluster_pairs:
        return []
    p1: list[str] = []
    for op, _ in cluster_pairs:
        lab = ((op.card_title or "").strip() or (op.issue_summary or "").strip())[:200]
        if lab and lab not in p1:
            p1.append(lab)
        if len(p1) >= 3:
            break
    if not p1:
        p1 = ["Cluster findings"]
    bits: list[str] = []
    for op, _ in cluster_pairs:
        r = (op.rough_modification_opinion or "").strip()
        if r and r not in bits:
            bits.append(r[:500])
    tail = " ".join(bits)[:900].strip()
    guidance = (
        "Also require mapping holoenzyme, complex, or informal protein names to **gene symbols** required by scoring, "
        "and emit **every distinct** phosphatase–substrate pair the passage supports, including multiple isoforms on one substrate when the text implies them."
    )
    if tail:
        guidance = (guidance + " Context from diagnosis: " + tail[:450]).strip()

    old_span: str | None = None
    for sec in sections or []:
        _, body = _sec_name_content(sec)
        for cand in _PHASE2_FALLBACK_ANCHOR_CANDIDATES:
            resolved = _resolve_old_sentence_span(body, cand)
            if resolved:
                old_span = resolved
                break
        if old_span:
            break
    if not old_span:
        safe_print(
            "[Review] Phase 2 fallback skipped (no Normalize Names anchor in stored sections).",
            flush=True,
        )
        return []

    new_sent = (old_span.rstrip() + " " + guidance).strip()
    return [
        PromptEditLlm(
            name="Clarify normalization and multi-pair coverage",
            phase1_addresses=p1,
            old_sentence=old_span,
            new_sentence=new_sent,
            reason=(
                "Phase 2 returned no edits; this server fallback extends the Normalize Names line in the stored prompt so the run "
                "still yields an applyable patch aligned with the cluster diagnosis."
            ),
        )
    ]


def _analyze_input_group(
    *,
    group_rows: list[Any],
    prompt_text: str,
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
) -> tuple[PerRowOpinion, list[int]]:
    prompt = _build_phase1_prompt_for_input_group(prompt_text=prompt_text, group_rows=group_rows)
    idxs_all = sorted({int(_row_to_dict(r).get("row_index", -1)) for r in group_rows})
    failed_idxs = sorted(
        {
            int(_row_to_dict(r).get("row_index", -1))
            for r in group_rows
            if not _row_to_dict(r).get("matched", False)
        }
    )
    safe_print(
        "\n"
        + "=" * 80
        + "\nREVIEW PHASE 1 PROMPT (per input group)"
        + f" (all row_index: {idxs_all}, failed: {failed_idxs}, {len(prompt)} chars)\n"
        + "=" * 80
        + "\n"
        + prompt
        + "\n"
        + "=" * 80
        + "\n",
        flush=True,
    )
    out, _ = llm_run_structured(
        provider=provider,
        model=model,
        api_key=api_key,
        prompt=prompt,
        response_model=Phase1LlmOutput,
        max_tokens=max_tokens,
    )
    if isinstance(out, dict):
        diag = Phase1LlmOutput(**out)
    elif isinstance(out, Phase1LlmOutput):
        diag = out
    else:
        diag = Phase1LlmOutput(**(out.model_dump() if hasattr(out, "model_dump") else out.dict()))
    input_one_based = _phase1_input_one_based_from_group(group_rows)
    op = PerRowOpinion(input_index=int(input_one_based), **diag.model_dump())
    _print_review_result_banner("PHASE 1", _review_json_for_print(op))
    return op, idxs_all


def run_review_pipeline(
    *,
    provider: str,
    model: str,
    api_key: str,
    body: Any,
    max_tokens: int,
    max_failed_inputs: int,
    is_cancelled: Callable[[], bool],
    append_event: Callable[[dict], None],
) -> None:
    """
    Drive review. Emits: plan, diagnosis_row, suggestions, done.
    Caller handles credential errors and job status.
    """
    sections = list(getattr(body, "prompt_sections", None) or [])
    prompt_text = _format_prompt_for_review(sections)
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])

    all_matched_flag = getattr(body, "all_rows_matched", None)
    if all_matched_flag is True:
        append_event({"type": "plan", "summary": "All rows matched — nothing to review.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    unmatched = [r for r in comparison_rows if not _row_to_dict(r).get("matched", False)]
    if not unmatched:
        append_event({"type": "plan", "summary": "No unmatched rows.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    max_in = max(1, min(200, int(max_failed_inputs)))
    all_groups = _group_comparison_rows_by_input(comparison_rows)
    failed_groups = [
        g
        for g in all_groups
        if any(not _row_to_dict(r).get("matched", False) for r in g)
    ]
    groups = failed_groups[:max_in]
    n = len(groups)
    unmatched_rows_in_scope = sum(
        1 for g in groups for r in g if not _row_to_dict(r).get("matched", False)
    )
    append_event(
        {
            "type": "plan",
            "summary": (
                f"Phase 1: analyzing {n} input group(s) with failures (cap {max_in} failed input(s) by settings; "
                f"{unmatched_rows_in_scope} unmatched comparison row(s) in scope); "
                "each prompt includes every comparison row for that input (matched + unmatched). "
                f"Phase 1.5: if more than {_PHASE15_SKIP_CLUSTERING_LLM_AT_MOST} Phase-1 issues, cluster related issues "
                "(one LLM call; fallback: group by category hint); "
                f"if ≤{_PHASE15_SKIP_CLUSTERING_LLM_AT_MOST} issues, one cluster per issue (no clustering LLM). "
                "Phase 2: one prompt-edit per cluster (sequential; one merged edit fixes all cases in the cluster); "
                "duplicate spans across clusters are deduped once."
            ),
            "diagnosis_total": n,
        }
    )

    if is_cancelled():
        return

    opinions: list[tuple[PerRowOpinion, list[int]]] = []

    def one_group(g: list[Any]) -> tuple[PerRowOpinion, list[int]]:
        return _analyze_input_group(
            group_rows=g,
            prompt_text=prompt_text,
            provider=provider,
            model=model,
            api_key=api_key,
            max_tokens=max_tokens,
        )

    done_n = 0
    for g in groups:
        if is_cancelled():
            return
        op, ridxs = one_group(g)
        opinions.append((op, ridxs))
        done_n += 1
        append_event(
            {
                "type": "diagnosis_row",
                "input_index": op.input_index,
                "row_indices": ridxs,
                "done": done_n,
                "total": n,
                "opinion": {
                    "card_title": op.card_title or "",
                    "issue_summary": op.issue_summary,
                    "rough_modification_opinion": op.rough_modification_opinion,
                    "problem_category_hint": op.problem_category_hint or "",
                },
            }
        )

    opinions.sort(key=lambda t: t[0].input_index)

    if is_cancelled():
        return

    cluster_members = _cluster_opinions_for_phase2(
        opinions=opinions,
        provider=provider,
        model=model,
        api_key=api_key,
        max_tokens=max_tokens,
        is_cancelled=is_cancelled,
    )
    n_clusters = len(cluster_members)
    cluster_labels = [_phase2_cluster_label([opinions[i] for i in cm]) for cm in cluster_members]

    if is_cancelled():
        return

    def run_one_phase2(pair: tuple[int, list[int]]) -> tuple[int, str, list[PromptEditSuggestion]]:
        cluster_idx, member_indices = pair
        if is_cancelled():
            safe_print(
                "\n"
                + "=" * 80
                + f"\nREVIEW PHASE 2 PROMPT — skipped (cancelled) cluster {cluster_idx + 1}/{n_clusters}\n"
                + "=" * 80
                + "\n",
                flush=True,
            )
            _print_review_result_banner(
                f"PHASE 2 (cluster {cluster_idx + 1}/{n_clusters}) — skipped",
                _review_json_for_print({"cancelled": True, "prompt_edits": []}),
            )
            return cluster_idx, cluster_labels[cluster_idx], []
        cluster_pairs = [opinions[i] for i in member_indices]
        blocks = [
            _phase2_single_issue_block(op=op, group_rows=_comparison_rows_by_indices(comparison_rows, ridxs))
            for op, ridxs in cluster_pairs
        ]
        opinions_text = "\n\n---\n\n".join(blocks)
        label = cluster_labels[cluster_idx]
        mod_prompt = _build_phase2_modifications_prompt(
            prompt_text=prompt_text,
            opinions_text=opinions_text,
            cluster_context=label,
        )
        logger.info(
            "Review phase 2 prompt (cluster %s/%s, %s issue(s)) length: %s chars",
            cluster_idx + 1,
            n_clusters,
            len(cluster_pairs),
            len(mod_prompt),
        )
        safe_print(
            "\n"
            + "=" * 80
            + "\nREVIEW PHASE 2 PROMPT"
            + f" (cluster {cluster_idx + 1}/{n_clusters}, member_indices={member_indices}, {len(mod_prompt)} chars)\n"
            + "=" * 80
            + "\n"
            + mod_prompt
            + "\n"
            + "=" * 80
            + "\n",
            flush=True,
        )
        out_mod, _ = llm_run_structured(
            provider=provider,
            model=model,
            api_key=api_key,
            prompt=mod_prompt,
            response_model=Phase2ModificationsLlm,
            max_tokens=max_tokens,
        )
        if isinstance(out_mod, dict):
            mod_raw = Phase2ModificationsLlm(**out_mod)
        elif isinstance(out_mod, Phase2ModificationsLlm):
            mod_raw = out_mod
        else:
            mod_raw = Phase2ModificationsLlm(
                **(out_mod.model_dump() if hasattr(out_mod, "model_dump") else out_mod.dict())
            )
        target_labels = _cluster_fallback_target_score_labels(comparison_rows, cluster_pairs)
        raw_llm_edits = list(mod_raw.prompt_edits or [])
        if not raw_llm_edits:
            safe_print(
                "[Review] Phase 2 LLM returned empty prompt_edits; applying anchored fallback if possible.",
                flush=True,
            )
            raw_llm_edits = _phase2_edits_when_llm_abstains(sections, cluster_pairs)
        full_edits: list[PromptEditSuggestion] = []
        tgt = list(target_labels)
        for el in raw_llm_edits:
            full_edits.append(
                PromptEditSuggestion(**el.model_dump(), target_score_row_indices=tgt),
            )
        _print_review_result_banner(
            f"PHASE 2 (cluster {cluster_idx + 1}/{n_clusters})",
            _review_json_for_print(
                {
                    "llm_output": mod_raw.model_dump() if hasattr(mod_raw, "model_dump") else mod_raw.dict(),
                    "target_score_row_indices_filled_server_side": target_labels,
                    "prompt_edits": [e.model_dump() if hasattr(e, "model_dump") else e.dict() for e in full_edits],
                }
            ),
        )
        return cluster_idx, label, full_edits

    indexed_pairs = list(enumerate(cluster_members))
    seen_edit: set[tuple[str, str]] = set()
    edit_dict_count = 0
    deduped_for_empty_log: list[tuple[int, str, PromptEditSuggestion]] = []

    for pair in indexed_pairs:
        if is_cancelled():
            return
        cidx, label, edits = run_one_phase2(pair)
        for e in edits:
            old = (e.old_sentence or "").strip()
            new = e.new_sentence if e.new_sentence is not None else ""
            if not isinstance(new, str):
                new = str(new)
            key = (old, new)
            if key in seen_edit:
                continue
            seen_edit.add(key)
            deduped_for_empty_log.append((cidx, label, e))
            if edit_dict_count >= _MAX_VALIDATED_PROMPT_EDITS:
                break
            batch = _sanitize_prompt_edits(sections, [e], comparison_rows)
            for d in batch:
                d["issue_cluster_index"] = cidx
                d["issue_cluster_label"] = label
                if edit_dict_count >= _MAX_VALIDATED_PROMPT_EDITS:
                    break
                append_event({"type": "suggestions", "suggestions": [d]})
                edit_dict_count += 1
            if edit_dict_count >= _MAX_VALIDATED_PROMPT_EDITS:
                break
        if edit_dict_count >= _MAX_VALIDATED_PROMPT_EDITS:
            break

    if is_cancelled():
        return

    if edit_dict_count == 0 and deduped_for_empty_log:
        cr = list(comparison_rows or [])
        for cidx, label, e in deduped_for_empty_log[:5]:
            raw_old = e.old_sentence or ""
            resolved = _resolve_old_sentence_unique_across_sections(sections, raw_old)
            raw_t = getattr(e, "target_score_row_indices", None) or getattr(
                e, "target_input_row_indices", None
            )
            mapped = _targets_zero_based_from_llm(raw_t if isinstance(raw_t, list) else [], cr)
            safe_print(
                f"[Review] Phase 2 suggestion dropped (sanitize): cluster={cidx} label={label!r} "
                f"old_resolved={resolved is not None} "
                f"targets_raw={raw_t!r} targets_mapped={mapped!r} old_preview={raw_old[:120]!r}",
                flush=True,
            )

    append_event({"type": "done"})
