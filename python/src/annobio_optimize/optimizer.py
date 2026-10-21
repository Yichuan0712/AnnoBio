"""Full Python optimization loop; no imports from the AnnoBio application."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, replace
import itertools
import json
import random
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    from .review import ReviewSession
    from .review_types import ReviewConfig

from .model import ModelResponseError, make_request, string_list, text_field
from . import validation as check
from .errors import CallbackContractError, InputValueError, ValidationError
from .types import (
    CancelCheck, Evaluate, Evaluation, EvaluationBatch, EventCallback, Example, Issue, IssueCluster,
    ModelCall, Notice, Observation, OptimizationModel, OptimizationResult, OptimizerConfig,
    Predict, ProgressEvent, PromptEdit, PromptVersion, RoundRecord, RunStats, SearchSpace,
    Stage, Trial, copy_json, prompt_id,
)

_EPS = 1e-12


class _Stopped(Exception):
    def __init__(self, reason: str):
        self.reason = reason


class Optimizer:
    """Callbacks are synchronous. Each optimize() call has isolated state and RNG."""

    def __init__(self, *, model: OptimizationModel, predict: Predict, evaluate: Evaluate,
                 config: OptimizerConfig | None = None):
        check.callbacks(model=model, predict=predict, evaluate=evaluate)
        check.instance(config, OptimizerConfig, "Optimizer.config", allow_none=True)
        self.model = model
        self.predict = predict
        self.evaluate = evaluate
        self.config = config if config is not None else OptimizerConfig()

    def review(self, prompt: str, examples: Sequence[Example], *, config: ReviewConfig | None = None,
               observations: Sequence[Observation] | None = None,
               is_cancelled: CancelCheck | None = None,
               on_event: EventCallback | None = None) -> ReviewSession:
        """Original staged workflow: analyze, verify, search, explicitly accept/revert.

        This does not execute the automatic safeguarded optimize() strategy.
        Supplying observations reuses existing per-input evaluation, as in the app.
        """
        from .review import ReviewSession
        return ReviewSession(model=self.model, predict=self.predict, evaluate=self.evaluate,
            prompt=prompt, examples=examples, config=config, observations=observations,
            is_cancelled=is_cancelled, on_event=on_event)

    def optimize(self, prompt: str, examples: Sequence[Example], *,
                 is_cancelled: CancelCheck | None = None,
                 on_event: EventCallback | None = None) -> OptimizationResult:
        check.string(prompt, "optimize.prompt", nonempty=True)
        check.instance(self.config, OptimizerConfig, "Optimizer.config")
        check.callbacks(model=self.model, predict=self.predict, evaluate=self.evaluate,
                        is_cancelled=is_cancelled, on_event=on_event)
        examples = check.examples(examples)
        if len(examples) > self.config.max_predictions:
            raise InputValueError(f"must cover the baseline's {len(examples)} examples; received {self.config.max_predictions}.",
                                  path="OptimizerConfig.max_predictions")
        return _Session(self, prompt, deepcopy(examples), is_cancelled, on_event).run()


class _Session:
    def __init__(self, optimizer, prompt, examples, is_cancelled, on_event):
        self.optimizer = optimizer
        self.config = optimizer.config
        self.initial_prompt = self.prompt = prompt
        self.examples = examples
        self.example_by_id = {item.id: item for item in examples}
        self.is_cancelled = is_cancelled if is_cancelled is not None else (lambda: False)
        self.on_event = on_event
        self.rng = random.Random(self.config.seed)
        self.versions: list[PromptVersion] = []
        self.evaluations: list[EvaluationBatch] = []
        self.issues: list[Issue] = []
        self.clusters: list[IssueCluster] = []
        self.trials: list[Trial] = []
        self.search_spaces: list[SearchSpace] = []
        self.rounds: list[RoundRecord] = []
        self.model_calls: list[ModelCall] = []
        self.notices: list[Notice] = []
        self.cache: dict[str, EvaluationBatch] = {}
        self.prediction_calls = self.evaluation_calls = self.cache_hits = 0
        self.round_index = 0

    def check(self):
        result = check.invoke(self.is_cancelled, name="is_cancelled")
        if not isinstance(result, bool):
            raise CallbackContractError("must return bool (True to cancel, False to continue).", path="is_cancelled.return")
        if result:
            raise _Stopped("cancelled")

    def event(self, stage, message, trial_id=None):
        if self.on_event is not None:
            result = check.invoke(self.on_event, ProgressEvent(stage, message, self.round_index, trial_id),
                                  name="on_event", context=f"stage={stage!r}")
            if result is not None:
                raise CallbackContractError("must return None.", path="on_event.return")
        self.check()

    def ask(self, stage: Stage, payload: dict) -> dict:
        self.check()
        if len(self.model_calls) >= self.config.max_model_calls:
            raise _Stopped("budget_exhausted")
        request = self.make_request(stage, payload)
        response = check.invoke(self.optimizer.model, deepcopy(request), name="model", context=f"stage={stage!r}")
        try:
            raw = copy_json(response, f"model.return[stage={stage!r}]")
        except ValidationError as exc:
            raise CallbackContractError(exc.message, path=exc.path, hint=exc.hint) from exc
        self.model_calls.append(ModelCall(f"model-{len(self.model_calls) + 1}", request, raw))
        self.check()
        if isinstance(response, str):
            content = response.strip()
            if content.startswith("```") and content.endswith("```"):
                content = content.split("\n", 1)[-1].rsplit("```", 1)[0]
            try:
                response = json.loads(content)
            except RecursionError as exc:
                raise ModelResponseError("JSON is nested too deeply to decode.", path=f"model.return[stage={stage!r}]") from exc
            except ValueError as exc:
                raise ModelResponseError(f"invalid JSON ({exc.msg if isinstance(exc, json.JSONDecodeError) else 'parse error'}).",
                    path=f"model.return[stage={stage!r}]",
                    hint="Return a dict or a JSON object string matching request.response_schema.") from exc
        if not isinstance(response, dict):
            raise ModelResponseError(f"expected a JSON object, received {type(response).__name__}.",
                path=f"model.return[stage={stage!r}]", hint="Extract the JSON object from your SDK response before returning it.")
        try:
            response = copy_json(response, f"model.return[stage={stage!r}]")
        except ValidationError as exc:
            raise ModelResponseError(exc.message, path=exc.path, hint=exc.hint) from exc
        return response

    def make_request(self, stage: Stage, payload: dict):
        return make_request(stage, payload)

    def evaluate_prompt(self, prompt: str) -> EvaluationBatch:
        self.check()
        pid = prompt_id(prompt)
        if self.config.cache_evaluations and pid in self.cache:
            self.cache_hits += 1
            return self.cache[pid]
        # Reserve a whole batch so a budget cutoff never produces a partial score.
        if self.prediction_calls + len(self.examples) > self.config.max_predictions:
            raise _Stopped("budget_exhausted")
        observations = []
        for example in self.examples:
            self.check()
            self.prediction_calls += 1
            prediction = check.prediction_result(check.invoke(self.optimizer.predict, prompt, deepcopy(example.inputs),
                name="predict", context=f"example_id={example.id!r}"), example.id)
            self.check()
            self.evaluation_calls += 1
            evaluation = check.evaluation_result(check.invoke(self.optimizer.evaluate, deepcopy(example), deepcopy(prediction),
                name="evaluate", context=f"example_id={example.id!r}"), example.id)
            observations.append(Observation(example.id, prediction, deepcopy(evaluation)))
        batch = EvaluationBatch(f"evaluation-{len(self.evaluations) + 1}", pid,
                                tuple(observations), self.mean(observations))
        self.evaluations.append(batch)
        self.cache[pid] = batch
        return batch

    def mean(self, observations) -> float:
        observations = tuple(observations)
        weights = [self.example_by_id[item.example_id].weight for item in observations]
        # Scale weights to avoid overflow for otherwise valid large user weights.
        scale = max(weights)
        return sum(item.evaluation.score * (weight / scale) for item, weight in zip(observations, weights)) / sum(
            weight / scale for weight in weights)

    def passed(self, observation: Observation) -> bool:
        value = observation.evaluation
        if value.error:
            return False
        return value.passed if value.passed is not None else value.score >= self.config.pass_threshold

    def evidence(self, observation: Observation) -> dict:
        example = self.example_by_id[observation.example_id]
        return {"example": asdict(example), "prediction": observation.prediction,
                "evaluation": asdict(observation.evaluation)}

    def diagnose(self, batch: EvaluationBatch) -> list[Issue]:
        failed = [item for item in batch.observations if not self.passed(item)]
        # Stable worst-score-first cap avoids repeatedly ignoring later failures.
        failed.sort(key=lambda item: item.evaluation.score)
        issues = []
        for observation in failed[:self.config.max_failed_examples]:
            self.event("diagnose", f"Diagnosing {observation.example_id}")
            data = self.ask("diagnose", {"prompt": self.prompt, **self.evidence(observation)})
            issue = Issue(f"issue-{len(self.issues) + 1}", observation.example_id, batch.id,
                          text_field(data, "summary", nonempty=True, stage="diagnose"),
                          text_field(data, "advice", nonempty=True, stage="diagnose"),
                          text_field(data, "category", stage="diagnose"), text_field(data, "reference_note", stage="diagnose"))
            self.issues.append(issue)
            issues.append(issue)
        return issues

    def cluster(self, issues: list[Issue]) -> list[IssueCluster]:
        groups = [([issue.id], issue.category) for issue in issues]
        if len(issues) > self.config.cluster_threshold:
            try:
                data = self.ask("cluster", {"issues": [asdict(issue) for issue in issues]})
                if not isinstance(data.get("clusters"), list):
                    raise ModelResponseError("clusters must be an array.")
                groups = []
                for group in data["clusters"]:
                    if not isinstance(group, dict):
                        raise ModelResponseError("Each cluster must be an object.")
                    ids = string_list(group, "issue_ids")
                    if not ids:
                        raise ModelResponseError("Clusters cannot be empty.")
                    groups.append((ids, text_field(group, "label")))
                flattened = [id for ids, _ in groups for id in ids]
                if len(flattened) != len(issues) or set(flattened) != {issue.id for issue in issues}:
                    raise ModelResponseError("Clusters must partition all issue IDs exactly once.")
            except ModelResponseError as exc:
                self.notices.append(Notice("cluster", f"{exc} Falling back to category grouping."))
                buckets: dict[str, list[str]] = {}
                for issue in issues:
                    # Unknown categories stay separate rather than merging unrelated failures.
                    key = issue.category.strip().casefold() or issue.id
                    buckets.setdefault(key, []).append(issue.id)
                groups = [(ids, label) for label, ids in buckets.items()]
        by_id = {issue.id: issue for issue in issues}
        clusters = []
        for ids, label in groups:
            cluster = IssueCluster(f"cluster-{len(self.clusters) + 1}", tuple(ids),
                                   tuple(dict.fromkeys(by_id[id].example_id for id in ids)), label)
            self.clusters.append(cluster)
            clusters.append(cluster)
        return clusters

    def propose(self, cluster: IssueCluster, batch: EvaluationBatch) -> PromptEdit | None:
        by_id = {issue.id: issue for issue in self.issues}
        data = self.ask("propose", {"prompt": self.prompt, "cluster": asdict(cluster),
            "issues": [asdict(by_id[id]) for id in cluster.issue_ids],
            "observations": [self.evidence(item) for item in batch.observations
                             if item.example_id in cluster.example_ids]})
        try:
            edit = PromptEdit.from_text(id=f"edit-{len(self.trials) + 1}", prompt=self.prompt,
                old_text=text_field(data, "old_text", nonempty=True, stage="propose"),
                new_text=text_field(data, "new_text", stage="propose"), rationale=text_field(data, "rationale", nonempty=True, stage="propose"),
                target_example_ids=cluster.example_ids, issue_ids=cluster.issue_ids)
            if edit.new_text == edit.old_text:
                raise ValueError("The proposed edit makes no change.")
            return edit
        except (ValueError, TypeError) as exc:
            self.notices.append(Notice("propose", str(exc), cluster.id))
            return None

    def trial(self, edit: PromptEdit, cluster: IssueCluster, parent: EvaluationBatch,
              source="proposal", picks=()) -> Trial:
        batch = self.evaluate_prompt(edit.apply(self.prompt))
        before = {item.example_id: item for item in parent.observations}
        targets = set(edit.target_example_ids)
        target_gain = self.mean(item for item in batch.observations if item.example_id in targets) - self.mean(
            item for item in parent.observations if item.example_id in targets)
        total_gain = batch.score - parent.score
        regressed = tuple(item.example_id for item in batch.observations
            if (before[item.example_id].evaluation.score - item.evaluation.score > self.config.max_score_drop + _EPS)
            or (self.passed(before[item.example_id]) and not self.passed(item)))
        reasons = []
        if any(item.evaluation.error for item in batch.observations):
            reasons.append("evaluation error")
        if regressed:
            reasons.append("per-example regression")
        if target_gain <= self.config.min_improvement + _EPS:
            reasons.append("insufficient target improvement")
        if total_gain <= self.config.min_improvement + _EPS:
            reasons.append("insufficient overall improvement")
        trial = Trial(f"trial-{len(self.trials) + 1}", self.round_index, cluster.id, edit,
                      source, tuple(picks), batch.id, target_gain, total_gain, regressed,
                      not reasons, "; ".join(reasons))
        self.trials.append(trial)
        self.event("trial", "Candidate eligible" if trial.eligible else trial.rejection_reason, trial.id)
        return trial

    def get_batch(self, trial: Trial) -> EvaluationBatch:
        return next(batch for batch in self.evaluations if batch.id == trial.evaluation_id)

    def target_passed(self, trial: Trial) -> bool:
        targets = set(trial.edit.target_example_ids)
        return all(self.passed(item) for item in self.get_batch(trial).observations if item.example_id in targets)

    def lattice(self, edit: PromptEdit, cluster: IssueCluster) -> SearchSpace:
        try:
            data = self.ask("segment", {"old_text": edit.old_text, "new_text": edit.new_text,
                                       "rationale": edit.rationale, "max_segments": self.config.max_segments})
            segments = string_list(data, "segments", stage="segment")
            if not segments or len(segments) > self.config.max_segments or "".join(segments) != edit.new_text:
                raise ModelResponseError("Segments must reconstruct new_text exactly within max_segments.")
        except ModelResponseError as exc:
            self.notices.append(Notice("segment", f"{exc} Using a single exact segment.", cluster.id))
            segments = [edit.new_text]
        candidates = []
        offset = 0
        for index, segment in enumerate(segments):
            if self.config.candidates_per_segment == 1:
                alternatives = []
            else:
                try:
                    data = self.ask("paraphrase", {"prompt": self.prompt, "old_text": edit.old_text,
                        "new_text": edit.new_text, "rationale": edit.rationale, "focus": segment,
                        "prefix": edit.new_text[:offset], "suffix": edit.new_text[offset + len(segment):],
                        "segment_index": index, "num_candidates": self.config.candidates_per_segment - 1})
                    alternatives = string_list(data, "candidates", stage="paraphrase")
                except ModelResponseError as exc:
                    self.notices.append(Notice("paraphrase", f"{exc} Keeping original segment.", cluster.id))
                    alternatives = []
            # Do not trim: spaces belong to segments and alternatives.
            row = list(dict.fromkeys([segment, *alternatives]))[:self.config.candidates_per_segment]
            candidates.append(tuple(row))
            offset += len(segment)
        space = SearchSpace(cluster.id, edit.id, tuple(segments), tuple(candidates))
        self.search_spaces.append(space)
        return space

    def search(self, edit: PromptEdit, cluster: IssueCluster, parent: EvaluationBatch,
               proposal: Trial, contenders: list[Trial]):
        space = self.lattice(edit, cluster)
        alpha = [[1.0] * len(row) for row in space.candidates]
        beta = [[1.0] * len(row) for row in space.candidates]

        def update(picks, trial):
            # The reward uses the same weighted full-dataset score as selection.
            reward = self.get_batch(trial).score
            if trial.regressed_example_ids:
                reward = 0.0
            for segment, pick in enumerate(picks):
                alpha[segment][pick] += reward
                beta[segment][pick] += 1.0 - reward

        update([0] * len(space.candidates), proposal)
        seen = {edit.new_text, edit.old_text}
        for _ in range(self.config.max_trials - 1):
            self.check()
            # Deduplicate composed text, not just picks (different picks can compose identically).
            picks = None
            for attempt in range(30):
                sampled = tuple(max(range(len(row)), key=lambda k: self.rng.betavariate(alpha[s][k], beta[s][k]))
                                for s, row in enumerate(space.candidates))
                if "".join(row[k] for row, k in zip(space.candidates, sampled)) not in seen:
                    picks = sampled
                    break
            if picks is None:
                # For small lattices, find an unseen combination deterministically on saturation.
                # The bounded scan also prevents exponential work for large user configurations.
                options = itertools.islice(itertools.product(*(range(len(row)) for row in space.candidates)), 10000)
                picks = next((p for p in options if "".join(row[k] for row, k in zip(space.candidates, p)) not in seen), None)
                if picks is None:
                    return
            text = "".join(row[k] for row, k in zip(space.candidates, picks))
            seen.add(text)
            candidate = replace(edit, id=f"edit-{len(self.trials) + 1}", new_text=text)
            trial = self.trial(candidate, cluster, parent, "search", picks)
            contenders.append(trial)
            update(picks, trial)
            if trial.eligible and self.target_passed(trial):
                return

    def accept_best(self, contenders: list[Trial]) -> Trial | None:
        eligible = [trial for trial in contenders if trial.eligible]
        if not eligible:
            return None
        # Stable max keeps the earliest candidate when scores tie.
        selected = max(eligible, key=lambda trial: self.get_batch(trial).score)
        text = selected.edit.apply(self.prompt)
        self.versions.append(PromptVersion(prompt_id(text), text, prompt_id(self.prompt),
                                           selected.id, selected.evaluation_id))
        self.prompt = text
        self.event("accepted", "Accepted validated local edit", selected.id)
        return selected

    def run(self) -> OptimizationResult:
        reason = "max_rounds"
        try:
            self.event("baseline", "Evaluating initial prompt")
            current = self.evaluate_prompt(self.prompt)
            self.versions.append(PromptVersion(prompt_id(self.prompt), self.prompt, None, None, current.id))
            for index in range(1, self.config.max_rounds + 1):
                self.round_index = index
                self.check()
                if all(self.passed(item) for item in current.observations):
                    reason = "perfect"
                    break
                start_id = prompt_id(self.prompt)
                issue_start = len(self.issues)
                cluster_start = len(self.clusters)
                version_start = len(self.versions)
                issues, clusters, accepted = [], [], []
                try:
                    issues = self.diagnose(current)
                    clusters = self.cluster(issues)
                    for cluster in clusters:
                        # A previous accepted edit may already have fixed this cluster.
                        if all(self.passed(item) for item in current.observations if item.example_id in cluster.example_ids):
                            continue
                        self.event("propose", f"Proposing an edit for {cluster.id}")
                        edit = self.propose(cluster, current)
                        if edit is None:
                            continue
                        contenders: list[Trial] = []
                        try:
                            proposal = self.trial(edit, cluster, current)
                            contenders.append(proposal)
                            if (self.config.max_trials > 1 and edit.new_text
                                    and not (proposal.eligible and self.target_passed(proposal))):
                                self.search(edit, cluster, current, proposal, contenders)
                        except _Stopped as exc:
                            # Preserve already verified improvements at a budget boundary.
                            # Cancellation returns the last committed prompt immediately.
                            if exc.reason == "budget_exhausted":
                                selected = self.accept_best(contenders)
                                if selected:
                                    accepted.append(selected.id)
                            raise
                        selected = self.accept_best(contenders)
                        if selected:
                            accepted.append(selected.id)
                            current = self.get_batch(selected)
                finally:
                    self.rounds.append(RoundRecord(index, start_id, prompt_id(self.prompt),
                        tuple(issue.id for issue in self.issues[issue_start:]),
                        tuple(cluster.id for cluster in self.clusters[cluster_start:]),
                        tuple(version.accepted_trial_id for version in self.versions[version_start:])))
                if all(self.passed(item) for item in current.observations):
                    reason = "perfect"
                    break
                if not accepted:
                    reason = "converged"
                    break
        except _Stopped as exc:
            reason = exc.reason
        return OptimizationResult(self.initial_prompt, self.prompt, self.config, self.examples,
            tuple(self.versions), tuple(self.evaluations), tuple(self.issues), tuple(self.clusters),
            tuple(self.trials), tuple(self.search_spaces), tuple(self.rounds), tuple(self.model_calls),
            tuple(self.notices), RunStats(len(self.model_calls), self.prediction_calls,
            self.evaluation_calls, self.cache_hits), reason)
