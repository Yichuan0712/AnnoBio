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

Challengers (`challengers` > 0, held-out gate only; ENGINE_V2_DESIGN 6.0d): a single gate cannot
tell a small true gain from noise, so an option it rejected with a positive gain is kept. Later
gates run the kept ones against the incumbent on the same inputs, and each one's paired evidence
accumulates over the inputs after its entry gate (that gate selected it, so it is not evidence). A
challenger replaces the incumbent when its accumulated net gain reaches min_gain x sqrt(inputs /
gate size) with its summed drop within max_batch_drop per gate; the round's best qualifying entry
wins, options and challengers alike, by this gate's gain. Evidence restarts when the incumbent changes.

A negative `min_gain` makes the gate a non-inferiority check: an option is accepted unless it loses
more than |min_gain| on the held-out inputs (closest to plain rewriting, which accepts every rewrite).
`final` = "best_seen" then hands over the best prompt seen on held-out inputs rather than the last
incumbent (ENGINE_V2_DESIGN 6.0f).

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
from itertools import chain
import json
import math
from typing import Callable, Iterable, Literal, Sequence

from .. import validation as check
from ..errors import InputValueError, ModelResponseError
from ..types import CancelCheck, Evaluate, EventCallback, Example, OptimizationModel, Predict, prompt_id
from . import prompts
from .records import EngineConfig, StyleChoice
from .session import EngineStopped, Session, WithDemos, parse_reply

Schedule = Literal["coarse_to_fine", "compete", "coarse_only", "fine_only"]
SCHEDULES = ("coarse_to_fine", "compete", "coarse_only", "fine_only")

# The two optimization styles (ENGINE_V2_DESIGN 6.0h): the settings each one fixes; the others stay as given.
# concise = pilot step 11a (accept only what does not lose, roll back a drift, hand over the shortest version
# within one item of the best on set-aside inputs): PubMedQA .777, BioRED .407. detailed = pilot step 9
# (non-inferiority gate, hand over the best prompt seen on held-out inputs): BioRED .456, PubMedQA .718.
STYLE_SETTINGS = {
    "concise": {"min_gain": 0.0, "rollback_z": 2.0, "final": "holdout", "holdout_batches": 2, "final_margin": 1.0,
                "final_excludes_initial": True},
    "detailed": {"min_gain": -1.0, "rollback_z": 0.0, "final": "best_seen", "holdout_batches": 0, "final_margin": 0.0,
                 "final_excludes_initial": False},
}
STYLE_VOTES = 3            # model judgments per "auto" choice; detailed needs all of them, otherwise concise
STYLE_EXAMPLES = 2         # example inputs shown to the judgment (from the third batch: never a holdout batch)
_STYLE_CUT = {"task_prompt": 8000, "input_field": 2000, "input": 3000, "expected_output": 1500}


def _cut(value, limit: int) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + " ...[cut]"


def _cut_input(value):
    """An input with every field kept and each long field cut (a full paper must not hide the answer options)."""
    if isinstance(value, dict):
        return {key: item if len(_cut(item, 10 ** 9)) <= _STYLE_CUT["input_field"] else _cut(item, _STYLE_CUT["input_field"])
                for key, item in value.items()}
    return _cut(value, _STYLE_CUT["input"])


