"""
Review analyze pipeline, separate from FastAPI main module.

Phase 1 — per **failed input**: same dataset input; the prompt gives **model output** and **expected output** in **separate sections** (never paired or column-aligned; only non-empty rows appear per section). Then rough opinion.

Phase 1.5 — **cluster** Phase‑1 issues that share the same root cause / fix strategy (one LLM call). Fallback: group by `problem_category_hint`.

Phase 2 — **one LLM call per issue cluster** (sequential); PART C of the Phase 2 meta-prompt lists cluster findings; localized `prompt_edits` must cover them. Identical spans are still **deduped** once before emit.

Extraction-style tasks: **under-coverage** (required items missing) and **over-coverage** (extra items not in ground truth) are both failures—the prompts below tell the model to diagnose and fix with that rubric.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable

from pydantic import BaseModel, Field

from llm import run_structured as llm_run_structured
from safe_stdio import safe_print

logger = logging.getLogger(__name__)

# Server-side cap on validated edits (response size / UI); not stated in LLM prompts.
_MAX_VALIDATED_PROMPT_EDITS = 64


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


def format_prompt_for_review(prompt_sections: list[Any]) -> str:
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


def _rows_by_comparison_index(group_rows: list[Any]) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for r in group_rows:
        d = _row_to_dict(r)
        try:
            k = int(d.get("row_index", -3))
        except (TypeError, ValueError):
            continue
        if k >= 0:
            out[k] = d
    return out


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


def resolve_old_sentence_span(section_body: str, old_sentence: str) -> str | None:
    """
    Map Phase 2 ``old_sentence`` to the verbatim substring of ``section_body`` for Accept/Revert.

    Order: exact substring → curly-quote ASCII match → index match when quote-normalization is 1:1
    length-preserving → newline-normalized slice → loose key (ignore ``**``, etc.) with **unique** hit.
    """
    content = section_body or ""
    o = old_sentence or ""
    if not o.strip():
        return None

    def _first_span(needle: str) -> str | None:
        i = content.find(needle)
        return content[i : i + len(needle)] if i >= 0 else None

    hit = _first_span(o)
    if hit is not None:
        return hit

    oq = _normalize_typographic_quotes(o)
    hit = _first_span(oq)
    if hit is not None:
        return hit

    cq = _normalize_typographic_quotes(content)
    if len(cq) == len(content) and oq in cq:
        i = cq.find(oq)
        if i >= 0:
            return content[i : i + len(oq)]

    on = oq.replace("\r\n", "\n").replace("\r", "\n")
    span = _span_from_nc_match(content, on)
    if span is not None:
        return span

    key_c, starts = _loose_match_key_and_starts(content)
    key_o, _ = _loose_match_key_and_starts(o)
    if not key_o:
        return None
    pos = key_c.find(key_o)
    if pos < 0:
        return None
    if key_c.find(key_o, pos + 1) != -1:
        return None
    p1 = pos + len(key_o)
    if pos >= len(starts) or p1 > len(starts) or p1 <= pos:
        return None
    c0 = starts[pos]
    c1 = starts[p1 - 1] + 1
    return content[c0:c1]


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
    """Phase 1 opinion after server fills `row_index` (0-based comparison row_index for this project)."""

    row_index: int = Field(..., description="Anchor comparison row; set server-side, not by the LLM.")
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
            "1–3 strings naming PART C findings this edit fixes; if many bullets are the same failure class, merge into fewer strings"
        ),
    )
    section_index: int = Field(
        0,
        ge=0,
        description="N from `--- Section index N: ---` in PART A (same 0-based slot the app uses for that section body)",
    )
    old_sentence: str = Field(
        ...,
        description="Contiguous substring from the PART A body under that section header (server resolves minor ** / quote / newline differences)",
    )
    new_sentence: str = Field(
        default="",
        description="Replacement; empty string for pure deletion",
    )
    reason: str = Field(
        ...,
        description="How this old→new change implements the fix for the phase1_addresses items (1–2 sentences)",
    )


class PromptEditSuggestion(BaseModel):
    """Full prompt edit with targets (after server attaches `target_input_row_indices`)."""

    name: str = Field(..., description="Short title for this edit")
    phase1_addresses: list[str] = Field(
        ...,
        min_length=1,
        max_length=3,
        description="PART C finding labels this edit addresses",
    )
    section_index: int = Field(0, ge=0, description="Section index in PART A")
    old_sentence: str = Field(..., description="Verbatim span from PART A")
    new_sentence: str = Field(default="", description="Replacement text")
    reason: str = Field(..., description="Why this edit fixes the issue(s)")
    target_input_row_indices: list[int] = Field(
        ...,
        min_length=1,
        description="1-based Score # values; filled server-side from the issue cluster.",
    )


class Phase2ModificationsLlm(BaseModel):
    """Structured output from the Phase 2 LLM (targets added server-side)."""

    prompt_edits: list[PromptEditLlm] = Field(
        default_factory=list,
        description=(
            "Every edit MUST address PART C (cluster diagnosis); together they MUST cover those failures. "
            "Each old_sentence must be a substring of the matching PART A section body only."
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
    comparison_rows: list[Any],
    provider: str,
    model: str,
    api_key: str,
    max_tokens: int,
    is_cancelled: Callable[[], bool],
) -> list[list[int]]:
    _ = comparison_rows
    n = len(opinions)
    result_source = ""
    final: list[list[int]]
    llm_parsed: Phase15Clustering | None = None

    if n <= 1:
        final = [[0]] if n == 1 else []
        result_source = "no_llm_single_or_empty_issue_list"
        safe_print(
            "\n"
            + "=" * 80
            + "\nREVIEW PHASE 1.5 PROMPT — skipped (0 or 1 Phase-1 issue; no clustering LLM call)\n"
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


def _build_phase1_prompt_for_input_group(*, prompt_text: str, group_rows: list[Any]) -> str:
    if not group_rows:
        return ""
    first = _row_to_dict(group_rows[0])
    row_input = first.get("row_input") or {}

    def _ground_truth_output_dict(d: dict[str, Any]) -> dict[str, Any]:
        gto = d.get("ground_truth_output")
        if isinstance(gto, dict):
            return dict(gto)
        return {}

    def _is_model_facing_output_key(key: str) -> bool:
        k = str(key or "").strip()
        if not k or k in ("#", "[#]"):
            return False
        if len(k) >= 2 and k.startswith("[") and k.endswith("]"):
            return False
        return True

    ordered_rows = sorted(group_rows, key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    mo_items: list[tuple[int, dict[str, Any]]] = []
    gt_items: list[tuple[int, dict[str, Any]]] = []
    for i, r in enumerate(ordered_rows, start=1):
        d = _row_to_dict(r)
        if not _phase1_row_has_no_model_output(d):
            run_output = d.get("run_output") or {}
            mo = dict(run_output) if isinstance(run_output, dict) else {}
            mo_items.append((i, mo))
        if not _phase1_row_has_no_ground_truth(d):
            gt_obj = {k: v for k, v in _ground_truth_output_dict(d).items() if _is_model_facing_output_key(k)}
            if gt_obj:
                gt_items.append((i, gt_obj))

    model_body = _phase1_format_nonempty_lines_json(
        mo_items,
        empty_note="*None — no model output on any row for this input.*",
    )
    expected_body = _phase1_format_nonempty_lines_json(
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

    return f"""Diagnose scoring failures for **one** dataset input.

