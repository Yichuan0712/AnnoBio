"""Worked-example search (ENGINE_V2_DESIGN 6.0m; the experiment's demo search, PAPER_PLAN 10.50).

Six candidate example sets, two per source, built from a pool of inputs on which the prompt has run:
  failures      the demos card's choice (Session.propose_demos: one failed input per issue cluster), and a
                second set of other failed inputs;
  labeled       pool inputs with their reference answers, spread over the reference labels;
  bootstrapped  pool inputs the prompt got fully right, shown with the prompt's OWN output.
The first set of each source carries an explanation per example (the optimization model, from the input and
the reference), the second does not. Successive halving on separate scoring inputs (never shown as examples):
the prompt and all candidates on the first 16, the prompt and the best three candidates on all of them; the
best candidate by that score (ties: shorter prompt, then name). The caller decides whether to use it (the
experiment: its validation set; the app: the user, from the card).
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Callable, Sequence

from ..types import Example
from .session import Session

# (prompt, [(example, output text, explanation or None), ...]) -> the prompt followed by an examples block
RenderDemos = Callable[[str, list], str]
FIRST_STAGE = 16
FINALISTS = 3
NAMES = ("failures+explained", "failures", "labeled+explained", "labeled", "bootstrapped+explained", "bootstrapped")


@dataclass(frozen=True, slots=True)
class DemoCandidate:
    name: str
    source: str            # failures | labeled | bootstrapped
    explained: bool
    example_ids: tuple[str, ...]
    prompt: str
    first_score: float
    full_score: float | None = None


@dataclass(slots=True)
class DemoSearchResult:
    pool_ids: tuple[str, ...]
    scoring_ids: tuple[str, ...]
    base_first_score: float | None = None
    base_full_score: float | None = None
    candidates: list[DemoCandidate] = field(default_factory=list)
    best: str | None = None           # a candidate name; None when no candidate could be built
    model_calls: int = 0

    def best_candidate(self) -> DemoCandidate | None:
        return next((c for c in self.candidates if c.name == self.best), None)


def _default_label(example: Example) -> str:
    text = json.dumps(example.reference, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return text if len(text) <= 64 else "long"


def search_demos(*, model, predict, evaluate, render: RenderDemos, prompt: str, pool: Sequence[Example],
                 scoring: Sequence[Example], cap: int, seed: int, config=None, aggregate=None,
                 label_of: Callable[[Example], str] | None = None, stop_on: tuple = (), is_cancelled=None,
                 on_event=None) -> DemoSearchResult:
    """See the module docstring. `pool` and `scoring` must not share inputs; `cap` = examples per set."""
    if cap < 1:
        raise ValueError("cap must be at least 1")
    pool, scoring = list(pool), [e for e in scoring if e.id not in {p.id for p in pool}]
    common = dict(model=model, predict=predict, evaluate=evaluate, config=config, aggregate=aggregate,
                  stop_on=stop_on, is_cancelled=is_cancelled, on_event=on_event)
    result = DemoSearchResult(tuple(e.id for e in pool), tuple(e.id for e in scoring))
    rng = random.Random(seed)
    session = Session(**common, prompt=prompt, examples=pool,
                      with_demos=lambda text, shown: text + "\n\nWORKED_EXAMPLES\n" + " ".join(e.id for e in shown))
    observed = {o.example_id: o for o in session.baseline().observations}
    ids = [e.id for e in pool]
    failed = [k for k in ids if observed[k].evaluation.score < 1]
    right = [k for k in ids if observed[k].evaluation.score >= 1]
    card = session.propose_demos(cap) if failed else None
    fail_1 = list(card.demo_example_ids) if card is not None else rng.sample(failed, min(cap, len(failed)))
    rest = [k for k in failed if k not in fail_1]
    fail_2 = rng.sample(rest, min(cap, len(rest)))
    label = label_of or _default_label
    by_label: dict[str, list[str]] = {}
    for k in rng.sample(ids, len(ids)):
        by_label.setdefault(label(session.by_id[k]), []).append(k)
    spread = [k for group in zip(*[iter(v) for v in by_label.values()]) for k in group] if len(by_label) > 1 else []
    order = list(dict.fromkeys(spread + [k for v in by_label.values() for k in v]))
    lab_1, lab_2 = order[:cap], order[cap:2 * cap]
    boot = rng.sample(right, len(right))
    boot_1, boot_2 = boot[:cap], boot[cap:2 * cap]

    def explanation(k):
        example = session.by_id[k]
        data = session._ask("explain", {"prompt": prompt, "input": example.inputs, "reference": example.reference})
        return str(data.get("explanation", "")).strip()

    def rendered(chosen, source, explained):
        demos = []
        for k in chosen:
            example = session.by_id[k]
            output = (str(observed[k].prediction) if source == "bootstrapped" else
                      json.dumps(example.reference, ensure_ascii=False, separators=(",", ":"))
                      if not isinstance(example.reference, str) else example.reference)
            demos.append((example, output, explanation(k) if explained else None))
        return render(prompt, demos)

    built = []
    for name, chosen, source, explained in ((NAMES[0], fail_1, "failures", True), (NAMES[1], fail_2, "failures", False),
                                            (NAMES[2], lab_1, "labeled", True), (NAMES[3], lab_2, "labeled", False),
                                            (NAMES[4], boot_1, "bootstrapped", True), (NAMES[5], boot_2, "bootstrapped", False)):
        if chosen:
            built.append((name, tuple(chosen), source, explained, rendered(chosen, source, explained)))
    result.model_calls = len(session.model_calls)
    if not built or not scoring:
        return result
    scorer = Session(**common, prompt=prompt, examples=scoring)
    first = [e.id for e in scoring[:FIRST_STAGE]]
    every = [e.id for e in scoring]

    def score(text, which):
        return scorer.set_score(scorer.run(text, which).observations)

    stage1 = {name: score(text, first) for name, _, _, _, text in built}
    result.base_first_score = score(prompt, first)
    texts = {name: text for name, _, _, _, text in built}
    top = sorted(texts, key=lambda n: (-stage1[n], len(texts[n]), n))[:FINALISTS]
    full = {n: score(texts[n], every) for n in top}
    result.base_full_score = score(prompt, every)
    result.best = min(top, key=lambda n: (-full[n], len(texts[n]), n))
    result.candidates = [DemoCandidate(name, source, explained, chosen, text, stage1[name], full.get(name))
                         for name, chosen, source, explained, text in built]
    return result
