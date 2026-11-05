"""The automatic operator: runs the engine with no person in the loop (E4/E5; ENGINE_V2_DESIGN.md 2, 6, 7).

It may only do what a user can do in the Optimize panel: analyze, verify, search a card that
failed verification, accept or revert cards, and apply. Per round (one batch of inputs):

1. A session reviews the incumbent prompt on the batch and proposes cards: a whole-prompt rewrite
   card, localized cards, or both (see the schedules below), plus the worked-examples card while
   demos are on and none was accepted yet.
2. Each card is verified. A localized card that fixes nothing or breaks a regression input is
   searched once (if search_failed_cards), and its optimized card replaces it if that one passes.
3. A card passes when it fixes at least one target and breaks at most `max_lost` regression inputs.
   From the passing cards the operator forms options: the rewrite card alone; all passing localized
   cards together; the best localized card alone. Each option is run on the whole batch and
   compared with the incumbent on the same inputs. An option is eligible when it loses at most
   `max_lost` previously passing inputs and either gains at least `min_gain` (the noise margin, in
   summed item scores) or ties within the margin while being shorter. The eligible option with
   the largest gain wins (shorter on ties); with none, nothing changes.

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
    min_gain: float = 1.0
    max_lost: int = 0
    search_failed_cards: bool = True
    demos_cap: int = 0  # 0: no worked-examples card (the zero-shot condition)

    def __post_init__(self):
        check.choice(self.schedule, SCHEDULES, "OperatorConfig.schedule")
        for name in ("coarse_patience", "max_lost", "demos_cap"):
            check.integer(getattr(self, name), f"OperatorConfig.{name}", minimum=0)
        check.unit_score(self.coarse_budget_fraction, "OperatorConfig.coarse_budget_fraction")
        check.finite_number(self.min_gain, "OperatorConfig.min_gain")
        if self.min_gain < 0:
            raise InputValueError("must be non-negative.", path="OperatorConfig.min_gain")
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
    lost: int | None
    chosen: str = ""  # the winning option: rewrite, localized, best_localized
    options: tuple[dict, ...] = ()  # every option tried: name, gain, lost, chars, eligible


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

    def run(self, prompt: str, batches: Iterable[Sequence[Example]]) -> OperatorResult:
        check.string(prompt, "Operator.run.prompt", nonempty=True)
        s = self.settings
        result = OperatorResult(prompt, prompt)
        coarse = s.schedule in ("coarse_to_fine", "coarse_only")  # coarse_to_fine's current phase
        stale = 0            # rounds in a row that committed nothing
        since_rewrite = 0    # rounds since a rewrite card was last proposed (compete)
        history, demos_done = [], s.demos_cap == 0
        try:
            for index, batch in enumerate(batches):
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
                session = Session(**self.callbacks, prompt=result.prompt, examples=batch,
                                  config=replace(self.config, seed=self.config.seed * 1000003 + index),
                                  history=history, with_demos=self.with_demos, is_cancelled=self.is_cancelled,
                                  on_event=self.on_event, stop_on=self.stop_on)
                try:
                    summary = self._round(session, index, want_rewrite, want_local, demos_done)
                finally:
                    history = (history + session.history_items())[-max(1, self.config.history_items):]
                    result.sessions.append(session.snapshot())
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
               demos_done: bool) -> RoundSummary:
        start = prompt_id(session.source)
        phase = "both" if want_rewrite and want_local else "coarse" if want_rewrite else "fine"

        def summary(committed, reason, accepted=(), gain=None, lost=None, cards=0, chosen="", options=()):
            return RoundSummary(index, phase, start, prompt_id(session.apply()), committed, reason, cards,
                                tuple(accepted), gain, lost, chosen, tuple(options))

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
        passing = []
        for card in cards:
            record = session.verify(card.id)
            if not self._acceptable(record) and self.settings.search_failed_cards and session.searchable(card.id):
                searched = session.search(card.id)
                if searched.optimized_card_id is not None:
                    card = session.card(searched.optimized_card_id)
                    record = session.latest_check(card.id)
            if record is not None and self._acceptable(record):
                passing.append((card, record))
        if not passing:
            return summary(False, "no card fixed a target without breaking a regression input", cards=len(cards))
        # Highest net fix count first; shorter text breaks ties.
        passing.sort(key=lambda pair: (-(len(pair[1].fixed_ids) - len(pair[1].lost_ids)), len(pair[0].new_text)))
        localized = [card for card, _ in passing if card.kind != "rewrite"]
        options = []
        if localized:
            options.append(("localized", localized))
            if len(localized) > 1:
                options.append(("best_localized", localized[:1]))
        options += [("rewrite", [card]) for card, _ in passing if card.kind == "rewrite"]
        baseline = session.baseline()
        tried, best = [], None
        for name, chosen in options:
            for card_id in list(session.applied):
                session.revert(card_id)
            for card in chosen:
                session.accept(card.id)
            candidate = session.apply()
            if candidate == session.source:
                continue
            gain, lost = _paired(session, baseline, session.run(candidate, [e.id for e in session.examples]))
            within = abs(gain) < self.settings.min_gain
            eligible = lost <= self.settings.max_lost and (
                gain >= self.settings.min_gain or (within and gain >= 0 and len(candidate) < len(session.source)))
            tried.append({"name": name, "gain": gain, "lost": lost, "chars": len(candidate), "eligible": eligible})
            if eligible and (best is None or (gain, -len(candidate)) > (best[2], -best[4])):
                best = (name, chosen, gain, lost, len(candidate))
        for card_id in list(session.applied):
            session.revert(card_id)
        if best is None:
            return summary(False, "no option beat the incumbent on the whole batch", cards=len(cards), options=tried)
        name, chosen, gain, lost, _ = best
        for card in chosen:
            session.accept(card.id)
        reason = "gain beyond the noise margin" if gain >= self.settings.min_gain else "equal within the noise margin and shorter"
        return summary(True, reason, [c.id for c in chosen], gain, lost, len(cards), name, tried)

    def _acceptable(self, record) -> bool:
        return record.status == "complete" and len(record.fixed_ids) >= 1 and len(record.lost_ids) <= self.settings.max_lost


def _paired(session: Session, before, after) -> tuple[float, int]:
    """Summed per-item score change on the same inputs, and the number of inputs that passed
    before and fail after."""
    old = {item.example_id: item for item in before.observations}
    gain = sum(item.evaluation.score - old[item.example_id].evaluation.score for item in after.observations)
    lost = sum(1 for item in after.observations
               if session.passed(old[item.example_id]) and not session.passed(item))
    return gain, lost