def suggest_style(model: OptimizationModel, prompt: str, examples: Sequence[Example], *,
                  votes: int = STYLE_VOTES) -> StyleChoice:
    """The optimization model's suggested style for this task (OperatorConfig.style "auto"; in the app, the
    suggested-mode card a user may change). Asked `votes` times; "detailed" only when every reply says so,
    otherwise "concise" (the default: a split judgment means the task sits in between). An unusable reply
    counts as no vote."""
    check.string(prompt, "suggest_style.prompt", nonempty=True)
    check.integer(votes, "suggest_style.votes", minimum=1)
    shown = list(examples)[:STYLE_EXAMPLES]
    payload = {"task_prompt": _cut(prompt, _STYLE_CUT["task_prompt"]),
               "examples": [{"input": _cut_input(e.inputs),
                             "expected_output": _cut(e.reference, _STYLE_CUT["expected_output"])} for e in shown]}
    styles, reasons = [], []
    for number in range(votes):
        # The judgment number keeps the requests distinct, so a caching host still returns separate judgments.
        request = prompts.request("style", {**payload, "judgment": number + 1})
        try:
            reply = parse_reply(check.invoke(model, request, name="model", context="stage='style'"), "style")
        except ModelResponseError:
            reply = {}
        style = reply.get("style") if reply.get("style") in STYLE_SETTINGS else ""
        reason = reply.get("reason") if isinstance(reply.get("reason"), str) else ""
        styles.append(style)
        reasons.append(reason if style else "unusable reply")
    chosen = "detailed" if all(v == "detailed" for v in styles) else "concise"
    return StyleChoice("auto", chosen, tuple(styles), tuple(reasons), tuple(e.id for e in shown))


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
    # When the worked-examples card is offered (ENGINE_V2_DESIGN 6.0k): "rounds" = in every round until
    # accepted; "end" = once, after the prompt is optimized: when the spent budget fraction, plus the
    # costliest round so far, reaches 1 - `demos_reserve`, the operator stops rewriting and runs one
    # examples round on the prompt it would hand over (diagnose, the demos card, verify, the held-out
    # gate); accepted, that prompt with examples is handed over, otherwise the prompt without; the run
    # then ends. Optimizing without examples keeps every
    # evaluation cheap (a RoBBR example is a full paper), so the instruction gets nearly the whole budget.
    demos_stage: Literal["rounds", "end"] = "rounds"
    demos_reserve: float = 0.0
    # Where the batch gate compares options with the incumbent: "next" = the NEXT batch, whose inputs
    # this round's diagnoses and cards never saw (held out; pilot step 2 showed that gating on the
    # diagnosed batch accepts every round while validation falls); "same" = the diagnosed batch.
    gate: Literal["next", "same"] = "next"
    # How many following batches the held-out gate pools (more inputs separate a small true gain from
    # noise; min_gain and max_batch_drop are summed over the pooled inputs, so scale them with it).
    gate_batches: int = 1
    # Rejected options kept as challengers (0 = off; ENGINE_V2_DESIGN 6.0d): each later held-out gate
    # also runs the best `challengers` of them against the incumbent, and their evidence accumulates
    # on the inputs after their entry gate. A challenger replaces the incumbent once its accumulated
    # net gain reaches min_gain x sqrt(inputs / gate size); one with no decision after
    # `challenger_max_gates` gates' worth of inputs, or behind after one, is dropped.
    challengers: int = 0
    challenger_max_gates: int = 4
    # The prompt the operator hands over (ENGINE_V2_DESIGN 6.0f): "last" = the incumbent after the last
    # round; "best_seen" = of every prompt run on held-out gate inputs (incumbents and options alike) on
    # at least a full gate's worth, the one with the best set score over all of them, shorter on ties.
    # It is the experiment harness's checkpoint rule moved into the engine (pilot steps 3, 7, 8: the
    # harness's pick tested better than the operator's last incumbent). Updated every round.
    # "holdout" (pilot step 11): the first `holdout_batches` batches are set aside and never diagnosed or
    # gated; every version the operator accepted (and the initial prompt) runs on them once, and the
    # version handed over is the shortest whose holdout score is within `final_margin` (item units, like
    # min_gain) of the best. Pilot step 9: on PubMedQA "best_seen" picked bloated prompts that won by
    # luck on 32 gate inputs among dozens of candidates (tests .748/.688 against the harness's .774/.702,
    # which also chooses on separate data among few candidates).
    final: Literal["last", "best_seen", "holdout"] = "last"
    holdout_batches: int = 0
    final_margin: float = 0.0
    # With "holdout": once the operator has accepted any version, the initial prompt is no longer handed
    # over (ENGINE_V2_DESIGN 6.0i). The initial prompt is the shortest, so under "shortest within
    # final_margin" it won whenever no version beat it by more than the margin on the 32 holdout inputs:
    # formal PubMedQA r3 accepted rewrites yet handed back the initial prompt every round (test = M0).
    final_excludes_initial: bool = False
    # Rollback (0 = off; pilot step 11): after a round, when an earlier accepted version's mean item score
    # on held-out gate inputs beats the incumbent's by at least `rollback_z` standard errors (both seen on
    # a full gate's worth), the incumbent returns to that version, as a user would revert to it. Pilot
    # step 9: on PubMedQA r2 two early accepted rewrites each lost on their gate and the run never
    # recovered the initial prompt's level.
    rollback_z: float = 0.0
    # The optimization style (ENGINE_V2_DESIGN 6.0h; the one user-facing switch over the settings above):
    # "fixed" = the fields as given; "concise" / "detailed" = STYLE_SETTINGS[style] replaces min_gain,
    # rollback_z, final, holdout_batches, final_margin and final_excludes_initial; "auto" = the optimization
    # model judges the task once before the first round (suggest_style) and that style applies. OperatorResult.style records it.
    style: Literal["fixed", "auto", "concise", "detailed"] = "fixed"
    # Optimizer v3 (ENGINE_V2_DESIGN 6.0n, user decision 2026-11-08): "initial" = the rounds start from the given
    # prompt (v2); "induce" = a start stage first, APE's strengths (instructions written from solved examples, many
    # candidates compared on the same inputs): the next batch only supplies examples (never scored here);
    # `start_candidates` instructions are written from `start_demos` of its inputs each (Session.propose_instructions);
    # the given prompt and every candidate run on the following batch, the given prompt and the best
    # `start_finalists` on one more; the best of them by its score over both batches, if it beats the given prompt
    # there, faces the round's usual held-out gate (min_gain, max_batch_drop) and becomes the incumbent if it passes.
    # The rounds then continue from the incumbent; an accepted start is a version like any other (rollback, final).
    # Stage-1 scoring stops once `start_budget` of the budget is spent.
    start: Literal["initial", "induce"] = "initial"
    start_candidates: int = 10
    start_demos: int = 5
    start_finalists: int = 3
    start_budget: float = 0.25

    def __post_init__(self):
        check.choice(self.style, ("fixed", "auto", "concise", "detailed"), "OperatorConfig.style")
        check.choice(self.start, ("initial", "induce"), "OperatorConfig.start")
        for name in ("start_candidates", "start_demos", "start_finalists"):
            check.integer(getattr(self, name), f"OperatorConfig.{name}", minimum=1)
        check.unit_score(self.start_budget, "OperatorConfig.start_budget")
        check.integer(self.gate_batches, "OperatorConfig.gate_batches", minimum=1)
        check.integer(self.challengers, "OperatorConfig.challengers", minimum=0)
        check.integer(self.challenger_max_gates, "OperatorConfig.challenger_max_gates", minimum=1)
        check.boolean(self.search_only_promising, "OperatorConfig.search_only_promising")
        check.choice(self.gate, ("next", "same"), "OperatorConfig.gate")
        check.choice(self.final, ("last", "best_seen", "holdout"), "OperatorConfig.final")
        check.integer(self.holdout_batches, "OperatorConfig.holdout_batches", minimum=0)
        check.boolean(self.final_excludes_initial, "OperatorConfig.final_excludes_initial")
        check.choice(self.demos_stage, ("rounds", "end"), "OperatorConfig.demos_stage")
        check.unit_score(self.demos_reserve, "OperatorConfig.demos_reserve")
        if self.demos_stage == "end" and self.demos_cap and not 0 < self.demos_reserve < 1:
            raise InputValueError("demos_stage 'end' needs 0 < demos_reserve < 1.", path="OperatorConfig.demos_reserve")
        if self.final == "holdout" and not self.holdout_batches:
            raise InputValueError("final 'holdout' needs holdout_batches >= 1.", path="OperatorConfig.holdout_batches")
        for name in ("final_margin", "rollback_z"):
            check.finite_number(getattr(self, name), f"OperatorConfig.{name}")
            if getattr(self, name) < 0:
                raise InputValueError("must be non-negative.", path=f"OperatorConfig.{name}")
        check.choice(self.schedule, SCHEDULES, "OperatorConfig.schedule")
        for name in ("coarse_patience", "demos_cap"):
            check.integer(getattr(self, name), f"OperatorConfig.{name}", minimum=0)
        check.unit_score(self.coarse_budget_fraction, "OperatorConfig.coarse_budget_fraction")
        for name in ("min_fix", "max_drop", "min_gain", "max_batch_drop"):
            check.finite_number(getattr(self, name), f"OperatorConfig.{name}")
            # min_gain may be negative: accept an option unless it is worse by more than |min_gain|.
            if name != "min_gain" and getattr(self, name) < 0:
                raise InputValueError("must be non-negative.", path=f"OperatorConfig.{name}")
        if self.challengers and self.min_gain <= 0:
            raise InputValueError("challengers need a positive min_gain.", path="OperatorConfig.challengers")
        check.boolean(self.search_failed_cards, "OperatorConfig.search_failed_cards")


