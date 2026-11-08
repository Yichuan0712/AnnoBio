"""APE and EvoPrompt (differential evolution) as Optimize methods — the experiments' adapters, run in the app.

The search is the experiments' (AnnoBio-Experiments experiments/prompt_bench/runner/methods.py `ape`, `evoprompt_de`,
PAPER_PLAN 10.45) with the official templates copied verbatim (prompt_search_templates.py):
  APE (Zhou et al., ICLR 2023), iterative Monte Carlo search (sec. 3.3): 50 proposals from 5 demo sets x 10 samples
    (the forward template, demos "Input: ... Output: ..."), the prompt itself among them; every round each live
    candidate is scored on the round's batch of 16 inputs, the running mean over rounds ranks them, the best 10
    survive and each is resampled once with the paper's resampling prompt.
  EvoPrompt-DE (Guo et al., ICLR 2024, Algorithm 3): a population of 10 (the prompt and 9 paraphrases of it), every
    member scored on one fixed dev set (up to 100 inputs); each generation every member j gets a child from the DE
    template (donors a, b from the others, c = the best so far), which replaces it only when it scores higher.

What differs in the app, each forced by the app rather than chosen for a score:
  1. Data: the inputs this Optimize evaluated that Verify can score (one example per input), not an optimization
     partition; there is no separate validation, the method's own pick is the card.
  2. Stop: a round / generation count (Settings) instead of a dollar cap. Defaults are the papers' own: APE 1
     round (the paper's default APE, without iteration), EvoPrompt 10 generations (App. B.3, Table 11).
  3. Placeholders: a candidate that drops one of the prompt's {placeholders} gets it back at its end
     ("name: {name}"), so the input still reaches the model; the experiments send the input apart from the prompt.
  4. Scoring: the user's Generate model with its run settings (task_row_runner) and Verify's verdict for each
     input (score_engine, review_engine_hooks); a set's score is matched rows / rows, as the Evaluate counts.
     The prompt's own score per input is the user's existing run, not run again.
  5. Long inputs (median over 10,000 characters, e.g. full papers) get the experiments' RoBBR values: APE 1 demo
     per proposal call, EvoPrompt a dev set of 50.
  6. APE does not resample after its last round (those variations would never be scored).

Each method returns at most one card, a whole-prompt rewrite, like GEPA; the user verifies and applies it as usual.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from llm import chat as llm_chat
from prompt_search_templates import (APE_DEMOS_DELIMITER, APE_DEMOS_TEMPLATE, APE_GENERATION_TEMPLATE, APE_RESAMPLE,
                                     EVOPROMPT_DE_TEMPLATE, EVOPROMPT_PARAPHRASE)
from review_engine_v2 import LONG_INPUT_CHARS, build_inputs
from review_pipeline import PromptEditSuggestion, _row_to_dict, _sanitize_prompt_edits, _score_row_one_based
from safe_stdio import safe_print as _print

BATCH_SIZE = 16                    # the experiments' batch size
APE_NUM_PROMPTS = 50               # simple_ape: 50 // 10 demo sets x 10 samples
APE_KEEP_TOP = 10
APE_DEMOS, APE_DEMOS_LONG = 5, 1
EVO_POPSIZE = 10
EVO_DEV, EVO_DEV_LONG = 100, 50
DEFAULT_APE_ROUNDS = 1             # the paper's default APE (no iterative search)
DEFAULT_EVO_GENERATIONS = 10       # EvoPrompt App. B.3, Table 11
MAX_ROUNDS = 50
META_CONCURRENCY = 8
SEED = 0

_PLACEHOLDER_RE = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")


class _Cancelled(Exception):
    pass


def keep_placeholders(candidate: str, prompt: str) -> str:
    """The candidate, with any of the prompt's {placeholders} it dropped appended (difference 3)."""
    have = set(_PLACEHOLDER_RE.findall(candidate))
    missing = [name for name in dict.fromkeys(_PLACEHOLDER_RE.findall(prompt)) if name not in have]
    if not missing:
        return candidate
    return candidate.rstrip() + "\n\n" + "\n".join(f"{name}: {{{name}}}" for name in missing)