**Layout:** Do not treat **Model output** and **Expected output** as left/right columns, matched pairs, or row-aligned tables. Read each section on its own. **`Line n` is only the n-th entry listed in that section**; it does not pair with anything in the other section.

{scope}

## Prompt template (placeholders not yet substituted)

{prompt_text}

## Placeholder substitutions (values inserted into the template for this run)

```json
{json.dumps(row_input, ensure_ascii=False, indent=2)}
```

## Model output

What the task model returned. **Only rows with non-empty model output appear**; rows with nothing to show are omitted.

{model_body}

## Expected output

Ground truth used for scoring. **Only rows with expected fields appear**; rows with nothing to show are omitted.

{expected_body}

## Output (JSON only)

- **card_title**: Short plain-English headline; not snake_case or code-like.
- **issue_summary**: Describe the failure; reference the expected output when relevant; note missing or extra extractive items when relevant.
- **rough_modification_opinion**: Concrete prompt-level changes only; do not paste a full rewritten prompt.
- **problem_category_hint**: Short grouping tag in English snake_case or hyphen form.

Return only those four fields.
"""


def _sections_block_for_phase2(sections: list[Any]) -> str:
    parts: list[str] = []
    for i, sec in enumerate(sections or []):
        name, content = _sec_name_content(sec)
        parts.append(f"--- Section index {i}: {name} ---\n{content}")
    return "\n\n".join(parts) if parts else "(no sections)"


def _phase2_single_issue_block(*, op: PerRowOpinion) -> str:
    rough = op.rough_modification_opinion.strip()
    if len(rough) > 1200:
        rough = rough[:1197] + "..."
    head = (op.card_title or "").strip() or op.issue_summary
    return (
        f"#### Finding\n"
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
    sections: list[Any],
    cluster_context: str = "",
) -> str:
    """One Phase 2 LLM call for one **cluster** of Phase 1 issues (single input group or merged related findings)."""
    sections_block = _sections_block_for_phase2(sections)
    scope_line = (
        f"**Cluster:** {cluster_context.strip()}\n\n" if (cluster_context or "").strip() else ""
    )
    coverage_rule = (
        "- Each edit addresses PART C via `phase1_addresses` and `reason`; no generic polish.\n"
        "- One edit per distinct fix unless one sentence fixes several PART C items.\n"
        "- Cover every distinct PART C failure; if one is unfixable by substring edit, state that in `reason` on the closest edit."
    )
    return f"""Produce minimal **localized** edits to the stored prompt so behavior matches **PART C**. Output only `prompt_edits`.