@dataclass(frozen=True, slots=True)
class RoundSummary:
    index: int
    # which card kinds this round proposed ("demos": the end stage; "start": optimizer v3's start stage)
    phase: Literal["coarse", "fine", "both", "demos", "start"]
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
    final_prompt_id: str = ""  # what the operator would hand over if it stopped now (OperatorConfig.final)
    rolled_back_to: str = ""  # the earlier version the incumbent returned to after this round (rollback_z)


@dataclass(eq=False)
class _Challenger:
    """A rejected option kept for more evidence. `screen`: its entry gate's inputs (it was kept because
    it looked good there, so they are not evidence); `pairs`: input id -> (incumbent, challenger)
    observations on later gates, against the current incumbent (cleared when the incumbent changes)."""
    prompt: str
    label: str
    card_ids: tuple
    screen: set
    screen_gain: float
    pairs: dict = field(default_factory=dict)
    evidence: float = 0.0


@dataclass
class _Outcome:
    summary: RoundSummary
    carry: list | None            # the new incumbent's observations on the gate, or None
    prompt: str | None = None     # the new incumbent when the round committed
    challenger: _Challenger | None = None  # set when a challenger won
    entrants: list = field(default_factory=list)  # rejected options that may join the challengers


@dataclass
class OperatorResult:
    initial_prompt: str
    prompt: str  # the incumbent
    rounds: list[RoundSummary] = field(default_factory=list)
    sessions: list[dict] = field(default_factory=list)
    stop_reason: str = "rounds_completed"
    final: str = ""  # the prompt handed over (OperatorConfig.final); updated every round
    style: StyleChoice | None = None  # the style used (OperatorConfig.style other than "fixed")