def get_final_prompt(text: str) -> str:
    """EvoPrompt utils.get_final_prompt (MIT, Microsoft), unchanged."""
    parts = text.split("<prompt>")
    if len(parts) > 1:
        return parts[-1].split("</prompt>")[0].strip()
    if text.startswith("\"") and text.endswith("\""):
        text = text[1:-1]
    return text


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _setting(settings: dict, key: str, default: int) -> int:
    try:
        value = int(settings.get(key) or default)
    except (TypeError, ValueError):
        value = default
    return max(1, min(MAX_ROUNDS, value))


class _Search:
    """Scores prompts on inputs with the Generate model and Verify's verdict; caches (prompt, input) results."""

    def __init__(self, *, prompt: str, examples: list, observations: list, run_row: Callable, score_input: Callable,
                 meta: Callable[[str], str], is_cancelled: Callable[[], bool], concurrency: int):
        self.prompt = prompt
        self.examples = examples
        self.by_id = {e.id: e for e in examples}
        self.run_row, self.score_input, self.meta_call = run_row, score_input, meta
        self.is_cancelled = is_cancelled
        self.concurrency = max(1, concurrency)
        self.results: dict[tuple[str, str], tuple[int, int]] = {}
        for seen in observations:  # the prompt's own run, as the Evaluate scored it (difference 4)
            if seen.example_id in self.by_id:
                self.results[(prompt, seen.example_id)] = (seen.evaluation.matched_count or 0,
                                                           seen.evaluation.total_count or 0)
        self.task_calls = 0
        self.meta_calls = 0
        self.meta_failures = 0

    def check(self) -> None:
        if self.is_cancelled():
            raise _Cancelled()

    def _run_one(self, text: str, example_id: str) -> tuple[int, int]:
        if self.is_cancelled():
            return (0, 0)
        example = self.by_id[example_id]
        try:
            outputs = self.run_row(text, example.inputs) or []
        except Exception:  # a failed run scores as unmatched, as an error row does in a Run
            outputs = []
        return self.score_input(example_id, outputs)

    def score(self, text: str, ids: list[str]) -> float:
        self.check()
        todo = [k for k in dict.fromkeys(ids) if (text, k) not in self.results]
        if todo:
            with ThreadPoolExecutor(max_workers=min(self.concurrency, len(todo))) as pool:
                verdicts = list(pool.map(lambda k: self._run_one(text, k), todo))
            self.check()
            self.task_calls += len(todo)
            for k, verdict in zip(todo, verdicts):
                self.results[(text, k)] = verdict
        matched = sum(self.results[(text, k)][0] for k in ids)
        total = sum(self.results[(text, k)][1] for k in ids)
        return matched / total if total else 0.0

    def meta(self, texts: list[str]) -> list[str]:
        """One optimization-model call per text, in parallel; a failed call reads as an empty reply."""
        self.check()

        def one(text: str) -> str:
            if self.is_cancelled():
                return ""
            try:
                return str(self.meta_call(text) or "")
            except Exception as e:
                _print(f"[PromptSearch] optimization-model call failed: {e}")
                self.meta_failures += 1
                return ""
        with ThreadPoolExecutor(max_workers=max(1, min(META_CONCURRENCY, len(texts)))) as pool:
            replies = list(pool.map(one, texts))
        self.check()
        self.meta_calls += len(texts)
        return replies


