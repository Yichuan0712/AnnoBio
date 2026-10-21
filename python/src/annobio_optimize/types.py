"""Public records. IDs identify examples; offsets identify edits in one exact prompt."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import json
import math
from typing import Any, Callable, Literal, Protocol, Union

from . import validation as check
from .errors import InputTypeError, InputValueError, ValidationError

JSONValue = Union[None, bool, int, float, str, list["JSONValue"], dict[str, "JSONValue"]]
Stage = Literal["diagnose", "cluster", "propose", "segment", "paraphrase"]


def copy_json(value: Any, path: str = "value") -> JSONValue:
    """Reject unsupported objects/non-finite numbers instead of silently stringifying them."""
    return check.json_copy(value, path)


def prompt_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _unit_score(value: Any, name: str = "score") -> float:
    return check.unit_score(value, name)


@dataclass(frozen=True, slots=True)
class Example:
    id: str
    inputs: JSONValue
    reference: JSONValue = None
    weight: float = 1.0
    metadata: dict[str, JSONValue] = field(default_factory=dict)

    def __post_init__(self):
        check.string(self.id, "Example.id", nonempty=True)
        check.finite_number(self.weight, "Example.weight")
        if self.weight <= 0:
            raise InputValueError("must be positive.", path="Example.weight")
        if not isinstance(self.metadata, dict):
            raise InputTypeError("must be a JSON object.", path="Example.metadata")
        for name in ("inputs", "reference", "metadata"):
            object.__setattr__(self, name, copy_json(getattr(self, name), f"Example.{name}"))


@dataclass(frozen=True, slots=True)
class Evaluation:
    """Higher is better. `passed=None` uses the optimizer's pass_threshold."""
    score: float
    feedback: str = ""
    passed: bool | None = None
    metrics: dict[str, float] = field(default_factory=dict)
    details: JSONValue = None
    matched_count: int | None = None
    total_count: int | None = None
    error: str | None = None

    def __post_init__(self):
        object.__setattr__(self, "score", _unit_score(self.score, "Evaluation.score"))
        check.string(self.feedback, "Evaluation.feedback")
        if self.passed is not None:
            check.boolean(self.passed, "Evaluation.passed")
        if not isinstance(self.metrics, dict):
            raise InputTypeError("must map metric names to finite numbers.", path="Evaluation.metrics")
        for name, value in self.metrics.items():
            check.string(name, "Evaluation.metrics key")
            check.finite_number(value, check.child_path("Evaluation.metrics", name))
        object.__setattr__(self, "metrics", dict(self.metrics))
        object.__setattr__(self, "details", copy_json(self.details, "Evaluation.details"))
        if (self.matched_count is None) != (self.total_count is None):
            raise InputValueError("matched_count and total_count must be supplied together.", path="Evaluation")
        if self.total_count is not None:
            check.integer(self.total_count, "Evaluation.total_count")
            check.integer(self.matched_count, "Evaluation.matched_count")
            if self.matched_count > self.total_count:
                raise InputValueError("cannot exceed total_count.", path="Evaluation.matched_count")
        if self.error is not None:
            check.string(self.error, "Evaluation.error")


class Predict(Protocol):
    def __call__(self, prompt: str, inputs: JSONValue) -> JSONValue: ...


class Evaluate(Protocol):
    def __call__(self, example: Example, prediction: JSONValue) -> Evaluation | float: ...


@dataclass(frozen=True, slots=True)
class ModelRequest:
    stage: Stage
    instruction: str
    payload: dict[str, JSONValue]
    response_schema: dict[str, JSONValue]

    def __post_init__(self):
        check.choice(self.stage, ("diagnose", "cluster", "propose", "segment", "paraphrase"), "ModelRequest.stage")
        check.string(self.instruction, "ModelRequest.instruction", nonempty=True)
        for name in ("payload", "response_schema"):
            value = getattr(self, name)
            if not isinstance(value, dict):
                raise InputTypeError("must be a JSON object.", path=f"ModelRequest.{name}")
            object.__setattr__(self, name, copy_json(value, f"ModelRequest.{name}"))

    def to_dict(self) -> dict:
        return asdict(self)


class OptimizationModel(Protocol):
    """Provider adapter: return a JSON object or a string containing that object."""
    def __call__(self, request: ModelRequest) -> dict[str, JSONValue] | str: ...


