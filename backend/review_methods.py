"""
Registry of pluggable review methods.

Each method drives the Review job the same way `review_pipeline.run_review_pipeline`
always has: given the request body and a way to emit events, it produces one or more
`{"type": "suggestions", "suggestions": [...]}` events (PromptEditSuggestion-shaped
dicts) and finishes with `{"type": "done"}`. Everything downstream of the Review job
(suggestion accept/revert, prompt-edit application) only depends on that converged
shape, so a method's own intermediate steps are free to differ.

Call signature every method's `run` must accept (all keyword args):
    provider, model, api_key, base_url: str    — task-model credential, already resolved
    body: ReviewRequest                        — the full request (main.py)
    max_tokens: int                            — review_max_tokens setting
    max_failed_inputs: int                     — review_max_failed_rows setting, pre-clamped
    is_cancelled: Callable[[], bool]
    append_event: Callable[[dict], None]
    settings: dict | None                      — full settings dict (main.py _load_settings()),
                                                  for a method with its own tunable settings
                                                  (e.g. review_gepa's gepa_max_iterations)

The existing algorithm (Phase 1 issue analysis -> Phase 2 suggested changes) is
registered here unchanged, as the default method. A new method is a function with
the same call signature, emitting `{"type": "stage", "stage_id": ..., "kind": ...,
"payload": ...}` for its own steps, registered below — no other file needs to change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from review_bootstrap_fewshot import run_bootstrap_fewshot
from review_copro import run_copro
from review_gepa import run_gepa
from review_miprov2 import run_miprov2
from review_pipeline import run_review_pipeline
from review_simba import run_simba
from safe_stdio import safe_print as _print

try:
    # Deliberately not in requirements.txt's normal install path (see the comment there) — a plain
    # `pip install -r requirements.txt` environment (including the packaged desktop build) won't have
    # it. Every other method must keep working when that's the case, so this is the one import in this
    # file allowed to fail — everything above is a hard dependency (in requirements.txt) and should
    # crash loudly like normal if missing.
    from review_textgrad import run_textgrad
except ImportError as e:
    run_textgrad = None
    _print(f"[review_methods] textgrad not importable ({e}) — 'textgrad' review method will not be registered. See requirements.txt for its separate install command.")

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
    # The suggestion-card "Click to Optimize" segment-lattice search (Thompson sampling over
    # paraphrase candidates) is tuned for a small, localized sentence-level old_sentence->new_sentence
    # edit — the built-in method's shape. A method whose suggestion is a whole rewritten prompt (e.g.
    # GEPA, which already searched that space empirically against real data) should leave this False:
    # its suggestion cards show a plain "Verification not pass" instead of an actionable optimize pill.
    supports_segment_optimization: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "stages": [{"id": s.id, "label": s.label} for s in self.stages],
            "supports_segment_optimization": self.supports_segment_optimization,
        }


DEFAULT_REVIEW_METHOD_ID = "issue_analysis_suggestions"

_ALL_METHODS: list[tuple[str, ReviewMethodSpec | None]] = [
    (DEFAULT_REVIEW_METHOD_ID, ReviewMethodSpec(
        id=DEFAULT_REVIEW_METHOD_ID,
        label="Thompson Prompt Search (issue-guided local search)",
        stages=[
            ReviewMethodStage(id="analysis", label="Issue analysis"),
            ReviewMethodStage(id="suggestions", label="Suggested changes"),
        ],
        run=run_review_pipeline,
        supports_segment_optimization=True,
    )),
    ("gepa", ReviewMethodSpec(
        id="gepa",
        label="GEPA (reflective evolution)",
        stages=[
            ReviewMethodStage(id="seed", label="Seed"),
            ReviewMethodStage(id="evolve", label="Evolve"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_gepa,
    )),
    ("miprov2", ReviewMethodSpec(
        id="miprov2",
        label="MIPROv2 (instructions + few-shot)",
        stages=[
            ReviewMethodStage(id="prepare", label="Prepare"),
            ReviewMethodStage(id="compile", label="Compile"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_miprov2,
    )),
    ("bootstrap_fewshot", ReviewMethodSpec(
        id="bootstrap_fewshot",
        label="BootstrapFewShotWithRandomSearch (few-shot only)",
        stages=[
            ReviewMethodStage(id="prepare", label="Prepare"),
            ReviewMethodStage(id="compile", label="Compile"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_bootstrap_fewshot,
    )),
    ("textgrad", None if run_textgrad is None else ReviewMethodSpec(
        id="textgrad",
        label="TextGrad (textual gradient descent)",
        stages=[
            ReviewMethodStage(id="prepare", label="Prepare"),
            ReviewMethodStage(id="optimize", label="Optimize"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_textgrad,
    )),
    ("copro", ReviewMethodSpec(
        id="copro",
        label="COPRO (coordinate ascent, instructions only)",
        stages=[
            ReviewMethodStage(id="prepare", label="Prepare"),
            ReviewMethodStage(id="compile", label="Compile"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_copro,
    )),
    ("simba", ReviewMethodSpec(
        id="simba",
        label="SIMBA (self-reflective rules + few-shot)",
        stages=[
            ReviewMethodStage(id="prepare", label="Prepare"),
            ReviewMethodStage(id="compile", label="Compile"),
            ReviewMethodStage(id="select", label="Select"),
        ],
        run=run_simba,
    )),
]

REGISTRY: dict[str, ReviewMethodSpec] = {method_id: spec for method_id, spec in _ALL_METHODS if spec is not None}


def get_review_method(method_id: str | None) -> ReviewMethodSpec:
    return REGISTRY.get(method_id or DEFAULT_REVIEW_METHOD_ID, REGISTRY[DEFAULT_REVIEW_METHOD_ID])


def list_review_methods() -> list[dict[str, Any]]:
    return [spec.to_dict() for spec in REGISTRY.values()]
