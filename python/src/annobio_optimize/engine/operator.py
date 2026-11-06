"""The automatic operator: runs the engine with no person in the loop (E4/E5; ENGINE_V2_DESIGN.md 2, 6, 7).

It may only do what a user can do in the Optimize panel: analyze, verify, search a card that
failed verification, accept or revert cards, and apply. Per round (one batch of inputs):

1. A session reviews the incumbent prompt on the batch and proposes cards: a whole-prompt rewrite
   card, localized cards, or both (see the schedules below), plus the worked-examples card while
   demos are on and none was accepted yet.
2. Each card is verified. A localized card that fixes nothing or breaks a regression input is
   searched once (if search_failed_cards), and its optimized card replaces it if that one passes.
3. Outcomes are in item scores (pass/fail tasks: 0/1; partial-credit tasks such as per-document F1:
   the score), so a partial improvement counts and a rerun wobble of a fully correct input does not
   condemn a card. A card passes its verification (a lenient screen) when its targets gain at least
   `min_fix` and its regression inputs drop by at most `max_drop` in total. From the passing cards
   the operator forms options: the rewrite card alone; all passing localized cards together (the
   best card of each issue cluster); the best localized card alone. Each option is run on the whole
   batch and compared with the incumbent on the same inputs (the real gate). It is eligible when
   the summed drop over the batch is at most `max_batch_drop` and the net gain is at least
   `min_gain`, or ties within that margin while being shorter. The eligible option with the
   largest gain wins (shorter on ties); with none, nothing changes.

Default thresholds come from development pilot step 0 (2026-11-05): five identical runs of three
prompts per task; each default sits at or above the 95th percentile of identical-run noise
(16-item batch net gain: 1 / 0.9-1.2 / 1-2 for PubMedQA / BioRED / RoBBR; batch drop 1 / 1.3-1.8 /
1-2; drop on 4 top-scoring inputs 1 / 0.7-1.3 / 1).

The initial prompt is therefore always a candidate: it stays unless something beats it.

Schedules (which cards a round proposes):
- coarse_to_fine: rewrite only, until `coarse_patience` rounds in a row commit nothing or
  `coarse_budget_fraction` of the search budget is spent; then localized only, for good.
- compete (verification decides, user decision 2026-11-05): localized cards every round; the
  rewrite card too while less than `coarse_budget_fraction` is spent, and later only when
  `coarse_patience` rounds in a row committed nothing (at most once per `coarse_patience` rounds).
  Both kinds are verified on the same batch and the better one wins.
- coarse_only / fine_only: one kind throughout (E5 ablation).
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Callable, Iterable, Literal, Sequence

from .. import validation as check
from ..errors import InputValueError
from ..types import CancelCheck, Evaluate, EventCallback, Example, OptimizationModel, Predict, prompt_id
from .records import EngineConfig
from .session import EngineStopped, Session, WithDemos

Schedule = Literal["coarse_to_fine", "compete", "coarse_only", "fine_only"]
SCHEDULES = ("coarse_to_fine", "compete", "coarse_only", "fine_only")


@dataclass(frozen=True, slots=True)
class OperatorConfig:
    schedule: Schedule = "compete"
    coarse_patience: int = 2
    coarse_budget_fraction: float = 0.4
    min_fix: float = 0.5         # card screen: summed target score gain
    max_drop: float = 1.0        # card screen: summed regression-input score drop
    min_gain: float = 2.0        # batch gate: net summed score gain over the incumbent
    max_batch_drop: float = 2.0  # batch gate: summed score drop over the batch
    search_failed_cards: bool = True
    # Search only a promising card: its targets gained at least `min_fix` (beyond identical-run noise),
    # so it failed the screen through its regression inputs alone. On pass/fail tasks this means it fixed
    # at least one target; on partial-credit tasks a wobble no longer counts (pilot step 2, BioRED: almost
    # every card moved its targets a little, so nearly all were searched).
    search_only_promising: bool = False
    demos_cap: int = 0  # 0: no worked-examples card (the zero-shot condition)
    # Where the batch gate compares options with the incumbent: "next" = the NEXT batch, whose inputs
    # this round's diagnoses and cards never saw (held out; pilot step 2 showed that gating on the
    # diagnosed batch accepts every round while validation falls); "same" = the diagnosed batch.
    gate: Literal["next", "same"] = "next"
    # How many following batches the held-out gate pools (more inputs separate a small true gain from
    # noise; min_gain and max_batch_drop are summed over the pooled inputs, so scale them with it).
    gate_batches: int = 1

    def __post_init__(self):
        check.integer(self.gate_batches, "OperatorConfig.gate_batches", minimum=1)
        check.boolean(self.search_only_promising, "OperatorConfig.search_only_promising")
        check.choice(self.gate, ("next", "same"), "OperatorConfig.gate")
        check.choice(self.schedule, SCHEDULES, "OperatorConfig.schedule")
        for name in ("coarse_patience", "demos_cap"):
            check.integer(getattr(self, name), f"OperatorConfig.{name}", minimum=0)
        check.unit_score(self.coarse_budget_fraction, "OperatorConfig.coarse_budget_fraction")
        for name in ("min_fix", "max_drop", "min_gain", "max_batch_drop"):
            check.finite_number(getattr(self, name), f"OperatorConfig.{name}")
            if getattr(self, name) < 0:
                raise InputValueError("must be non-negative.", path=f"OperatorConfig.{name}")
        check.boolean(self.search_failed_cards, "OperatorConfig.search_failed_cards")


@dataclass(frozen=True, slots=True)
class RoundSummary:
    index: int
    phase: Literal["coarse", "fine", "both"]  # which card kinds this round proposed
    start_prompt_id: str
    end_prompt_id: str
    committed: bool
    reason: str
    cards: int
    accepted_card_ids: tuple[str, ...]
    gain: float | None
    lost: int | None  # inputs passing before and failing after (reported; the gate uses drop)
    chosen: str = ""  # the winning option: rewrite, localized, best_localized
    options: tuple[dict, ...] = ()  # every option tried: name, gain, lost, drop, chars, eligible
    gate: str = ""  # "next" (held-out batch) or "same"


@dataclass
class OperatorResult:
    initial_prompt: str
    prompt: str
    rounds: list[RoundSummary] = field(default_factory=list)
    sessions: list[dict] = field(default_factory=list)
    stop_reason: str = "rounds_completed"


class Operator:
    def __init__(self, *, model: OptimizationModel, predict: Predict, evaluate: Evaluate,
                 config: EngineConfig | None = None, operator: OperatorConfig | None = None,
                 with_demos: WithDemos | None = None, budget_fraction: Callable[[], float] | None = None,
                 on_round: Callable[[str, RoundSummary], None] | None = None,
                 is_cancelled: CancelCheck | None = None, on_event: EventCallback | None = None,
                 stop_on: tuple = ()):
        check.instance(config, EngineConfig, "Operator.config", allow_none=True)
        check.instance(operator, OperatorConfig, "Operator.operator", allow_none=True)
        self.stop_on = tuple(stop_on)
        self.config = config if config is not None else EngineConfig()
        self.settings = operator if operator is not None else OperatorConfig()
        if self.settings.demos_cap and with_demos is None:
            raise InputValueError("demos_cap needs a with_demos callback.", path="Operator.with_demos")
        self.callbacks = dict(model=model, predict=predict, evaluate=evaluate)
        self.with_demos = with_demos
        self.budget_fraction = budget_fraction
        self.on_round = on_round
        self.is_cancelled = is_cancelled
        self.on_event = on_event

    def _spent(self) -> float:
        return self.budget_fraction() if self.budget_fraction is not None else 0.0

    def run(self, prompt: str, batches: Iterable[Sequence[Example]], max_rounds: int | None = None) -> OperatorResult:
        """At most max_rounds rounds; a batch after the last round still serves as that round's gate."""
        check.string(prompt, "Operator.run.prompt", nonempty=True)
        if max_rounds is not None:
            check.integer(max_rounds, "Operator.run.max_rounds", minimum=1)
        s = self.settings
        # Kept on the operator as it grows, so a host whose own exception (stop_on) ends the run
        # can still save every finished session.
        self.result = result = OperatorResult(prompt, prompt)
        coarse = s.schedule in ("coarse_to_fine", "coarse_only")  # coarse_to_fine's current phase
        stale = 0            # rounds in a row that committed nothing
        since_rewrite = 0    # rounds since a rewrite card was last proposed (compete)
        history, demos_done = [], s.demos_cap == 0
        carried = None  # the incumbent's observations on the coming batch, from last round's gate
        stream = iter(batches)
        ahead: list = []  # this round's batch and the batches its gate pools

        def fill():
            while len(ahead) < 1 + s.gate_batches:
                more = next(stream, None)
                if more is None:
                    return
                ahead.append(list(more))
        fill()
        index = -1
        try:
            while ahead and (max_rounds is None or index + 1 < max_rounds):
                index += 1
                batch = ahead.pop(0)
                fill()
                taken = {e.id for e in batch}
                upcoming = []  # the gate inputs: the following batches, minus repeats of this batch
                for example in (e for b in ahead[:s.gate_batches] for e in b):
                    if example.id not in taken:
                        taken.add(example.id)
                        upcoming.append(example)
                if s.schedule == "compete":
                    early = self._spent() < s.coarse_budget_fraction
                    stalled = stale >= s.coarse_patience and since_rewrite >= s.coarse_patience
                    want_rewrite, want_local = early or stalled, True
                elif s.schedule == "fine_only":
                    want_rewrite, want_local = False, True
                elif s.schedule == "coarse_only":
                    want_rewrite, want_local = True, False
                else:
                    want_rewrite, want_local = coarse, not coarse
                common = dict(**self.callbacks, config=replace(self.config, seed=self.config.seed * 1000003 + index),
                              is_cancelled=self.is_cancelled, on_event=self.on_event, stop_on=self.stop_on)
                session = Session(**common, prompt=result.prompt, examples=batch, history=history,
                                  with_demos=self.with_demos, observations=carried)
                gate = None
                if s.gate == "next" and upcoming:
                    gate = Session(**common, prompt=result.prompt, examples=upcoming)
                carried = None
                try:
                    summary, carried = self._round(session, index, want_rewrite, want_local, demos_done, gate)
                    if carried is not None:  # reuse only an exact cover of the next round's batch
                        wanted = {e.id for e in ahead[0]} if ahead else set()
                        carried = [o for o in carried if o.example_id in wanted]
                        if {o.example_id for o in carried} != wanted or not wanted:
                            carried = None
                finally:
                    history = (history + session.history_items())[-max(1, self.config.history_items):]
                    snapshot = session.snapshot()
                    if gate is not None:  # the gate inputs and per-prompt scores (no payloads)
                        snapshot["gate"] = {"examples": [e.id for e in gate.examples],
                                            "evaluations": [{"prompt_id": b.prompt_id, "score": b.score}
                                                            for b in gate.evaluations]}
                    result.sessions.append(snapshot)
                if summary.committed:
                    result.prompt = session.apply()
                    if any(session.card(id).kind == "demos" for id in summary.accepted_card_ids):
                        demos_done = True
                result.rounds.append(summary)
                stale = 0 if summary.committed else stale + 1
                since_rewrite = 0 if want_rewrite else since_rewrite + 1
                if s.schedule == "coarse_to_fine" and coarse and (
                        stale >= s.coarse_patience or self._spent() >= s.coarse_budget_fraction):
                    coarse = False
                if self.on_round is not None:
                    self.on_round(result.prompt, summary)
        except EngineStopped as exc:
            result.stop_reason = exc.reason
        return result

    def _round(self, session: Session, index: int, want_rewrite: bool, want_local: bool,
               demos_done: bool, gate: Session | None = None):
        """One round. Returns (summary, observations of the resulting incumbent on the gate batch or None)."""
        start = prompt_id(session.source)
        phase = "both" if want_rewrite and want_local else "coarse" if want_rewrite else "fine"
        judge = gate if gate is not None else session

        def summary(committed, reason, accepted=(), gain=None, lost=None, cards=0, chosen="", options=(), carry=None):
            if carry is None and gate is not None and gate.evaluations:
                carry = gate.baseline().observations  # the unchanged incumbent on the coming batch
            return RoundSummary(index, phase, start, prompt_id(session.apply()), committed, reason, cards,
                                tuple(accepted), gain, lost, chosen, tuple(options),
                                "next" if gate is not None else "same"), carry

        cards = []
        if want_local:
            cards += session.analyze("local")
        if want_rewrite:
            cards += session.analyze("rewrite")
        if not demos_done:
            card = session.propose_demos(self.settings.demos_cap)
            if card is not None:
                cards.append(card)
        if not session.issues:
            return summary(False, "no failed inputs in this batch")
        records = {card.id: session.verify(card.id) for card in cards}
        passing = [(card, records[card.id]) for card in cards if self._acceptable(records[card.id])]
        if self.settings.search_failed_cards:
            # At most one search per issue cluster, and none for a cluster that already has a passing
            # card: the failing alternative with the most progress is searched.
            covered = {card.cluster_id for card, _ in passing if card.cluster_id}
            chosen: dict[str, tuple] = {}
            for card in cards:
                record = records[card.id]
                if self._acceptable(record) or not session.searchable(card.id) or card.cluster_id in covered:
                    continue
                progress = _progress(session, record)
                if self.settings.search_only_promising and progress[0] < self.settings.min_fix:
                    continue
                key = card.cluster_id or card.id
                if key not in chosen or progress > chosen[key][0]:
                    chosen[key] = (progress, card)
            for _, card in sorted(chosen.values(), key=lambda item: cards.index(item[1])):
                searched = session.search(card.id)
                if searched.optimized_card_id is not None:
                    optimized = session.card(searched.optimized_card_id)
                    record = session.latest_check(optimized.id)
                    if record is not None and self._acceptable(record):
                        passing.append((optimized, record))
        if not passing:
            return summary(False, "no card fixed a target without breaking a regression input", cards=len(cards))
        # Highest net fix count first; shorter text breaks ties.
        passing.sort(key=lambda pair: (-(pair[1].target_gain - pair[1].regression_drop), len(pair[0].new_text)))
        localized, clusters = [], set()
        for card, _ in passing:  # the combined option takes the best card of each issue cluster
            key = card.cluster_id or card.id
            if card.kind != "rewrite" and key not in clusters:
                clusters.add(key)
                localized.append(card)
        options = []
        if localized:
            options.append(("localized", localized))
            if len(localized) > 1:
                options.append(("best_localized", localized[:1]))
        options += [("rewrite", [card]) for card, _ in passing if card.kind == "rewrite"]
        baseline = judge.baseline()
        tried, best = [], None
        for name, chosen in options:
            for card_id in list(session.applied):
                session.revert(card_id)
            for card in chosen:
                session.accept(card.id)
            candidate = session.apply()
            if candidate == session.source:
                continue
            run = judge.run(candidate, [e.id for e in judge.examples])
            gain, lost, drop = _paired(judge, baseline, run)
            within = abs(gain) < self.settings.min_gain
            eligible = drop <= self.settings.max_batch_drop and (
                gain >= self.settings.min_gain or (within and gain >= 0 and len(candidate) < len(session.source)))
            tried.append({"name": name, "gain": gain, "lost": lost, "drop": drop, "chars": len(candidate),
                          "eligible": eligible})
            if eligible and (best is None or (gain, -len(candidate)) > (best[2], -best[4])):
                best = (name, chosen, gain, lost, len(candidate), run.observations)
        for card_id in list(session.applied):
            session.revert(card_id)
        where = "the held-out next batch" if gate is not None else "the whole batch"
        if best is None:
            return summary(False, f"no option beat the incumbent on {where}", cards=len(cards), options=tried)
        name, chosen, gain, lost, _, observations = best
        for card in chosen:
            session.accept(card.id)
        reason = "gain beyond the noise margin" if gain >= self.settings.min_gain else "equal within the noise margin and shorter"
        return summary(True, f"{reason} on {where}", [c.id for c in chosen], gain, lost, len(cards), name, tried,
                       carry=observations if gate is not None else None)

    def _acceptable(self, record) -> bool:
        return (record.status == "complete" and record.target_gain >= self.settings.min_fix
                and record.regression_drop <= self.settings.max_drop)


def _progress(session: Session, record) -> tuple[float, int]:
    """(target score gain, comparison rows matched beyond the incumbent's) for a verification."""
    if record.status != "complete":
        return (0, 0)
    base = {item.example_id: item for item in session.baseline().observations}
    before = sum(base[i].evaluation.matched_count if base[i].evaluation.total_count is not None
                 else int(session.passed(base[i])) for i in record.target_ids)
    return (round(record.target_gain, 9), record.matched_count - before)


def _paired(session: Session, before, after) -> tuple[float, int, float]:
    """On the same inputs: summed score change, inputs that passed before and fail after, and the
    summed score drop (decreases only)."""
    old = {item.example_id: item for item in before.observations}
    gain = sum(item.evaluation.score - old[item.example_id].evaluation.score for item in after.observations)
    lost = sum(1 for item in after.observations
               if session.passed(old[item.example_id]) and not session.passed(item))
    drop = sum(max(0.0, old[item.example_id].evaluation.score - item.evaluation.score) for item in after.observations)
    return gain, lost, drop