@dataclass(frozen=True, slots=True)
class OptimizerConfig:
    max_rounds: int = 3
    max_failed_examples: int = 20
    cluster_threshold: int = 5
    max_trials: int = 20  # Per cluster, INCLUDING its initial proposed edit.
    max_segments: int = 5
    candidates_per_segment: int = 4  # Includes the original segment.
    max_model_calls: int = 100
    max_predictions: int = 1000
    pass_threshold: float = 1.0
    min_improvement: float = 0.0
    max_score_drop: float = 0.0  # Allowed drop per example, relative to the parent prompt.
    seed: int = 42
    cache_evaluations: bool = True

    def __post_init__(self):
        for name in ("max_rounds", "max_failed_examples", "max_trials", "max_segments",
                     "candidates_per_segment", "max_predictions"):
            check.integer(getattr(self, name), f"OptimizerConfig.{name}", minimum=1)
        for name in ("cluster_threshold", "max_model_calls"):
            check.integer(getattr(self, name), f"OptimizerConfig.{name}")
        for name in ("pass_threshold", "min_improvement", "max_score_drop"):
            _unit_score(getattr(self, name), f"OptimizerConfig.{name}")
        if type(self.seed) is not int:
            raise InputTypeError("must be an integer.", path="OptimizerConfig.seed")
        check.boolean(self.cache_evaluations, "OptimizerConfig.cache_evaluations")


@dataclass(frozen=True, slots=True)
class Observation:
    example_id: str
    prediction: JSONValue
    evaluation: Evaluation

    def __post_init__(self):
        check.string(self.example_id, "Observation.example_id", nonempty=True)
        object.__setattr__(self, "prediction", copy_json(self.prediction, "Observation.prediction"))
        check.instance(self.evaluation, Evaluation, "Observation.evaluation")
        try:
            value = Evaluation(**{name: getattr(self.evaluation, name) for name in self.evaluation.__dataclass_fields__})
        except ValidationError as exc:
            raise exc.at("Observation.evaluation" + (exc.path or "").removeprefix("Evaluation")) from exc
        object.__setattr__(self, "evaluation", value)


@dataclass(frozen=True, slots=True)
class EvaluationBatch:
    id: str
    prompt_id: str
    observations: tuple[Observation, ...]
    score: float


@dataclass(frozen=True, slots=True)
class Issue:
    id: str
    example_id: str
    evaluation_id: str
    summary: str
    advice: str
    category: str = ""
    reference_note: str = ""
    title: str = ""


@dataclass(frozen=True, slots=True)
class IssueCluster:
    id: str
    issue_ids: tuple[str, ...]
    example_ids: tuple[str, ...]
    label: str = ""


@dataclass(frozen=True, slots=True)
class PromptEdit:
    id: str
    base_prompt_id: str
    start: int
    end: int
    old_text: str
    new_text: str
    rationale: str
    target_example_ids: tuple[str, ...]
    issue_ids: tuple[str, ...]
    name: str = "Prompt edit"
    addresses: tuple[str, ...] = ()

    def __post_init__(self):
        for name in ("id", "base_prompt_id", "old_text"):
            check.string(getattr(self, name), f"PromptEdit.{name}", nonempty=True)
        for name in ("new_text", "rationale", "name"):
            check.string(getattr(self, name), f"PromptEdit.{name}")
        check.integer(self.start, "PromptEdit.start")
        check.integer(self.end, "PromptEdit.end", minimum=1)
        if self.end <= self.start or self.end - self.start != len(self.old_text):
            raise InputValueError("end - start must equal len(old_text), using Python character offsets.", path="PromptEdit.end")
        for name in ("target_example_ids", "issue_ids", "addresses"):
            object.__setattr__(self, name, check.string_tuple(getattr(self, name), f"PromptEdit.{name}",
                                                            unique=name != "addresses"))

    @classmethod
    def from_text(cls, *, id: str, prompt: str, old_text: str, new_text: str,
                  rationale: str = "", target_example_ids: tuple[str, ...] = (),
                  issue_ids: tuple[str, ...] = ()) -> PromptEdit:
        check.string(prompt, "PromptEdit.from_text.prompt", nonempty=True)
        check.string(old_text, "PromptEdit.from_text.old_text", nonempty=True)
        check.string(new_text, "PromptEdit.from_text.new_text")
        target_example_ids = check.string_tuple(target_example_ids, "PromptEdit.target_example_ids")
        issue_ids = check.string_tuple(issue_ids, "PromptEdit.issue_ids")
        start = prompt.find(old_text)
        if start < 0 or prompt.find(old_text, start + 1) >= 0:
            raise InputValueError("old_text must occur exactly once; include context to disambiguate.",
                                  path="PromptEdit.from_text.old_text")
        return cls(id, prompt_id(prompt), start, start + len(old_text), old_text,
                   new_text, rationale, tuple(target_example_ids), tuple(issue_ids))

    def apply(self, prompt: str) -> str:
        check.string(prompt, "PromptEdit.apply.prompt")
        if (prompt_id(prompt) != self.base_prompt_id or not 0 <= self.start < self.end <= len(prompt)
                or prompt[self.start:self.end] != self.old_text):
            raise InputValueError("edit does not belong to this exact prompt version.", path="PromptEdit.apply.prompt",
                                  hint="Apply it to the original prompt used to construct the edit.")
        return prompt[:self.start] + self.new_text + prompt[self.end:]