class Operator:
    def __init__(self, *, model: OptimizationModel, predict: Predict, evaluate: Evaluate,
                 config: EngineConfig | None = None, operator: OperatorConfig | None = None,
                 with_demos: WithDemos | None = None, budget_fraction: Callable[[], float] | None = None,
                 on_round: Callable[[str, RoundSummary], None] | None = None,
                 is_cancelled: CancelCheck | None = None, on_event: EventCallback | None = None,
                 stop_on: tuple = (), aggregate: Callable | None = None):
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
        self.aggregate = aggregate  # the task's set score (Session.aggregate); gates and screens use it

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
        self.result = result = OperatorResult(prompt, prompt, final=prompt)
        # Held-out observations per prompt (gate inputs only: a card's verification runs its own targets,
        # which would favour it) and the prompt texts, for OperatorConfig.final == "best_seen".
        seen: dict[str, dict] = {}
        self._texts = {prompt_id(prompt): prompt}
        self._initial_id = prompt_id(prompt)
        versions = [prompt_id(prompt)]  # every incumbent so far (the initial prompt and each accepted version)
        holdout: list = []               # inputs set aside for OperatorConfig.final == "holdout"
        holdout_scores: dict[str, tuple] = {}
        holdout_session = None
        coarse = s.schedule in ("coarse_to_fine", "coarse_only")  # coarse_to_fine's current phase
        stale = 0            # rounds in a row that committed nothing
        since_rewrite = 0    # rounds since a rewrite card was last proposed (compete)
        history, demos_done = [], s.demos_cap == 0
        kept_tail = ""  # the accepted worked-examples block; later rewrites keep it verbatim (Session.kept_tail)
        round_cost = 0.0  # the largest budget fraction one round has used (demos_stage "end")
        carried = None  # the incumbent's observations on the coming batch, from last round's gate
        stream = iter(batches)
        if s.style != "fixed":
            if s.style == "auto":
                # Judged on the third batch's inputs: under either style the first two may be set aside.
                peeked = []
                for _ in range(3):
                    more = next(stream, None)
                    if more is None:
                        break
                    peeked.append(list(more))
                stream = chain(peeked, stream)
                choice = suggest_style(self.callbacks["model"], prompt, peeked[-1] if peeked else [])
            else:
                choice = StyleChoice(s.style, s.style)
            self.settings = s = replace(s, **STYLE_SETTINGS[choice.style])
            result.style = choice
        for _ in range(s.holdout_batches):
            more = next(stream, None)
            if more is None:
                break
            holdout.extend(more)
        if holdout:  # held-out inputs never come back as a batch or gate input (schedules may repeat inputs)
            reserved = {e.id for e in holdout}
            holdout = list({e.id: e for e in holdout}.values())
            stream = (kept for kept in ([e for e in b if e.id not in reserved] for b in stream) if kept)
        ahead: list = []  # this round's batch and the batches its gate pools
        # Inputs whose observations selected the current incumbent (the gate of the round that
        # committed it). Predictions are reused per (prompt, input), so on these inputs the incumbent
        # keeps the lucky draws that made it win; later gates skip them to compare fairly.
        selected_on: set = set()
        pool: list[_Challenger] = []  # rejected options gathering more evidence (s.challengers > 0)
        gate_size = 0  # a full gate's input count (the evidence unit for challengers)

        def fill(size=None):
            while len(ahead) < (size if size is not None else 1 + s.gate_batches):
                more = next(stream, None)
                if more is None:
                    return
                ahead.append(list(more))

        def gate_inputs(batch):
            """The next gate_batches batches' worth of inputs (as many as those batches hold), in
            stream order, skipping this round's batch and the inputs that selected the incumbent;
            later batches are read ahead to make up for skipped ones."""
            target = sum(len(b) for b in ahead[:s.gate_batches])
            taken, chosen, position = {e.id for e in batch} | selected_on, [], 0
            while len(chosen) < target:
                if position >= len(ahead):
                    fill(len(ahead) + 1)
                    if position >= len(ahead):
                        break
                for example in ahead[position]:
                    if example.id not in taken and len(chosen) < target:
                        taken.add(example.id)
                        chosen.append(example)
                position += 1
            return chosen
        def score_holdout(text):
            nonlocal holdout_session
            if not holdout or prompt_id(text) in holdout_scores:
                return
            if holdout_session is None:
                holdout_session = Session(**self.callbacks, config=self.config, prompt=prompt, examples=holdout,
                                          is_cancelled=self.is_cancelled, on_event=self.on_event,
                                          stop_on=self.stop_on, aggregate=self.aggregate)
            self._texts[prompt_id(text)] = text
            run = holdout_session.run(text, [e.id for e in holdout])
            holdout_scores[prompt_id(text)] = (holdout_session.set_score(run.observations), len(run.observations))

        def start_stage(number):
            """Optimizer v3's start stage (OperatorConfig.start "induce"); returns the incumbent's observations on
            the coming batch (or None) and the inputs that selected it."""
            shown = ahead.pop(0)
            fill()
            scoring = []
            for _ in range(2):
                if ahead:
                    scoring.append(ahead.pop(0))
                    fill()
            used = {e.id for e in shown}
            stages = []
            for batch in scoring:
                fresh = list({e.id: e for e in batch if e.id not in used}.values())
                used |= {e.id for e in fresh}
                stages.append(fresh)
            first = stages[0] if stages else []
            second = stages[1] if len(stages) > 1 else []
            common = dict(**self.callbacks, config=replace(self.config, seed=self.config.seed * 1000003 + number),
                          is_cancelled=self.is_cancelled, on_event=self.on_event, stop_on=self.stop_on,
                          aggregate=self.aggregate)
            session = Session(**common, prompt=result.prompt,
                              examples=list({e.id: e for e in chain(shown, first, second)}.values()))
            upcoming = gate_inputs([]) if s.gate == "next" else []
            gate = Session(**common, prompt=result.prompt, examples=upcoming) if upcoming else None
            start_id, tried, cards = prompt_id(result.prompt), [], []
            committed, reason, gain, lost, accepted, carry = False, "", None, None, (), None
            try:
                cards = session.propose_instructions(s.start_candidates, s.start_demos, [e.id for e in shown])
                if not cards or not first:
                    reason = "no instruction could be written" if not cards else "no inputs to score the instructions on"
                else:
                    first_ids, second_ids = [e.id for e in first], [e.id for e in second]
                    base = list(session.run(result.prompt, first_ids).observations)
                    runs = {}
                    for card in cards:
                        if self.budget_fraction is not None and runs and self._spent() >= s.start_budget:
                            break
                        runs[card.id] = list(session.run(card.new_text, first_ids).observations)
                    stage1 = {id: session.set_score(obs) for id, obs in runs.items()}
                    finalists = sorted(stage1, key=lambda id: (-stage1[id], len(session.card(id).new_text), id))
                    finalists = finalists[:s.start_finalists]
                    if second_ids:
                        base += list(session.run(result.prompt, second_ids).observations)
                        for id in finalists:
                            runs[id] += list(session.run(session.card(id).new_text, second_ids).observations)
                    full = {id: session.set_score(runs[id]) for id in finalists}
                    base_score = session.set_score(base)
                    best = min(finalists, key=lambda id: (-full[id], len(session.card(id).new_text), id))
                    text = session.card(best).new_text
                    tried = [{"name": card.id, "first_score": stage1.get(card.id), "score": full.get(card.id),
                              "chars": len(card.new_text), "eligible": False} for card in cards]
                    tried.append({"name": "initial", "first_score": session.set_score(base[:len(first_ids)]),
                                  "score": base_score, "chars": len(result.prompt), "eligible": False})
                    if full[best] <= base_score:
                        reason = f"no written instruction beat the given prompt on {len(base)} scoring inputs"
                    elif gate is None:
                        committed, reason = True, f"best written instruction beat the given prompt on {len(base)} scoring inputs"
                    else:
                        baseline = gate.baseline()
                        run = gate.run(text, [e.id for e in gate.examples])
                        gain, lost, drop = _paired(gate, baseline, run)
                        eligible = drop <= s.max_batch_drop and gain >= s.min_gain
                        tried.append({"name": f"gate {best}", "gain": gain, "lost": lost, "drop": drop,
                                      "chars": len(text), "eligible": eligible})
                        if eligible:
                            committed, carry = True, list(run.observations)
                            reason = "best written instruction: no loss beyond the noise margin on the held-out next batch"
                        else:
                            reason = "best written instruction lost on the held-out next batch"
                    if committed:
                        session.accept(best)
                        accepted = (best,)
                        self._texts[prompt_id(text)] = text
                        result.prompt = text
            finally:
                snapshot = session.snapshot()
                if gate is not None:
                    snapshot["gate"] = {"examples": [e.id for e in gate.examples],
                                        "evaluations": [{"prompt_id": b.prompt_id, "score": b.score} for b in gate.evaluations]}
                result.sessions.append(snapshot)
            selected = set()
            if gate is not None:
                for evaluation in gate.evaluations:
                    known = seen.setdefault(evaluation.prompt_id, {})
                    for item in evaluation.observations:
                        known.setdefault(item.example_id, item)
                if carry is None and gate.evaluations:
                    carry = list(gate.baseline().observations)
                if committed:
                    selected = {e.id for e in gate.examples}
            if committed and prompt_id(result.prompt) not in versions:
                versions.append(prompt_id(result.prompt))
            if s.final == "holdout":
                score_holdout(result.prompt)
            result.final = self._final(result.prompt, seen, len(upcoming), holdout_scores)
            summary = RoundSummary(number, "start", start_id, prompt_id(result.prompt), committed, reason, len(cards),
                                   accepted, gain, lost, "induced" if committed else "", tuple(tried),
                                   "next" if gate is not None else "same", prompt_id(result.final))
            result.rounds.append(summary)
            if self.on_round is not None:
                self.on_round(result.prompt, summary)
            if carry is not None:  # reuse only an exact cover of the next round's batch
                wanted = {e.id for e in ahead[0]} if ahead else set()
                carry = [o for o in carry if o.example_id in wanted]
                if {o.example_id for o in carry} != wanted or not wanted:
                    carry = None
            return carry, selected, len(upcoming)

        fill()
        index = -1
        try:
            if s.final == "holdout":
                score_holdout(prompt)
            if s.start == "induce" and ahead and (max_rounds is None or max_rounds > 1):
                index += 1
                carried, selected_on, gate_size = start_stage(index)
            while ahead and (max_rounds is None or index + 1 < max_rounds):
                index += 1
                batch = ahead.pop(0)
                fill()
                upcoming = gate_inputs(batch) if s.gate == "next" else []
                gate_size = max(gate_size, len(upcoming))
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
                              is_cancelled=self.is_cancelled, on_event=self.on_event, stop_on=self.stop_on,
                              aggregate=self.aggregate, kept_tail=kept_tail)
                spent_at_start = self._spent()
                # The end stage starts when another normal round would cut into the reserve: the costliest
                # round so far predicts the next (one RoBBR round is 10-15% of its budget).
                if s.demos_stage == "end" and not demos_done and spent_at_start + round_cost >= 1 - s.demos_reserve:
                    self._demos_stage(result, common, index, batch, upcoming, history, gate_size)
                    break
                session = Session(**common, prompt=result.prompt, examples=batch, history=history,
                                  with_demos=self.with_demos, observations=carried)
                gate = None
                if s.gate == "next" and upcoming:
                    gate = Session(**common, prompt=result.prompt, examples=upcoming)
                carried = None
                try:
                    outcome = self._round(session, index, want_rewrite, want_local,
                                          demos_done or s.demos_stage == "end", gate,
                                          pool if gate is not None else [], gate_size)
                    summary, carried = outcome.summary, outcome.carry
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
                    result.prompt = outcome.prompt
                    if outcome.challenger is not None:  # selected by its accumulated evidence
                        selected_on = set(outcome.challenger.pairs) | outcome.challenger.screen
                        pool.remove(outcome.challenger)
                    else:
                        if gate is not None:
                            selected_on = {e.id for e in gate.examples}
                        for id in summary.accepted_card_ids:
                            card = session.card(id)
                            if card.kind == "demos":
                                demos_done = True
                                kept_tail = card.new_text[len(card.old_text):]
                    pool = [c for c in pool if c.prompt != result.prompt]
                    for challenger in pool:  # their evidence was against the replaced incumbent
                        challenger.pairs.clear()
                        challenger.evidence = 0.0
                else:
                    pool = self._keep_challengers(pool, outcome.entrants, gate_size)
                if gate is not None:
                    for evaluation in gate.evaluations:
                        known = seen.setdefault(evaluation.prompt_id, {})
                        for item in evaluation.observations:
                            known.setdefault(item.example_id, item)
                if summary.committed and prompt_id(result.prompt) not in versions:
                    versions.append(prompt_id(result.prompt))
                    self._texts[prompt_id(result.prompt)] = result.prompt
                back = self._rollback(prompt_id(result.prompt), versions, seen, gate_size)
                if back is not None:
                    result.prompt = self._texts[back]
                    carried, selected_on = None, set()  # its observations on the coming batch are unknown
                    pool = []
                    summary = replace(summary, rolled_back_to=back)
                if s.final == "holdout":
                    score_holdout(result.prompt)
                result.final = self._final(result.prompt, seen, gate_size, holdout_scores)
                summary = replace(summary, final_prompt_id=prompt_id(result.final))
                result.rounds.append(summary)
                round_cost = max(round_cost, self._spent() - spent_at_start)
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

    def _demos_stage(self, result: OperatorResult, common: dict, index: int, batch, upcoming, history,
                     gate_size: int) -> None:
        """OperatorConfig.demos_stage "end": one worked-examples round on the prompt the operator would hand
        over now; the last round of the run."""
        base = result.final or result.prompt
        session = Session(**common, prompt=base, examples=batch, history=history, with_demos=self.with_demos)
        gate = Session(**common, prompt=base, examples=upcoming) if self.settings.gate == "next" and upcoming else None
        try:
            outcome = self._round(session, index, False, False, False, gate, [], gate_size)
        finally:
            snapshot = session.snapshot()
            if gate is not None:
                snapshot["gate"] = {"examples": [e.id for e in gate.examples],
                                    "evaluations": [{"prompt_id": b.prompt_id, "score": b.score} for b in gate.evaluations]}
            result.sessions.append(snapshot)
        summary = replace(outcome.summary, phase="demos")
        if summary.committed:
            result.prompt = result.final = outcome.prompt
        else:
            result.prompt = base
        summary = replace(summary, final_prompt_id=prompt_id(result.final))
        result.rounds.append(summary)
        result.stop_reason = "demos stage done"
        if self.on_round is not None:
            self.on_round(result.prompt, summary)

    def _round(self, session: Session, index: int, want_rewrite: bool, want_local: bool,
               demos_done: bool, gate: Session | None = None, pool=(), gate_size: int = 0) -> _Outcome:
        """One round: this batch's options and the kept challengers are judged against the incumbent."""
        start = prompt_id(session.source)
        phase = "both" if want_rewrite and want_local else "coarse" if want_rewrite else "fine"
        judge = gate if gate is not None else session
        where = "the held-out next batch" if gate is not None else "the whole batch"

        def outcome(committed, reason, accepted=(), gain=None, lost=None, cards=0, chosen="", options=(),
                    carry=None, prompt=None, challenger=None, entrants=()):
            if carry is None and gate is not None and gate.evaluations:
                carry = gate.baseline().observations  # the unchanged incumbent on the coming batch
            end = prompt if prompt is not None else session.apply()
            summary = RoundSummary(index, phase, start, prompt_id(end), committed, reason, cards,
                                   tuple(accepted), gain, lost, chosen, tuple(options),
                                   "next" if gate is not None else "same")
            return _Outcome(summary, carry, end if committed else None, challenger, list(entrants))

        cards, passing = [], []
        if want_local:
            cards += session.analyze("local")
        if want_rewrite:
            cards += session.analyze("rewrite")
        if not demos_done:
            card = session.propose_demos(self.settings.demos_cap)
            if card is not None:
                cards.append(card)
        if session.issues:
            records = {card.id: session.verify(card.id) for card in cards}
            passing = [(card, records[card.id]) for card in cards if self._acceptable(records[card.id])]
            if self.settings.search_failed_cards:
                # At most one search per issue cluster, and none for a cluster that already has a passing
                # card: the failing alternative with the most progress is searched.
                covered = {card.cluster_id for card, _ in passing if card.cluster_id}
                picked: dict[str, tuple] = {}
                for card in cards:
                    record = records[card.id]
                    if self._acceptable(record) or not session.searchable(card.id) or card.cluster_id in covered:
                        continue
                    progress = _progress(session, record)
                    if self.settings.search_only_promising and progress[0] < self.settings.min_fix:
                        continue
                    key = card.cluster_id or card.id
                    if key not in picked or progress > picked[key][0]:
                        picked[key] = (progress, card)
                for _, card in sorted(picked.values(), key=lambda item: cards.index(item[1])):
                    searched = session.search(card.id)
                    if searched.optimized_card_id is not None:
                        optimized = session.card(searched.optimized_card_id)
                        record = session.latest_check(optimized.id)
                        if record is not None and self._acceptable(record):
                            passing.append((optimized, record))
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
        no_option = ("no failed inputs in this batch" if not session.issues
                     else "no card fixed a target without breaking a regression input")
        if not options and not pool:
            return outcome(False, no_option, cards=len(cards))

        baseline = judge.baseline()
        tried, runs, best = [], [], None
        for name, chosen in options:
            for card_id in list(session.applied):
                session.revert(card_id)
            for card in chosen:
                session.accept(card.id)
            candidate = session.apply()
            if candidate == session.source:
                continue
            self._texts[prompt_id(candidate)] = candidate
            run = judge.run(candidate, [e.id for e in judge.examples])
            gain, lost, drop = _paired(judge, baseline, run)
            within = abs(gain) < self.settings.min_gain
            eligible = drop <= self.settings.max_batch_drop and (
                gain >= self.settings.min_gain or (within and gain >= 0 and len(candidate) < len(session.source)))
            tried.append({"name": name, "gain": gain, "lost": lost, "drop": drop, "chars": len(candidate),
                          "eligible": eligible})
            runs.append((name, [card.id for card in chosen], candidate, gain, drop))
            if eligible and (best is None or (gain, -len(candidate)) > (best[2], -best[4])):
                best = (name, chosen, gain, lost, len(candidate), run.observations)
        for card_id in list(session.applied):
            session.revert(card_id)

        # Challengers: run on the same held-out inputs; their evidence accumulates across gates.
        ready = []
        for challenger in pool:
            run = judge.run(challenger.prompt, [e.id for e in judge.examples])
            gain, lost, drop = _paired(judge, baseline, run)
            evidence, items, evidence_drop = self._record_evidence(judge, challenger, baseline, run)
            scale = items / gate_size if gate_size else 0.0
            qualified = (gate_size > 0 and items >= gate_size
                         and evidence >= self.settings.min_gain * math.sqrt(scale)
                         and evidence_drop <= self.settings.max_batch_drop * scale)
            tried.append({"name": f"challenger {challenger.label}", "gain": gain, "lost": lost, "drop": drop,
                          "chars": len(challenger.prompt), "eligible": qualified,
                          "evidence_gain": evidence, "evidence_items": items})
            if qualified:
                ready.append((gain, challenger, lost, run.observations))

        top = max(ready, key=lambda item: (item[0], -len(item[1].prompt)), default=None)
        if top is not None and (best is None or (top[0], -len(top[1].prompt)) > (best[2], -best[4])):
            gain, challenger, lost, observations = top
            reason = (f"challenger {challenger.label}: accumulated gain {challenger.evidence:+.2f} over "
                      f"{len(challenger.pairs)} held-out inputs beyond the noise margin")
            return outcome(True, reason, challenger.card_ids, gain, lost, len(cards), f"challenger {challenger.label}",
                           tried, carry=observations if gate is not None else None, prompt=challenger.prompt,
                           challenger=challenger)
        if best is None:
            entrants = []
            if gate is not None and self.settings.challengers:
                ids = {e.id for e in judge.examples}
                entrants = [_Challenger(candidate, f"round {index} {name}", tuple(card_ids), set(ids), gain)
                            for name, card_ids, candidate, gain, drop in runs
                            if gain > 0 and drop <= self.settings.max_batch_drop]
            reason = f"no option beat the incumbent on {where}" if options else no_option
            return outcome(False, reason, cards=len(cards), options=tried, entrants=entrants)
        name, chosen, gain, lost, _, observations = best
        for card in chosen:
            session.accept(card.id)
        # A combined option's card whose text an earlier card changed was skipped: it is not part of
        # the committed prompt, so it is reverted and not recorded as accepted (traceability).
        for card_id in list(session.inactive):
            session.revert(card_id)
        chosen = [card for card in chosen if card.id in session.applied]
        if self.settings.min_gain <= 0:
            reason = "no loss beyond the noise margin"
        else:
            reason = "gain beyond the noise margin" if gain >= self.settings.min_gain else "equal within the noise margin and shorter"
        return outcome(True, f"{reason} on {where}", [c.id for c in chosen], gain, lost, len(cards), name, tried,
                       carry=observations if gate is not None else None, prompt=session.apply())

    def _rollback(self, incumbent: str, versions: list, seen: dict, gate_size: int) -> str | None:
        """An earlier accepted version whose mean item score on held-out gate inputs beats the incumbent's
        by rollback_z standard errors (both on a full gate's worth), else None. Mean item scores (not the
        set score) so that the standard error is defined."""
        if not self.settings.rollback_z or not gate_size:
            return None

        def stats(id):
            scores = [item.evaluation.score for item in seen.get(id, {}).values()]
            if len(scores) < max(2, gate_size):
                return None
            mean = sum(scores) / len(scores)
            return mean, sum((x - mean) ** 2 for x in scores) / (len(scores) - 1) / len(scores)
        current = stats(incumbent)
        if current is None:
            return None
        best = None
        for id in versions:
            other = stats(id) if id != incumbent else None
            if other is None or other[0] <= current[0]:
                continue
            spread = math.sqrt(other[1] + current[1])
            z = (other[0] - current[0]) / spread if spread > 0 else math.inf
            if z >= self.settings.rollback_z and (best is None or other[0] > best[1]):
                best = (id, other[0])
        return best[0] if best is not None else None

    def _final(self, incumbent: str, seen: dict, gate_size: int, holdout_scores: dict | None = None) -> str:
        """The prompt to hand over: the incumbent ("last"); the best set score on held-out inputs among
        prompts run on at least a full gate's worth of them ("best_seen"; shorter on ties); or the
        shortest accepted version within final_margin of the best holdout score ("holdout"; with
        final_excludes_initial, the initial prompt drops out once another version has a holdout score)."""
        if self.settings.final == "holdout":
            scores = dict(holdout_scores or {})
            if self.settings.final_excludes_initial and any(id != self._initial_id for id in scores):
                scores.pop(self._initial_id, None)
            scored = [(self._texts[id], score, n) for id, (score, n) in scores.items()]
            if not scored:
                return incumbent
            top = max(score for _, score, _ in scored)
            near = [text for text, score, n in scored if n * (top - score) <= self.settings.final_margin + 1e-9]
            return min(near, key=lambda text: (len(text), text))
        if self.settings.final == "last" or not gate_size:
            return incumbent
        best = None
        for id, observations in seen.items():
            text = self._texts.get(id)
            if text is None or len(observations) < gate_size:
                continue
            items = tuple(observations.values())
            if self.aggregate is not None:
                score = float(check.invoke(self.aggregate, items, name="aggregate"))
            else:
                score = sum(item.evaluation.score for item in items) / len(items)
            if best is None or (score, -len(text)) > (best[0], -len(best[1])):
                best = (score, text)
        return best[1] if best is not None else incumbent

    def _record_evidence(self, judge: Session, challenger: _Challenger, baseline, run):
        """Adds this gate's (incumbent, challenger) pairs outside the challenger's entry gate; returns
        the accumulated net gain (set score, item units), the number of inputs and the summed drop."""
        old = {item.example_id: item for item in baseline.observations}
        for item in run.observations:
            if item.example_id not in challenger.screen:
                challenger.pairs[item.example_id] = (old[item.example_id], item)
        pairs = list(challenger.pairs.values())
        challenger.evidence = judge.set_gain([a for a, _ in pairs], [b for _, b in pairs]) if pairs else 0.0
        drop = sum(max(0.0, a.evaluation.score - b.evaluation.score) for a, b in pairs)
        return challenger.evidence, len(pairs), drop

    def _keep_challengers(self, pool, entrants, gate_size):
        """After a round that kept the incumbent: drop challengers behind on a full gate's worth of
        fresh inputs or undecided after challenger_max_gates gates' worth, add the round's rejected
        options that gained, and keep the `challengers` best by evidence per sqrt(gate)."""
        s = self.settings
        if not s.challengers or not gate_size:
            return []
        kept = [c for c in pool if not (len(c.pairs) >= gate_size and c.evidence < 0)
                and len(c.pairs) < s.challenger_max_gates * gate_size]
        known = {c.prompt for c in kept}
        for entrant in entrants:
            if entrant.prompt not in known:
                known.add(entrant.prompt)
                kept.append(entrant)

        def strength(c):
            if c.pairs:
                return c.evidence / math.sqrt(len(c.pairs) / gate_size)
            return c.screen_gain / math.sqrt(max(1, len(c.screen)) / gate_size)
        return sorted(kept, key=strength, reverse=True)[:s.challengers]

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
    """On the same inputs: the score change in item units (set size x change of the task's set score;
    the summed item-score change when the task has no aggregate), inputs that passed before and fail
    after, and the summed item-score drop (decreases only)."""
    old = {item.example_id: item for item in before.observations}
    gain = session.set_gain([old[item.example_id] for item in after.observations], after.observations)
    lost = sum(1 for item in after.observations
               if session.passed(old[item.example_id]) and not session.passed(item))
    drop = sum(max(0.0, old[item.example_id].evaluation.score - item.evaluation.score) for item in after.observations)
    return gain, lost, drop
