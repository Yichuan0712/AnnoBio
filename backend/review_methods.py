"""
Registry of pluggable review methods.

Each method drives the Review job the same way `review_pipeline.run_review_pipeline`
always has: given the request body and a way to emit events, it produces one or more
`{"type": "suggestions", "suggestions": [...]}` events (PromptEditSuggestion-shaped
dicts) and finishes with `{"type": "done"}`. Everything downstream of the Review job
(suggestion accept/revert, prompt-edit application) only depends on that converged
shape, so a method's own intermediate steps are free to differ.

The existing algorithm (Phase 1 issue analysis -> Phase 2 suggested changes) is
registered here unchanged, as the default method. A new method is a function with
the same call signature, emitting `{"type": "stage", "stage_id": ..., "kind": ...,
"payload": ...}` for its own steps, registered below — no other file needs to change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from review_pipeline import run_review_pipeline

ReviewMethodRunFn = Callable[..., None]


@dataclass(frozen=True)
class ReviewMethodStage:
    id: str
    label: str


@dataclass(frozen=True)
class ReviewMethodSpec:
    id: str
    label: str
    stages: list[ReviewMethodStage]
    run: ReviewMethodRunFn

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "stages": [{"id": s.id, "label": s.label} for s in self.stages],
        }


DEFAULT_REVIEW_METHOD_ID = "issue_analysis_suggestions"

REGISTRY: dict[str, ReviewMethodSpec] = {
    DEFAULT_REVIEW_METHOD_ID: ReviewMethodSpec(
        id=DEFAULT_REVIEW_METHOD_ID,
        label="Issue analysis + Suggested changes",
        stages=[
            ReviewMethodStage(id="analysis", label="Issue analysis"),
            ReviewMethodStage(id="suggestions", label="Suggested changes"),
        ],
        run=run_review_pipeline,
    ),
}


def get_review_method(method_id: str | None) -> ReviewMethodSpec:
    return REGISTRY.get(method_id or DEFAULT_REVIEW_METHOD_ID, REGISTRY[DEFAULT_REVIEW_METHOD_ID])


def list_review_methods() -> list[dict[str, Any]]:
    return [spec.to_dict() for spec in REGISTRY.values()]
