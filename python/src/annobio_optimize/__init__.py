"""Error-guided local prompt optimization with user-supplied task callbacks."""
from .model import ModelResponseError
from .errors import (
    AnnoBioError, ValidationError, InputTypeError, InputValueError, CallbackContractError, UnknownSuggestionError,
)
from .optimizer import Optimizer
from .review import ReviewSession, ReviewStopped
from .review_types import (
    ReviewConfig, ReviewDecision, ReviewResult, ReviewSearchConfig, ReviewSearchResult,
    ReviewSuggestion, SearchTrial, Verification,
)
from .types import (
    Evaluate, Evaluation, EvaluationBatch, Example, Issue, IssueCluster, JSONValue,
    ModelCall, ModelRequest, Notice, Observation, OptimizationModel, OptimizationResult,
    OptimizerConfig, Predict, ProgressEvent, PromptEdit, PromptVersion, RoundRecord,
    RunStats, SearchSpace, Trial,
)

__version__ = "0.1.0"
__all__ = [
    "Optimizer", "OptimizerConfig", "Example", "Evaluation", "OptimizationResult",
    "Predict", "Evaluate", "OptimizationModel", "ModelRequest", "ModelResponseError",
    "JSONValue", "Observation", "EvaluationBatch", "Issue", "IssueCluster", "PromptEdit",
    "Trial", "SearchSpace", "PromptVersion", "RoundRecord", "ModelCall", "Notice",
    "RunStats", "ProgressEvent", "ReviewSession", "ReviewStopped", "ReviewConfig", "ReviewSearchConfig",
    "ReviewSuggestion", "Verification", "SearchTrial", "ReviewSearchResult", "ReviewDecision", "ReviewResult",
    "AnnoBioError", "ValidationError", "InputTypeError", "InputValueError", "CallbackContractError", "UnknownSuggestionError",
]
