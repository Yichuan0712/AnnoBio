"""
Review analyze pipeline, separate from FastAPI main module.

Phase 1 — per **failed input**: same dataset input, **all** unmatched model outputs vs their paired expected/scoring context in one LLM call; then rough opinion.

Phase 1.5 — **cluster** Phase‑1 issues that share the same root cause / fix strategy (one LLM call). Fallback: group by `problem_category_hint`.

Phase 2 — **one LLM call per issue cluster** (parallel up to `concurrency`), each prompt’s section 3 lists every finding in that cluster; localized `prompt_edits` must cover them. Identical spans are still **deduped** once before emit.

Extraction-style tasks: **under-coverage** (required items missing) and **over-coverage** (extra items not in ground truth) are both failures—the prompts below tell the model to diagnose and fix with that rubric.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from pydantic import BaseModel, Field

from llm import run_structured as llm_run_structured
from safe_stdio import safe_print

logger = logging.getLogger(__name__)

# Server-side cap on validated edits (response size / UI); not stated in LLM prompts.
_MAX_VALIDATED_PROMPT_EDITS = 64


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


class PerRowOpinion(BaseModel):
    """Structured output for phase 1 (one failed input group; row_index = min comparison row_index in that group)."""

    row_index: int = Field(
        ...,
        description=(
            "**1-based** row number for this group’s anchor failure — same labels as in the prompt "
            "(Score # when `score_table_row` exists, else comparison row_index + 1). "
            "Use the **smallest failed** row number listed there."
        ),
    )
    card_title: str = Field(
        default="",
        description=(
            "Very short UI headline (about 4–12 words): a plain-English summary of the failure for a list card. "
            "Like a concise news headline—not snake_case, not a variable name, not the same long text as issue_summary."
        ),
    )
    issue_summary: str = Field(..., description="One or two sentences: what went wrong vs expected")
    rough_modification_opinion: str = Field(
        ...,
        description="Rough, prompt-level advice (criteria, wording, format)—not a full rewritten prompt",
    )
    problem_category_hint: str = Field(
        default="",
        description=(
            "Short tag for grouping, e.g. format_mismatch, missing_field, omission, over_extraction, ambiguity, threshold"
        ),
    )


class PromptEditSuggestion(BaseModel):
    """One localized prompt change; old_sentence must exist verbatim in the section (UI highlights red/green)."""

    name: str = Field(..., description="Short title for this edit")
    phase1_addresses: list[str] = Field(
        ...,
        min_length=1,
        max_length=3,
        description=(
            "1–3 strings naming Phase 1 findings this edit fixes; if many bullets are the same failure class, merge into fewer strings"
        ),
    )
    section_index: int = Field(0, ge=0, description="0-based index of the section to edit")
    old_sentence: str = Field(
        ...,
        description="Exact contiguous substring copied character-for-character from that section's body",
    )
    new_sentence: str = Field(
        default="",
        description="Replacement; empty string for pure deletion",
    )
    reason: str = Field(
        ...,
        description="How this old→new change implements the fix for the phase1_addresses items (1–2 sentences)",
    )
    target_input_row_indices: list[int] = Field(
        ...,
        min_length=1,
        description=(
            "Required. **1-based** row numbers exactly as in Phase 2 section 3 "
            "(e.g. `#3` → include integer `3`). Same convention as Issue / Score #. "
            "Not worksheet input_row_index."
        ),
    )


class Phase2Modifications(BaseModel):
    """Structured output for the modifications-only LLM call (localized prompt_edits)."""

    prompt_edits: list[PromptEditSuggestion] = Field(
        default_factory=list,
        description=(
            "Every edit MUST resolve at least one issue named in Phase 1 (section 3); together they MUST cover "
            "those failures—no unrelated or generic-only improvements; each old_sentence verbatim in section body"
        ),
    )


class Phase15IssueCluster(BaseModel):
    """One cluster of Phase‑1 issue indices before Phase 2."""

    member_indices: list[int] = Field(
        ...,
        description="0-based indices into the numbered issue list; every index in exactly one cluster across all clusters",
    )
    group_label: str = Field(
        default="",
        description="Very short English label (e.g. missing required field, format mismatch)",
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


def _build_phase15_clustering_prompt(*, opinions: list[tuple[PerRowOpinion, list[int]]], comparison_rows: list[Any]) -> str:
    lines: list[str] = []
    for i, (op, ridxs) in enumerate(opinions):
        head = (op.card_title or "").strip() or op.issue_summary
        summ = (op.issue_summary or "").strip().replace("\n", " ")
        if len(summ) > 220:
            summ = summ[:217] + "..."
        cat = (op.problem_category_hint or "uncategorized").strip()
        if len(ridxs) > 1:
            rows_lbl = ", ".join(
                f"#{_label_one_based_from_comparison_rows(comparison_rows, j)}" for j in sorted(ridxs)
            )
        else:
            rows_lbl = f"#{_label_one_based_from_comparison_rows(comparison_rows, op.row_index)}"
        lines.append(
            f"- **Index {i}** | Score row(s) {rows_lbl} | [{cat}] **{head}**\n"
            f"  Summary: {summ}"
        )
    issues_block = "\n".join(lines) if lines else "(no issues)"
    return f"""## Task: group Phase‑1 review issues before prompt-edit generation