PART A, B, and C are **sequential sections** for reading only—never treat them as columns or side-by-side panels to reconcile visually.

{scope_line}Rules:
- `old_sentence` must be copied verbatim from **PART A** only; patches apply to stored section bodies.
- `section_index` is the integer **N** in `--- Section index N: ---` inside **PART A** below. Headings in *this* message are not section indices.
- If PART C has any finding, return **at least one** edit. Empty `prompt_edits` only when PART A has no bodies.
- Do not paste diagnosis text from PART C into `old_sentence`.

{coverage_rule}

---

### PART A — Section bodies (only source for `old_sentence`)

{sections_block}

---

### PART B — Full template (context; **PART A** wins if wording differs)

{prompt_text}

---

### PART C — Cluster diagnosis (never use as `old_sentence`)

{opinions_text}

---

### Each `prompt_edits` item

- **name**: Short UI label.
- **phase1_addresses**: 1–3 strings; prefer PART C **label** values.
- **section_index**: **N** from PART A header line.
- **old_sentence**: Contiguous substring of that section body in PART A.
- **new_sentence**: Replacement, or `""` to delete.
- **reason**: How this fixes the cited PART C items.

Invalid spans are dropped server-side.

Return **`prompt_edits`** only.
"""


def _phase2_old_sentence_smells_diagnosis_leak(raw: str) -> bool:
    """True if the model pasted PART C / diagnosis markdown into old_sentence (never valid)."""
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


def _dedupe_prompt_edit_objects(edits: list[PromptEditSuggestion]) -> list[PromptEditSuggestion]:
    """Drop duplicate (section_index, old_sentence, new_sentence) after Phase 2 merges."""
    seen: set[tuple[int, str, str]] = set()
    out: list[PromptEditSuggestion] = []
    for e in edits:
        old = (e.old_sentence or "").strip()
        new = e.new_sentence if e.new_sentence is not None else ""
        if not isinstance(new, str):
            new = str(new)
        key = (int(e.section_index), old, new)
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out


def _sanitize_prompt_edits(
    sections: list[Any],
    edits: list[PromptEditSuggestion],
    comparison_rows: list[Any] | None = None,
) -> list[dict[str, Any]]:
    """Drop edits whose old_sentence is not an exact substring of the section (UI needs a real span)."""
    out: list[dict[str, Any]] = []
    n = len(sections or [])
    if n == 0:
        return out
    cr = list(comparison_rows or [])
    for e in edits:
        idx = int(e.section_index)
        idx = max(0, min(idx, n - 1))
        _, content = _sec_name_content(sections[idx])
        raw_old = e.old_sentence or ""
        if not raw_old.strip():
            continue
        if _phase2_old_sentence_smells_diagnosis_leak(raw_old):
            safe_print(
                f"[Review] Phase 2 edit skipped (old_sentence is diagnosis text, not PART A): {raw_old[:120]!r}",
                flush=True,
            )
            continue
        old = resolve_old_sentence_span(content, raw_old)
        if old is None and n > 0:
            hits: list[tuple[int, str]] = []
            for si in range(n):
                _, cbody = _sec_name_content(sections[si])
                sp = resolve_old_sentence_span(cbody, raw_old)
                if sp is not None:
                    hits.append((si, sp))
            if len(hits) == 1:
                idx, old = hits[0]
                _, content = _sec_name_content(sections[idx])
        if old is None:
            continue
        new = e.new_sentence if e.new_sentence is not None else ""
        if not isinstance(new, str):
            new = str(new)
        raw_targets = getattr(e, "target_input_row_indices", None)
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
                "section_index": idx,
                "old_sentence": old,
                "new_sentence": new,
                "reason": (e.reason or "").strip(),
                "target_input_row_indices": ri,
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

    sec_idx: int | None = None
    old_span: str | None = None
    for i, sec in enumerate(sections or []):
        _, body = _sec_name_content(sec)
        for cand in _PHASE2_FALLBACK_ANCHOR_CANDIDATES:
            resolved = resolve_old_sentence_span(body, cand)
            if resolved:
                sec_idx, old_span = i, resolved
                break
        if old_span:
            break
    if sec_idx is None or not old_span:
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
            section_index=int(sec_idx),
            old_sentence=old_span,
            new_sentence=new_sent,
            reason=(
                "Phase 2 returned no edits; this server fallback extends the Normalize Names line in PART A so the run "
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
    anchor = _phase1_anchor_comparison_index(group_rows)
    op = PerRowOpinion(row_index=int(anchor), **diag.model_dump())
    _print_review_result_banner("PHASE 1", _review_json_for_print(op))
    return op, idxs_all


def run_review_pipeline(
    *,
    provider: str,
    model: str,
    api_key: str,
    body: Any,
    max_tokens: int,
    max_failed_rows: int,
    is_cancelled: Callable[[], bool],
    append_event: Callable[[dict], None],
) -> None:
    """
    Drive review. Emits: plan, diagnosis_row, suggestions, done.
    Caller handles credential errors and job status.
    """
    sections = list(getattr(body, "prompt_sections", None) or [])
    prompt_text = format_prompt_for_review(sections)
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

    to_analyze = unmatched[: max(1, min(200, int(max_failed_rows)))]
    failed_input_keys = {_input_identity_key(_row_to_dict(r)) for r in to_analyze}
    all_groups = _group_comparison_rows_by_input(comparison_rows)
    groups = [g for g in all_groups if _input_identity_key(_row_to_dict(g[0])) in failed_input_keys]
    n = len(groups)
    row_count = len(to_analyze)
    append_event(
        {
            "type": "plan",
            "summary": (
                f"Phase 1: analyzing {n} input group(s) with failures ({row_count} failed comparison row(s)); "
                "each prompt includes every comparison row for that input (matched + unmatched). "
                "Phase 1.5: cluster related issues (one LLM call; fallback: group by category hint). "
                "Phase 2: one prompt-edit pass per cluster (sequential); "
                "duplicate spans are deduped once."
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
                "row_index": op.row_index,
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

    opinions.sort(key=lambda t: t[0].row_index)

    if is_cancelled():
        return

    cluster_members = _cluster_opinions_for_phase2(
        opinions=opinions,
        comparison_rows=comparison_rows,
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
        blocks = [_phase2_single_issue_block(op=op) for op, _ in cluster_pairs]
        opinions_text = "\n\n".join(blocks)
        label = cluster_labels[cluster_idx]
        mod_prompt = _build_phase2_modifications_prompt(
            prompt_text=prompt_text,
            opinions_text=opinions_text,
            sections=sections,
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
        for el in raw_llm_edits:
            full_edits.append(
                PromptEditSuggestion(
                    name=el.name,
                    phase1_addresses=list(el.phase1_addresses),
                    section_index=int(el.section_index),
                    old_sentence=el.old_sentence,
                    new_sentence=el.new_sentence,
                    reason=el.reason,
                    target_input_row_indices=list(target_labels),
                )
            )
        _print_review_result_banner(
            f"PHASE 2 (cluster {cluster_idx + 1}/{n_clusters})",
            _review_json_for_print(
                {
                    "llm_output": mod_raw.model_dump() if hasattr(mod_raw, "model_dump") else mod_raw.dict(),
                    "target_input_row_indices_filled_server_side": target_labels,
                    "prompt_edits": [e.model_dump() if hasattr(e, "model_dump") else e.dict() for e in full_edits],
                }
            ),
        )
        return cluster_idx, label, full_edits

    indexed_pairs = list(enumerate(cluster_members))
    collected: list[tuple[int, str, PromptEditSuggestion]] = []
    for pair in indexed_pairs:
        if is_cancelled():
            return
        cidx, label, edits = run_one_phase2(pair)
        for e in edits:
            collected.append((cidx, label, e))

    if is_cancelled():
        return

    seen_edit: set[tuple[int, str, str]] = set()
    deduped_triples: list[tuple[int, str, PromptEditSuggestion]] = []
    for cidx, label, e in collected:
        old = (e.old_sentence or "").strip()
        new = e.new_sentence if e.new_sentence is not None else ""
        if not isinstance(new, str):
            new = str(new)
        key = (int(e.section_index), old, new)
        if key in seen_edit:
            continue
        seen_edit.add(key)
        deduped_triples.append((cidx, label, e))

    edit_dicts: list[dict[str, Any]] = []
    for cidx, label, e in deduped_triples:
        if len(edit_dicts) >= _MAX_VALIDATED_PROMPT_EDITS:
            break
        batch = _sanitize_prompt_edits(sections, [e], comparison_rows)
        for d in batch:
            d["issue_cluster_index"] = cidx
            d["issue_cluster_label"] = label
            edit_dicts.append(d)
            if len(edit_dicts) >= _MAX_VALIDATED_PROMPT_EDITS:
                break

    if not edit_dicts and deduped_triples:
        nsec = len(sections or [])
        cr = list(comparison_rows or [])
        for i, (cidx, label, e) in enumerate(deduped_triples[:5]):
            sidx = max(0, min(int(e.section_index), nsec - 1)) if nsec else 0
            _, cbody = _sec_name_content(sections[sidx]) if nsec else ("", "")
            raw_old = e.old_sentence or ""
            resolved = resolve_old_sentence_span(cbody, raw_old) if cbody else None
            raw_t = getattr(e, "target_input_row_indices", None)
            mapped = _targets_zero_based_from_llm(raw_t if isinstance(raw_t, list) else [], cr)
            safe_print(
                f"[Review] Phase 2 suggestion dropped (sanitize): cluster={cidx} label={label!r} "
                f"section_index={sidx} old_resolved={resolved is not None} "
                f"targets_raw={raw_t!r} targets_mapped={mapped!r} old_preview={raw_old[:120]!r}",
                flush=True,
            )

    if edit_dicts:
        append_event({"type": "suggestions", "suggestions": edit_dicts})

    append_event({"type": "done"})
