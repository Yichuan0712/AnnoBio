"""Configuration and records of the v2 engine (ENGINE_V2_DESIGN.md sections 3-6).

Every record is a frozen dataclass of JSON values, so a whole session can be written out with
dataclasses.asdict and read back by the app, the experiment runner and the H1 console alike.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .. import validation as check
from ..errors import InputValueError
from ..types import prompt_id

CardKind = Literal["replace", "insert", "rewrite", "demos"]
Mode = Literal["local", "rewrite"]


@dataclass(frozen=True, slots=True)
class EngineConfig:
    """Session settings. The first five mirror the app (two of them are user settings there:
    max_failed_examples "Max failed inputs per Optimize" = 30 and max_trials "Max trials per
    optimization run" = 40); the rest are engine parameters that the development pilot sets."""
    max_failed_examples: int = 30
    cluster_threshold: int = 5
    max_cards: int = 64
    max_trials: int = 40
    max_segments: int = 5
    candidates_per_segment: int = 4
    # Inputs outside a card's targets that every verification and search trial also runs (design 6:
    # regression guard): those with the highest baseline score (passing ones first), ties drawn per session.
    regression_examples: int = 4
    # Search reward = mean target score - regression_penalty * (regression drop / regression inputs), in [0, 1].
    regression_penalty: float = 1.0
    history_items: int = 20
    # Full inputs/outputs attached to one propose/rewrite request; the other inputs it addresses are
    # represented by their diagnosis cards only (a long-document task would otherwise overflow the context).
    max_evidence_examples: int = 3
    # Different-direction localized edits the model proposes per issue cluster (1 = the app's behavior).
    proposals_per_cluster: int = 1
    pass_threshold: float = 1.0
    max_model_calls: int | None = None
    max_predictions: int | None = None
    seed: int = 42

    def __post_init__(self):
        for name in ("max_failed_examples", "cluster_threshold", "max_cards", "max_trials", "max_segments",
                     "candidates_per_segment", "regression_examples", "history_items", "max_evidence_examples"):
            check.integer(getattr(self, name), f"EngineConfig.{name}", minimum=0)
        check.integer(self.proposals_per_cluster, "EngineConfig.proposals_per_cluster", minimum=1)
        for name in ("max_failed_examples", "max_cards", "max_trials", "max_segments", "candidates_per_segment"):
            if getattr(self, name) < 1:
                raise InputValueError("must be at least 1.", path=f"EngineConfig.{name}")
        check.finite_number(self.regression_penalty, "EngineConfig.regression_penalty")
        if self.regression_penalty < 0:
            raise InputValueError("must be non-negative.", path="EngineConfig.regression_penalty")
        check.unit_score(self.pass_threshold, "EngineConfig.pass_threshold")
        for name in ("max_model_calls", "max_predictions"):
            if getattr(self, name) is not None:
                check.integer(getattr(self, name), f"EngineConfig.{name}", minimum=1)
        if type(self.seed) is not int:
            raise InputValueError("must be an integer.", path="EngineConfig.seed")


@dataclass(frozen=True, slots=True)
class Card:
    """One suggestion card. Every kind is an old -> new text edit of the session's source prompt,
    which is all the app's card UI shows (old_sentence / new_sentence):
    replace: a unique sentence -> its replacement (empty = deletion);
    insert:  an anchor sentence -> the anchor followed by new text;
    rewrite: the whole prompt -> a rewritten prompt;
    demos:   the prompt's closing line -> that line followed by a worked-examples block."""
    id: str
    kind: CardKind
    title: str
    rationale: str
    base_prompt_id: str
    start: int
    end: int
    old_text: str
    new_text: str
    target_example_ids: tuple[str, ...]
    issue_ids: tuple[str, ...] = ()
    addresses: tuple[str, ...] = ()
    cluster_id: str | None = None
    cluster_label: str = ""
    optimized_from: str | None = None
    demo_example_ids: tuple[str, ...] = ()

    def apply(self, prompt: str) -> str:
        if prompt_id(prompt) != self.base_prompt_id or prompt[self.start:self.end] != self.old_text:
            raise InputValueError("card does not belong to this exact prompt.", path="Card.apply.prompt")
        return prompt[:self.start] + self.new_text + prompt[self.end:]


@dataclass(frozen=True, slots=True)
class Check:
    """One Verify (or one search trial): the card's prompt on its targets plus the regression inputs.
    matched/total count comparison rows like the app's pass rate; the id lists are per input."""
    id: str
    card_id: str
    kind: Literal["verify", "search"]
    prompt_id: str
    target_ids: tuple[str, ...]
    regression_ids: tuple[str, ...]
    fixed_ids: tuple[str, ...]
    lost_ids: tuple[str, ...]
    matched_count: int
    total_count: int
    target_rate: float
    full_pass: bool
    status: Literal["complete", "error"]
    error: str | None = None
    # Score-based outcome, which also works for partial-credit tasks (e.g. per-document F1), where an
    # input rarely becomes fully correct and a fully correct one often is not on a rerun:
    target_gain: float = 0.0       # sum over targets of (score now - score at baseline)
    target_score: float = 0.0      # mean target score now
    regression_drop: float = 0.0   # sum over regression inputs of max(0, baseline score - score now)


@dataclass(frozen=True, slots=True)
class SearchTrialRecord:
    index: int
    picks: tuple[int, ...]
    text: str
    check_id: str | None
    reward: float
    ok: bool


@dataclass(frozen=True, slots=True)
class SearchRecord:
    id: str
    card_id: str
    segments: tuple[str, ...]
    candidates: tuple[tuple[str, ...], ...]
    trials: tuple[SearchTrialRecord, ...]
    best_text: str
    best_reward: float | None
    optimized_card_id: str | None
    status: Literal["complete", "failed", "budget_exhausted", "cancelled"]


@dataclass(frozen=True, slots=True)
class Decision:
    card_id: str
    action: Literal["accept", "revert"]
    prompt_before_id: str
    prompt_after_id: str


@dataclass(frozen=True, slots=True)
class HistoryItem:
    """What a later proposal sees of an earlier attempt (design 8; OPRO-style history)."""
    kind: str
    title: str
    rationale: str
    old_text: str
    new_text: str
    targets: int
    fixed: int
    regression_inputs: int
    lost: int
    accepted: bool
