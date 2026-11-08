"""Records for the original, user-controlled review/verification/search workflow."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from typing import Literal

from . import validation as check
from .errors import ValidationError

from .types import (
    Evaluation, EvaluationBatch, Example, Issue, IssueCluster, ModelCall, ModelRequest,
    Notice, Observation, PromptEdit, RunStats, SearchSpace,
)


@dataclass(frozen=True, slots=True)
class ReviewConfig:
    max_failed_examples: int = 20
    cluster_threshold: int = 5
    max_model_calls: int = 100
    max_predictions: int = 1000
    pass_threshold: float = 1.0
    seed: int = 42

    def __post_init__(self):
        from .types import OptimizerConfig
        try:
            OptimizerConfig(max_failed_examples=self.max_failed_examples, cluster_threshold=self.cluster_threshold,
                max_model_calls=self.max_model_calls, max_predictions=self.max_predictions,
                pass_threshold=self.pass_threshold, seed=self.seed)
        except ValidationError as exc:
            raise exc.at((exc.path or "OptimizerConfig").replace("OptimizerConfig", "ReviewConfig", 1)) from exc
        object.__setattr__(self, "max_failed_examples", min(200, self.max_failed_examples))


@dataclass(frozen=True, slots=True)
class ReviewSearchConfig:
    """Original defaults; enhancements are explicit opt-ins, not replacements."""
    max_trials: int = 40  # Search trials, independent of initial Verify (JS clamps to 4..200).
    max_segments: int = 5
    candidates_per_segment: int = 4  # Number of alternatives; original can add one extra candidate.
    regression_examples: int = 2
    validation_scope: Literal["target_plus_regression", "all"] = "target_plus_regression"
    reward: Literal["pass_rate", "score"] = "pass_rate"
    text_handling: Literal["original", "exact"] = "original"
    deduplicate: bool = False
    warm_start: bool = False
    cache_evaluations: bool = False
    penalize_regression: bool = False
    continue_on_error: bool = True

    def __post_init__(self):
        for name in ("max_trials", "max_segments", "candidates_per_segment"):
            check.integer(getattr(self, name), f"ReviewSearchConfig.{name}", minimum=1)
        check.integer(self.regression_examples, "ReviewSearchConfig.regression_examples")
        for name, choices in (("validation_scope", ("target_plus_regression", "all")),
                              ("reward", ("pass_rate", "score")), ("text_handling", ("original", "exact"))):
            check.choice(getattr(self, name), choices, f"ReviewSearchConfig.{name}")
        for name in ("deduplicate", "warm_start", "cache_evaluations", "penalize_regression", "continue_on_error"):
            check.boolean(getattr(self, name), f"ReviewSearchConfig.{name}")
        object.__setattr__(self, "max_trials", min(200, max(4, self.max_trials)))
        object.__setattr__(self, "max_segments", min(8, max(2, self.max_segments)))
        object.__setattr__(self, "candidates_per_segment", min(8, max(2, self.candidates_per_segment)))


@dataclass(frozen=True, slots=True)
class ReviewSuggestion:
    id: str
    edit: PromptEdit
    cluster_id: str | None = None
    optimized_from_id: str | None = None


@dataclass(frozen=True, slots=True)
class Verification:
    id: str
    suggestion_id: str
    kind: Literal["verify", "search"]
    prompt_id: str
    example_ids: tuple[str, ...]
    evaluation_id: str | None
    matched_count: int
    total_count: int
    pass_rate: float
    full_pass: bool
    status: Literal["complete", "error"]
    error: str | None = None


@dataclass(frozen=True, slots=True)
class SearchTrial:
    index: int
    picks: tuple[int, ...]
    text: str
    verification_id: str
    pass_rate: float | None
    reward: float
    ok: bool
    alpha: tuple[tuple[float, ...], ...]
    beta: tuple[tuple[float, ...], ...]
    error: str | None = None


@dataclass(frozen=True, slots=True)
class ReviewSearchResult:
    id: str
    source_suggestion_id: str
    config: ReviewSearchConfig
    example_ids: tuple[str, ...]
    regression_example_ids: tuple[str, ...]
    space: SearchSpace | None
    trials: tuple[SearchTrial, ...]
    best_text: str
    best_rate: float | None
    best_picks: tuple[int, ...]
    optimized_suggestion_id: str | None
    status: Literal["complete", "failed", "budget_exhausted", "cancelled"]


@dataclass(frozen=True, slots=True)
class ReviewDecision:
    suggestion_id: str
    action: Literal["accept", "revert", "reject"]
    prompt_before: str
    prompt_after: str


@dataclass(frozen=True, slots=True)
class ReviewResult:
    original_prompt: str
    prompt: str
    config: ReviewConfig
    examples: tuple[Example, ...]
    baseline_id: str | None
    suggestions: tuple[ReviewSuggestion, ...]
    issues: tuple[Issue, ...]
    clusters: tuple[IssueCluster, ...]
    evaluations: tuple[EvaluationBatch, ...]
    verifications: tuple[Verification, ...]
    searches: tuple[ReviewSearchResult, ...]
    decisions: tuple[ReviewDecision, ...]
    applied_ids: tuple[str, ...]
    model_calls: tuple[ModelCall, ...]
    notices: tuple[Notice, ...]
    stats: RunStats

    def to_json(self, *, indent: int | None = 2) -> str:
        from .serialization import dump_result
        return dump_result(self, "annobio.review", indent)

    def to_dict(self) -> dict:
        return json.loads(self.to_json())

    @classmethod
    def from_json(cls, text: str) -> ReviewResult:
        from .serialization import parse_json
        return cls.from_dict(parse_json(text, "ReviewResult.from_json.text"))

    @classmethod
    def from_dict(cls, data: dict) -> ReviewResult:
        from .serialization import load_result
        return load_result(cls, data, "annobio.review")