@dataclass(frozen=True, slots=True)
class Trial:
    id: str
    round_index: int
    cluster_id: str
    edit: PromptEdit
    source: Literal["proposal", "search"]
    picks: tuple[int, ...]
    evaluation_id: str
    target_gain: float
    total_gain: float
    regressed_example_ids: tuple[str, ...]
    eligible: bool
    rejection_reason: str = ""


@dataclass(frozen=True, slots=True)
class SearchSpace:
    cluster_id: str
    proposal_edit_id: str
    segments: tuple[str, ...]
    candidates: tuple[tuple[str, ...], ...]


@dataclass(frozen=True, slots=True)
class PromptVersion:
    id: str
    text: str
    parent_id: str | None
    accepted_trial_id: str | None
    evaluation_id: str


@dataclass(frozen=True, slots=True)
class RoundRecord:
    index: int
    start_prompt_id: str
    end_prompt_id: str
    issue_ids: tuple[str, ...]
    cluster_ids: tuple[str, ...]
    accepted_trial_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ModelCall:
    id: str
    request: ModelRequest
    response: JSONValue


@dataclass(frozen=True, slots=True)
class Notice:
    stage: str
    message: str
    cluster_id: str | None = None


@dataclass(frozen=True, slots=True)
class RunStats:
    model_calls: int = 0
    prediction_calls: int = 0
    evaluation_calls: int = 0
    cache_hits: int = 0


@dataclass(frozen=True, slots=True)
class ProgressEvent:
    stage: str
    message: str
    round_index: int
    trial_id: str | None = None


@dataclass(frozen=True, slots=True)
class OptimizationResult:
    initial_prompt: str
    prompt: str
    config: OptimizerConfig
    examples: tuple[Example, ...]
    versions: tuple[PromptVersion, ...]
    evaluations: tuple[EvaluationBatch, ...]
    issues: tuple[Issue, ...]
    clusters: tuple[IssueCluster, ...]
    trials: tuple[Trial, ...]
    search_spaces: tuple[SearchSpace, ...]
    rounds: tuple[RoundRecord, ...]
    model_calls: tuple[ModelCall, ...]
    notices: tuple[Notice, ...]
    stats: RunStats
    stop_reason: Literal["perfect", "converged", "max_rounds", "budget_exhausted", "cancelled"]

    @property
    def initial_score(self) -> float | None:
        return self.evaluations[0].score if self.evaluations else None

    @property
    def score(self) -> float | None:
        if not self.versions:
            return None
        evaluation_id = self.versions[-1].evaluation_id
        return next(batch.score for batch in self.evaluations if batch.id == evaluation_id)

    @property
    def accepted_edits(self) -> tuple[PromptEdit, ...]:
        trials = {trial.id: trial for trial in self.trials}
        return tuple(trials[version.accepted_trial_id].edit for version in self.versions[1:])

    def to_dict(self) -> dict:
        # JSON conversion also turns tuple containers into portable arrays.
        return json.loads(self.to_json())

    def to_json(self, *, indent: int | None = 2) -> str:
        from .serialization import dump_result
        return dump_result(self, "annobio.optimization", indent)

    @classmethod
    def from_json(cls, text: str) -> OptimizationResult:
        from .serialization import parse_json
        return cls.from_dict(parse_json(text, "OptimizationResult.from_json.text"))

    @classmethod
    def from_dict(cls, data: dict) -> OptimizationResult:
        from .serialization import load_result
        return load_result(cls, data, "annobio.optimization")



CancelCheck = Callable[[], bool]
EventCallback = Callable[[ProgressEvent], None]