def _long_inputs(examples: list) -> bool:
    lengths = sorted(len(_compact(e.inputs)) for e in examples)
    return bool(lengths) and lengths[len(lengths) // 2] > LONG_INPUT_CHARS


def run_ape_search(search: _Search, rounds: int, emit: Callable[[dict], None], seed: int = SEED) -> tuple[str, dict]:
    prompt = search.prompt
    rng = random.Random(f"{seed}:ape")
    labeled = sorted((e for e in search.examples if e.reference), key=lambda e: e.id)
    shots = APE_DEMOS_LONG if _long_inputs(search.examples) else APE_DEMOS
    data = ([_compact(e.inputs) for e in labeled],
            [_compact(e.reference[0] if len(e.reference) == 1 else e.reference) for e in labeled])
    queries = []
    for _subsample in range(max(1, APE_NUM_PROMPTS // 10)):
        if not labeled:
            break
        picks = rng.sample(range(len(labeled)), min(shots, len(labeled)))  # data.subsample_data
        inputs, outputs = [data[0][i] for i in picks], [data[1][i] for i in picks]
        demos = APE_DEMOS_DELIMITER.join(APE_DEMOS_TEMPLATE.replace("[INPUT]", i).replace("[OUTPUT]", o)
                                         for i, o in zip(inputs, outputs))
        query = (APE_GENERATION_TEMPLATE.replace("[full_DEMO]", demos).replace("[INPUT]", inputs[0])
                 .replace("[OUTPUT]", outputs[0]).replace("[APE]", "").strip())  # generate.get_query; llm.GPT_forward
        queries += [query] * 10
    emit({"type": "stage", "stage_id": "propose", "kind": "start", "payload": {"proposal_calls": len(queries)}})
    proposals = [keep_placeholders(r.strip(), prompt) for r in search.meta(queries) if r.strip()]
    live = list(dict.fromkeys([prompt, *proposals]))
    order = {p: i for i, p in enumerate(live)}
    emit({"type": "stage", "stage_id": "propose", "kind": "done", "payload": {"candidates": len(live)}})
    ids = sorted(search.by_id)
    random.Random(f"{seed}:batches").shuffle(ids)
    stats: dict[str, list[float]] = {}
    emit({"type": "stage", "stage_id": "search", "kind": "start", "payload": {"rounds": rounds}})
    for index in range(rounds):
        batch = [ids[(index * BATCH_SIZE + k) % len(ids)] for k in range(min(BATCH_SIZE, len(ids)))]
        for text in live:
            value = search.score(text, batch)
            total = stats.setdefault(text, [0.0, 0])
            total[0] += value * len(batch)
            total[1] += len(batch)
        ranked = sorted(live, key=lambda p: (-stats[p][0] / stats[p][1], order[p]))
        survivors = ranked[:APE_KEEP_TOP]
        best = ranked[0]
        emit({"type": "stage", "stage_id": "search", "kind": "iteration", "payload": {
            "round": index + 1, "scored": len(live), "best_mean": round(stats[best][0] / stats[best][1], 4)}})
        if index == rounds - 1:
            break  # difference 6
        variations = []
        for raw in search.meta([APE_RESAMPLE.replace("[INSTRUCTION]", p) for p in survivors]):
            text = keep_placeholders(raw.strip(), prompt) if raw.strip() else ""
            if text and text not in stats and text not in variations:
                order.setdefault(text, len(order))
                variations.append(text)
        live = survivors + variations
    best = min(stats, key=lambda p: (-stats[p][0] / stats[p][1], order[p]))
    mean = lambda p: stats[p][0] / stats[p][1]  # noqa: E731
    return best, {"best": mean(best), "base": mean(prompt), "candidates": len(stats),
                  "where": "the batches each was scored on (APE's running mean)"}


def run_evoprompt_search(search: _Search, generations: int, emit: Callable[[dict], None],
                         seed: int = SEED) -> tuple[str, dict]:
    import numpy as np

    prompt = search.prompt
    dev_size = EVO_DEV_LONG if _long_inputs(search.examples) else EVO_DEV
    ids = sorted(search.by_id)
    dev = sorted(random.Random(f"{seed}:evoprompt-dev").sample(ids, min(dev_size, len(ids))))
    emit({"type": "stage", "stage_id": "seed", "kind": "start", "payload": {"population": EVO_POPSIZE, "dev_inputs": len(dev)}})
    population, attempts = [prompt], 0
    while len(population) < EVO_POPSIZE and attempts < 3 * EVO_POPSIZE:
        wanted = EVO_POPSIZE - len(population)
        attempts += wanted
        found = search.meta([EVOPROMPT_PARAPHRASE.format(s=prompt)] * wanted)
        population += [keep_placeholders(p.strip(), prompt) for p in found if p.strip()]
    if len(population) < EVO_POPSIZE:
        raise RuntimeError("EvoPrompt: too few usable paraphrases for the initial population")
    scores: dict[str, float] = {}

    def fitness(text: str) -> float:
        if text not in scores:
            scores[text] = search.score(text, dev)
        return scores[text]

    for text in population:
        fitness(text)
    best = max(population, key=lambda p: scores[p])  # max keeps the first of equals, as in the code
    best_score = scores[best]
    emit({"type": "stage", "stage_id": "seed", "kind": "done", "payload": {"base_score": round(scores[prompt], 4),
                                                                          "best_score": round(best_score, 4)}})
    draws = np.random.RandomState(int(hashlib.sha256(f"{seed}:evoprompt".encode()).hexdigest()[:8], 16))
    emit({"type": "stage", "stage_id": "evolve", "kind": "start", "payload": {"generations": generations}})
    for step in range(generations):
        new_population = []
        for j in range(EVO_POPSIZE):
            old = population[j]
            donors = [population[k] for k in range(EVO_POPSIZE) if k != j]
            a, b, _c = draws.choice(donors, 3, replace=False)
            request = (EVOPROMPT_DE_TEMPLATE.replace("<prompt0>", old).replace("<prompt1>", str(a))
                       .replace("<prompt2>", str(b)).replace("<prompt3>", best))
            raw = search.meta([request])[0]
            child = get_final_prompt(raw) if "<prompt>" in raw else ""
            selected = old
            if child:
                child = keep_placeholders(child, prompt)
                if fitness(child) > scores[old]:
                    selected = child
            if scores[selected] > best_score:
                best, best_score = selected, scores[selected]
            new_population.append(selected)
        population = new_population
        emit({"type": "stage", "stage_id": "evolve", "kind": "iteration", "payload": {
            "generation": step + 1, "best_score": round(best_score, 4),
            "mean_score": round(sum(scores[p] for p in population) / EVO_POPSIZE, 4)}})
    final = max(population, key=lambda p: scores[p])
    return final, {"best": scores[final], "base": scores[prompt], "candidates": len(scores),
                   "where": f"{len(dev)} dev input(s)"}


def _card(*, label: str, prompt: str, best: str, info: dict, comparison_rows: list) -> dict | None:
    rows = [_row_to_dict(r) for r in comparison_rows]
    targets = (sorted({_score_row_one_based(r) for r in rows if not r.get("matched")})
               or sorted({_score_row_one_based(r) for r in rows}) or [1])
    edit = PromptEditSuggestion(
        name=f"{label}: searched prompt",
        phase1_addresses=[f"{label} searched {info['candidates']} candidate prompt(s)"],
        old_sentence=prompt.strip(),
        new_sentence=best,
        reason=f"{info['best']:.0%} vs the original's {info['base']:.0%} on {info['where']}.",
        target_score_row_indices=targets,
    )
    batch = _sanitize_prompt_edits(prompt, [edit], comparison_rows)
    if not batch:
        return None
    card = batch[0]
    card["issue_cluster_index"] = 0
    card["issue_cluster_label"] = label.lower()
    return card


def _run(method: str, *, provider: str, model: str, api_key: str, base_url: str, body: Any, max_tokens: int,
         is_cancelled: Callable[[], bool], append_event: Callable[[dict], None], settings: dict | None) -> None:
    label = "APE" if method == "ape" else "EvoPrompt"
    st = settings or {}
    prompt = str(getattr(body, "prompt", "") or "")
    comparison_rows = list(getattr(body, "comparison_rows", None) or [])
    if not prompt.strip():
        append_event({"type": "plan", "summary": "The prompt is empty; nothing to optimize.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return
    run_row, score_input = st.get("_run_row"), st.get("_score_input")
    if run_row is None or score_input is None:
        append_event({"type": "error", "detail": (
            f"{label} scores candidate prompts with the Generate model and this Evaluate's rules. Give the Generate "
            "node a model and typed output fields, run Generate and Evaluate again, then Optimize.")})
        return
    examples, observations, _rows_of, _numbers = build_inputs(comparison_rows)
    scorable = getattr(score_input, "scorable", None)
    if scorable is not None:
        examples = [e for e in examples if e.id in scorable]
    if not examples:
        append_event({"type": "plan", "summary": "No evaluated inputs to score candidates on.", "diagnosis_total": 0})
        append_event({"type": "done"})
        return

    def meta(text: str) -> str:
        return llm_chat(provider, model, api_key, base_url, [{"role": "user", "content": text}], max_tokens=max_tokens)

    search = _Search(prompt=prompt, examples=examples, observations=observations, run_row=run_row,
                     score_input=score_input, meta=meta, is_cancelled=is_cancelled,
                     concurrency=getattr(run_row, "concurrency", 1))
    if method == "ape":
        rounds = _setting(st, "ape_rounds", DEFAULT_APE_ROUNDS)
        summary = (f"APE: {APE_NUM_PROMPTS} proposals from the optimization model, then {rounds} round(s) scoring the "
                   f"candidates on {min(BATCH_SIZE, len(examples))} input(s) each with the Generate model "
                   f"({len(examples)} evaluated input(s)). Cost scales with rounds x candidates x 16.")
    else:
        rounds = _setting(st, "evoprompt_generations", DEFAULT_EVO_GENERATIONS)
        dev = min(EVO_DEV_LONG if _long_inputs(examples) else EVO_DEV, len(examples))
        summary = (f"EvoPrompt (DE): a population of {EVO_POPSIZE} prompts evolved for {rounds} generation(s), every "
                   f"candidate scored on {dev} input(s) with the Generate model. Cost scales with generations x "
                   f"{EVO_POPSIZE} x {dev}.")
    append_event({"type": "plan", "summary": summary, "diagnosis_total": 0})
    try:
        if method == "ape":
            best, info = run_ape_search(search, rounds, append_event)
        else:
            best, info = run_evoprompt_search(search, rounds, append_event)
    except _Cancelled:
        return
    except Exception as e:
        if is_cancelled():
            return
        _print(f"[PromptSearch] {label} failed: {e}")
        append_event({"type": "error", "detail": f"{label} failed: {e}"})
        return
    _print(f"[PromptSearch] {label} done: best={info['best']:.3f} base={info['base']:.3f} "
           f"task_calls={search.task_calls} meta_calls={search.meta_calls} meta_failures={search.meta_failures}")
    append_event({"type": "stage", "stage_id": "select", "kind": "start", "payload": {}})
    card = None
    if best != prompt and info["best"] > info["base"]:
        card = _card(label=label, prompt=prompt, best=best, info=info, comparison_rows=comparison_rows)
    append_event({"type": "stage", "stage_id": "select", "kind": "done", "payload": {
        "improved": card is not None, "final_score": round(info["best"], 4), "original_score": round(info["base"], 4),
        "generate_calls": search.task_calls, "optimization_calls": search.meta_calls}})
    if card is not None:
        append_event({"type": "suggestions", "suggestions": [card]})
    append_event({"type": "done"})


def run_ape(**kwargs) -> None:
    kwargs.pop("max_failed_inputs", None)
    _run("ape", **kwargs)


def run_evoprompt(**kwargs) -> None:
    kwargs.pop("max_failed_inputs", None)
    _run("evoprompt", **kwargs)