Each **index** below is one completed Phase‑1 diagnosis (different failed dataset input or failure context). Soon we will run **one** prompt-edit pass **per cluster** of issues.

### Rules

1. Put two indices in the **same cluster** only if **one coherent change to the instruction prompt** (same root cause / same fix strategy) would reasonably address **both** findings together.
2. **Do not** merge unrelated failures (e.g. missing field vs format mismatch vs threshold), even if they share a category tag.
3. **Every** index from **0** to **{len(opinions) - 1}** must appear in **exactly one** cluster.
4. Prefer **fewer, meaningful** clusters when justified; use **singleton** clusters when in doubt.

### Phase‑1 issues (numbered)

{issues_block}

Respond with JSON: **`clusters`** only — each cluster has `member_indices` (list of ints) and optional `group_label`.
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
    n = len(opinions)
    if n <= 1:
        return [[0]] if n == 1 else []
    if is_cancelled():
        return [[i] for i in range(n)]
    prompt = _build_phase15_clustering_prompt(opinions=opinions, comparison_rows=comparison_rows)
    safe_print(
        "\n"
        + "=" * 80
        + "\nREVIEW PHASE 1.5 (issue clustering)"
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
        normalized = _normalize_cluster_member_indices(n, list(parsed.clusters or []))
        if len(normalized) == 0:
            return _heuristic_issue_cluster_indices(opinions)
        covered = sum(len(c) for c in normalized)
        if covered != n:
            logger.warning("Phase 1.5 clustering covered %s/%s indices; using heuristic", covered, n)
            return _heuristic_issue_cluster_indices(opinions)
        return normalized
    except Exception as e:
        logger.warning("Phase 1.5 clustering failed (%s); using heuristic buckets", e)
        return _heuristic_issue_cluster_indices(opinions)


def _build_phase1_prompt_for_input_group(*, prompt_text: str, group_rows: list[Any]) -> str:
    if not group_rows:
        return ""
    first = _row_to_dict(group_rows[0])
    row_input = first.get("row_input") or {}
    idxs = sorted({int(_row_to_dict(r).get("row_index", -1)) for r in group_rows})
    failed_idxs = sorted(
        {
            int(_row_to_dict(r).get("row_index", -1))
            for r in group_rows
            if not _row_to_dict(r).get("matched", False)
        }
    )
    by_idx = _rows_by_comparison_index(group_rows)
    fail_list_1 = (
        ", ".join(str(_score_row_one_based(by_idx[i])) for i in sorted(failed_idxs) if i in by_idx)
        if failed_idxs
        else "(none)"
    )
    all_list_1 = ", ".join(str(_score_row_one_based(by_idx[i])) for i in sorted(idxs) if i in by_idx)
    min_fail_1 = (
        _score_row_one_based(by_idx[min(failed_idxs)])
        if failed_idxs and min(failed_idxs) in by_idx
        else (_score_row_one_based(by_idx[min(idxs)]) if idxs and min(idxs) in by_idx else 1)
    )

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

    def _field_scoring_parts_for_row(d: dict[str, Any]) -> list[str]:
        comparison_types = d.get("comparison_types")
        parts = [str(x) for x in (comparison_types or []) if isinstance(x, str)]
        return [x for x in parts if _is_model_facing_output_key(x.split(":", 1)[0].strip())]

    ordered_rows = sorted(group_rows, key=lambda x: int(_row_to_dict(x).get("row_index", 0)))
    gt_entries: list[dict[str, Any]] = []
    scoring_ordered: list[str] = []
    scoring_seen: set[str] = set()
    outputs_in_order: list[dict[str, Any] | None] = []
    for r in ordered_rows:
        d = _row_to_dict(r)
        gt_only = bool(d.get("gt_only"))
        run_output = d.get("run_output") or {}
        for part in _field_scoring_parts_for_row(d):
            key = part.split(":", 1)[0].strip()
            if key in scoring_seen:
                continue
            scoring_seen.add(key)
            scoring_ordered.append(part)
        if gt_only:
            outputs_in_order.append(None)
        else:
            outputs_in_order.append(dict(run_output) if isinstance(run_output, dict) else {})
        gt_obj = {k: v for k, v in _ground_truth_output_dict(d).items() if _is_model_facing_output_key(k)}
        gt_entries.append(gt_obj)

    rules_body = "\n".join(f"- {p}" for p in scoring_ordered) if scoring_ordered else "(not specified)"
    outputs_json = json.dumps(outputs_in_order, ensure_ascii=False, indent=2)
    multi = len(group_rows) > 1
    mixed = len(failed_idxs) > 0 and len(failed_idxs) < len(group_rows)
    if multi:
        if mixed:
            scope = (
                "This is **one dataset input** with **multiple** expectations below. **Some PASSED and some FAILED** scoring. "
                "Use passing entries as context (what the model got right); focus the diagnosis on failures "
                "and prompt changes that preserve correct behavior while fixing them."
            )
        else:
            scope = (
                "This is **one dataset input** with **multiple** expectations (see **sections 3 and 4**). "
                "Diagnose **holistically** across indices (same array order)."
            )
    else:
        scope = "This is **one** model output for this input that failed scoring."
    gt_json = json.dumps(gt_entries, ensure_ascii=False, indent=2)

    return f"""You review model output(s) for **one** dataset input (same placeholders / message as below). Possibly multiple expectations were scored; some may have **passed** and some **failed**.

{scope}

## 1. Prompt template

Full instruction text the model was given (all sections, as in the app):

{prompt_text}

## 2. Input (substituted placeholders)

Keys are `{{placeholder}}` names from the template above; values are the strings substituted into the prompt for this run.

```json
{json.dumps(row_input, ensure_ascii=False, indent=2)}
```

## 3. Model output

JSON **array**: one element per expectation, **same length and index order** as **section 4 (Ground truth)**. Each element is the model `output` object for that expectation, or `null` if no run result was paired (missing extraction).

```json
{outputs_json}
```

## 4. Ground truth

JSON **array**: one object per expectation. Index `i` matches index `i` in **section 3 (Model output)**. **Keys** are the score-rule **output keys** — the same property names used when comparing model JSON to the GT sheet. Omitted here: row-index rules (`#`, `[#]`) and bracket worksheet selectors (`[…]`) that are not model-output fields.

```json
{gt_json}
```

## 5. Comparison rules (how each output key is scored against ground truth)

For each listed output field, the line describes the match type / options used when comparing **section 3** values to **section 4**.

{rules_body}

Note: Sections **3** and **4** use **0-based** array indices `i` only for JSON element order. The response field **row_index** (below) uses **1-based** row numbers like the app.

## Your task

0. **card_title**: A **short headline** (about 4–12 words) for a UI list card—plain English, summary-style, readable at a glance. It must **not** be snake_case or look like a code identifier. It is **not** a substitute for the full explanation below.
1. **issue_summary**: Briefly explain the mismatch(es) (one or two sentences, or a bit more if multiple outputs need tying together). If the failure is extractive, mention **missing** and/or **extra** relative to expected when relevant.
2. **rough_modification_opinion**: Rough modification advice for the **prompt** only—what to clarify, add, or constrain so coverage is exact (no missing required items, no spurious extras); do NOT paste a full new prompt.
3. **problem_category_hint**: a very short English snake_case or hyphen tag for grouping similar failures (internal use).

Row numbers in this task are **1-based** (same as the app’s Issue / Score **#** column when `score_table_row` is set; otherwise comparison row_index + 1).

Respond with JSON matching the schema (**row_index** must be **{min_fail_1}** — smallest **failed** row number below; failed row number(s): {fail_list_1}; all rows in this group: {all_list_1}).
"""


def _sections_block_for_phase2(sections: list[Any]) -> str:
    parts: list[str] = []
    for i, sec in enumerate(sections or []):
        name, content = _sec_name_content(sec)
        parts.append(f"--- Section index {i}: {name} ---\n{content}")
    return "\n\n".join(parts) if parts else "(no sections)"


def _phase2_single_issue_block(*, comparison_rows: list[Any], op: PerRowOpinion, ridxs: list[int]) -> str:
    rough = op.rough_modification_opinion.strip()
    if len(rough) > 1200:
        rough = rough[:1197] + "..."
    head = (op.card_title or "").strip() or op.issue_summary
    if len(ridxs) > 1:
        rows_lbl = ", ".join(
            f"#{_label_one_based_from_comparison_rows(comparison_rows, i)}" for i in sorted(ridxs)
        )
    else:
        rows_lbl = f"#{_label_one_based_from_comparison_rows(comparison_rows, op.row_index)}"
    return (
        f"- Score row(s) {rows_lbl} (1-based, same as Issue / Score #): [{op.problem_category_hint or 'uncategorized'}] {head}\n"
        f"  Detail: {op.issue_summary}\n  Rough fix: {rough}"
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
    section3_rule = (
        "- **Section 3** lists **every** Phase‑1 finding in **this cluster** (already grouped as sharing the same fix strategy). "
        "Do **not** redesign the prompt, add unrelated polish, or address failures not listed there.\n"
        "- **One problem → one edit (default):** Usually **one** `prompt_edit` per **distinct** failure or fix strategy **in section 3**. "
        "When **one** localized change fixes **several** bullets in section 3, you may use **one** edit and name all of them in `phase1_addresses` / `target_input_row_indices`.\n"
        "- **Coverage:** Your edits **must** address **all** distinct failures in **section 3**, unless the prompt has no place to apply a fix (then fewer edits and state the gap in `reason`—still no generic-only edits)."
    )
    return f"""## Phase 2 goal (read first)

**Fix what Phase 1 found for this cluster, with as little change to the prompt as possible.**

{scope_line}**Hard rule:** Every `prompt_edit` you output **must** directly fix something **Phase 1 already identified** in **section 3** (issue_summary, rough_modification_opinion, category hint, or the row lines). **Do not** output an edit whose only justification is generic “better prompt” or “clarity”—if you cannot point to **which part of section 3** it answers, **omit** that edit.

{section3_rule}
- Each `prompt_edit` is a **minimal** change: prefer one sentence / bullet / clause.
- **Smallest effective diff wins**; do **not** split one fix into many micro-edits.
- **Extraction / coverage:** tighten only as much as Phase 1 implies.

Output format: **only** `prompt_edits`. No clusters, no meta summaries, no full rewritten prompt.

## 1. Prompt template

Full instruction text the model was given (same as Phase 1; use together with **section 2** for locating spans to edit):

{prompt_text}

## 2. Prompt sections (by index)

Verbatim section bodies only. **`old_sentence` must be copied from here** — not from headers like `--- Section index 0: … ---`, and not from **section 1** if the wording differs.

{sections_block}

## 3. Phase 1 findings (**this cluster** — every bullet must be addressed by your edits)

{opinions_text}

## Your task — **prompt_edits** (in-app diff + Accept/Revert)

Each edit in `prompt_edits` **must** include:

- **`phase1_addresses`**: **1 to 3 strings** (hard cap **3**). Each string should name a **Phase 1 finding** from **section 3** (short phrase or quote). **Do not** use vague entries like “improve clarity” unless Phase 1 said so.
- **`target_input_row_indices`**: **Non-empty** list of **1-based integers** — copy the **exact numbers** from section 3 after **“Score row(s)”** (e.g. `#4, #5` → `[4, 5]`). Same numbering as Issue / Score **#**. Not worksheet `input_row_index`.
- **`reason`**: 1–2 sentences on **how** the `old_sentence`→`new_sentence` change implements those fixes (implementation detail, not a repeat of the whole section 3).

Other rules:

1. **Count:** **Minimum** edits that still **fully** cover Phase 1’s problems in section 3 for this cluster. No padding.
2. **old_sentence:** **Character-for-character** from **section 2** (one contiguous substring).
3. **new_sentence:** Replaces `old_sentence`; **""** = deletion.
4. **section_index:** Section in **section 2** where `old_sentence` appears.
5. If `old_sentence` is **not** an exact substring of that body, **omit** that edit.

Respond with JSON: **`prompt_edits` only** (no other keys).
"""


def _dedupe_prompt_edit_objects(edits: list[PromptEditSuggestion]) -> list[PromptEditSuggestion]:
    """Drop duplicate (section_index, old_sentence, new_sentence) after parallel Phase 2 merges."""
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
        old = e.old_sentence or ""
        if not old.strip():
            continue
        if old not in content:
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
        + "\nREVIEW PHASE 1 PROMPT"
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
        response_model=PerRowOpinion,
        max_tokens=max_tokens,
    )
    if isinstance(out, dict):
        op = PerRowOpinion(**out)
    elif isinstance(out, PerRowOpinion):
        op = out
    else:
        op = PerRowOpinion(**(out.model_dump() if hasattr(out, "model_dump") else out.dict()))
    raw_ri = int(op.row_index)
    by_idx = _rows_by_comparison_index(group_rows)
    failed_set = set(failed_idxs)
    if raw_ri in failed_set:
        norm = raw_ri
    elif raw_ri >= 1 and (raw_ri - 1) in failed_set:
        norm = raw_ri - 1
    else:
        label_to_idx = {_score_row_one_based(by_idx[i]): i for i in failed_set if i in by_idx}
        fallback = int(min(failed_idxs)) if failed_idxs else int(min(idxs_all))
        norm = label_to_idx.get(raw_ri, fallback)
    op.row_index = int(norm)
    return op, idxs_all


def run_review_pipeline(
    *,
    provider: str,
    model: str,
    api_key: str,
    body: Any,
    max_tokens: int,
    max_failed_rows: int,
    concurrency: int,
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
                f"Phase 2: one prompt-edit pass per cluster in parallel (up to {max(1, min(4, int(concurrency)))} at once); "
                "duplicate spans are deduped once."
            ),
            "diagnosis_total": n,
        }
    )

    if is_cancelled():
        return

    opinions: list[tuple[PerRowOpinion, list[int]]] = []
    conc = max(1, min(4, int(concurrency)))

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
    if conc <= 1:
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
    else:
        with ThreadPoolExecutor(max_workers=conc) as ex:
            futures = {ex.submit(one_group, g): g for g in groups}
            for fut in as_completed(futures):
                if is_cancelled():
                    try:
                        ex.shutdown(wait=False, cancel_futures=True)
                    except TypeError:
                        ex.shutdown(wait=False)
                    return
                op, ridxs = fut.result()
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
            return cluster_idx, cluster_labels[cluster_idx], []
        cluster_pairs = [opinions[i] for i in member_indices]
        blocks = [
            _phase2_single_issue_block(comparison_rows=comparison_rows, op=op, ridxs=ridxs)
            for op, ridxs in cluster_pairs
        ]
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
            response_model=Phase2Modifications,
            max_tokens=max_tokens,
        )
        if isinstance(out_mod, dict):
            mod = Phase2Modifications(**out_mod)
        elif isinstance(out_mod, Phase2Modifications):
            mod = out_mod
        else:
            mod = Phase2Modifications(**(out_mod.model_dump() if hasattr(out_mod, "model_dump") else out_mod.dict()))
        return cluster_idx, label, list(mod.prompt_edits or [])

    indexed_pairs = list(enumerate(cluster_members))
    collected: list[tuple[int, str, PromptEditSuggestion]] = []
    if conc <= 1:
        for pair in indexed_pairs:
            if is_cancelled():
                return
            cidx, label, edits = run_one_phase2(pair)
            for e in edits:
                collected.append((cidx, label, e))
    else:
        with ThreadPoolExecutor(max_workers=conc) as ex:
            futs = {ex.submit(run_one_phase2, pair): pair for pair in indexed_pairs}
            results: list[tuple[int, str, list[PromptEditSuggestion]]] = []
            for fut in as_completed(futs):
                if is_cancelled():
                    try:
                        ex.shutdown(wait=False, cancel_futures=True)
                    except TypeError:
                        ex.shutdown(wait=False)
                    return
                results.append(fut.result())
            results.sort(key=lambda t: t[0])
            for cidx, label, edits in results:
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

    if edit_dicts:
        append_event({"type": "suggestions", "suggestions": edit_dicts})

    append_event({"type": "done"})
