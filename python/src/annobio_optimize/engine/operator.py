"""The automatic operator: runs the engine with no person in the loop (E4/E5; ENGINE_V2_DESIGN.md 2, 6, 7).

It may only do what a user can do in the Optimize panel: analyze, verify, search a card that
failed verification, accept or revert cards, and apply. Per round (one batch of inputs):

1. A session reviews the incumbent prompt on the batch and proposes cards: one whole-prompt
   rewrite in the coarse phase, localized cards in the fine phase, plus the worked-examples
   card when demos are on.
2. Each card is verified; in the fine phase a card that fixes nothing or breaks a regression
   input is searched once, and its optimized card replaces it if that one passes.
3. Cards that fix at least one target and break no regression input are accepted together.
   The resulting prompt replaces the incumbent only if, paired on the whole batch, it gains at
   least `min_gain` (noise margin, in summed item scores) without losing more than
   `max_lost` previously passing inputs, or ties within the margin while being shorter.
   Otherwise the best single card is tried the same way; otherwise nothing changes.

The initial prompt is therefore always a candidate: it stays unless something beats it.
Coarse -> fine: after `coarse_patience` coarse rounds in a row without a committed change, or
once `coarse_budget_fraction` of the budget is spent (if the host reports spending).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Callable, Iterable, Literal, Sequence

from .. import validation as check
from ..errors import InputValueError
from ..types import CancelCheck, Evaluate, EventCallback, Example, OptimizationModel, Predict, prompt_id
from .records import EngineConfig, HistoryItem
from .session import EngineStopped, Session, WithDemos

Schedule = Literal["coarse_to_fine", "coarse_only", "fine_only"]


@dataclass(frozen=True, slots=True)
class OperatorConfig:
    schedule: Schedule = "coarse_to_fine"
    coarse_patience: int = 2
    coarse_budget_fraction: float = 0.4
    min_gain: float = 1.0
    max_lost: int = 0
    search_failed_cards: bool = True
    demos_cap: int = 0  # 0: no worked-examples card (the zero-shot condition)

    def __post_init__(self):
        check.choice(self.schedule, ("coarse_to_fine", "coarse_only", "fine_only"), "OperatorConfig.schedule")
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
    phase: Literal["coarse", "fine"]
    start_prompt_id: str
    end_prompt_id: str
    committed: bool
    reason: str
    cards: int
    accepted_card_ids: tuple[str, ...]
    gain: float | None
    lost: int | None


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
        self.stop_on = tuple(stop_on)
        check.instance(operator, OperatorConfig, "Operator.operator", allow_none=True)
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

    def run(self, prompt: str, batches: Iterable[Sequence[Example]]) -> OperatorResult:
        check.string(prompt, "Operator.run.prompt", nonempty=True)
        result = OperatorResult(prompt, prompt)
        phase = "fine" if self.settings.schedule == "fine_only" else "coarse"
        stale, history, demos_done = 0, [], self.settings.demos_cap == 0
        try:
            for index, batch in enumerate(batches):
                session = Session(**self.callbacks, prompt=result.prompt, examples=batch,
                                  config=_seeded(self.config, index), history=history, with_demos=self.with_demos,
                                  is_cancelled=self.is_cancelled, on_event=self.on_event, stop_on=self.stop_on)
                try:
                    summary = self._round(session, index, phase, demos_done)
                finally:
                    history = (history + session.history_items())[-max(1, self.config.history_items):]
                    result.sessions.append(session.snapshot())
                if summary.committed:
                    result.prompt = session.apply()
                    if any(session.card(id).kind == "demos" for id in summary.accepted_card_ids):
                        demos_done = True
                result.rounds.append(summary)
                if phase == "coarse" and self.settings.schedule == "coarse_to_fine":
                    stale = 0 if summary.committed else stale + 1
                    spent = self.budget_fraction() if self.budget_fraction is not None else 0.0
                    if stale >= self.settings.coarse_patience or spent >= self.settings.coarse_budget_fraction:
                        phase = "fine"
                if self.on_round is not None:
                    self.on_round(result.prompt, summary)
        except EngineStopped as exc:
            result.stop_reason = exc.reason
        return result

    def _round(self, session: Session, index: int, phase: str, demos_done: bool) -> RoundSummary:
        start = prompt_id(session.source)

        def summary(committed, reason, accepted=(), gain=None, lost=None, cards=0):
            return RoundSummary(index, phase, start, prompt_id(session.apply()), committed, reason, cards,
                                tuple(accepted), gain, lost)

        cards = session.analyze("rewrite" if phase == "coarse" else "local")
        if not demos_done:
            card = session.propose_demos(self.settings.demos_cap)
            if card is not None:
                cards.append(card)
        if not session.issues:
            return summary(False, "no failed inputs in this batch")
        passing = []
        for card in cards:
            record = session.verify(card.id)
            if not self._acceptable(record) and phase == "fine" and self.settings.search_failed_cards \
                    and session.searchable(card.id):
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
        attempts = [[card for card, _ in passing]]
        if len(passing) > 1:
            attempts.append([passing[0][0]])
        baseline = session.baseline()
        gain = lost = None
        for chosen in attempts:
            for card in list(session.applied):
                session.revert(card)
            for card in chosen:
                session.accept(card.id)
            candidate = session.apply()
            if candidate == session.source:
                continue
            batch = session.run(candidate, [e.id for e in session.examples])
            gain, lost = _paired(session, baseline, batch)
            shorter = len(candidate) < len(session.source)
            if lost <= self.settings.max_lost and (gain >= self.settings.min_gain
                                                   or (abs(gain) < self.settings.min_gain and gain >= 0 and shorter)):
                return summary(True, "gain beyond the noise margin" if gain >= self.settings.min_gain
                               else "equal within the noise margin and shorter",
                               [c.id for c in chosen], gain, lost, len(cards))
        for card in list(session.applied):
            session.revert(card)
        return summary(False, "accepted cards did not beat the incumbent on the whole batch",
                       gain=gain, lost=lost, cards=len(cards))

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


def _seeded(config: EngineConfig, index: int) -> EngineConfig:
    from dataclasses import replace
    return replace(config, seed=config.seed * 1000003 + index)
