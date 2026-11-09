"""The app's staged review workflow as a provider-independent Python API.

Original behavior lives here; the automatic safeguarded strategy remains in
optimizer.py. Search creates a separate unapplied suggestion, never an acceptance.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, replace
import math
from typing import Sequence

from .model import ModelResponseError, text_field
from . import validation as check
from .errors import AnnoBioError, CallbackContractError, InputValueError, UnknownSuggestionError, ValidationError, exception_message
from .optimizer import Optimizer, _Session, _Stopped
from .original import find_segment, paragraph_around, resolve_unique_span, sample_beta
from .review_types import (
    ReviewConfig, ReviewDecision, ReviewResult, ReviewSearchConfig, ReviewSearchResult,
    ReviewSuggestion, SearchTrial, Verification,
)
from .types import (
    CancelCheck, Evaluate, Evaluation, EvaluationBatch, EventCallback, Example, Issue, IssueCluster, ModelRequest,
    Notice, Observation, OptimizationModel, OptimizerConfig, Predict, PromptEdit, RunStats,
    SearchSpace, copy_json, prompt_id,
)


class ReviewStopped(AnnoBioError, RuntimeError):
    """An analysis/verification stopped; result contains its partial trace."""
    def __init__(self, reason: str, result: ReviewResult):
        super().__init__(reason)
        self.reason = reason
        self.result = result


class _ReviewCore(_Session):
    def cluster(self, issues):
        """Original normalization: discard duplicate/unknown members, fill missing singletons."""
        groups = [[issue.id] for issue in issues]
        by_id = {issue.id: issue for issue in issues}
        order = {issue.id: index for index, issue in enumerate(issues)}
        if len(issues) > self.config.cluster_threshold:
            try:
                data = self.ask("cluster", {"issues": [asdict(issue) for issue in issues]})
                if not isinstance(data.get("clusters"), list):
                    raise ModelResponseError("clusters must be an array.")
                assigned, groups = set(), []
                for raw in data["clusters"]:
                    if not isinstance(raw, dict):
                        raise ModelResponseError("Each cluster must be an object.")
                    members = raw.get("issue_ids")
                    if members is None and isinstance(raw.get("member_indices"), list):
                        members = []
                        for index in raw["member_indices"]:
                            try:
                                index = int(index)
                            except (ValueError, TypeError):
                                continue
                            if 0 <= index < len(issues):
                                members.append(issues[index].id)
                    if not isinstance(members, list):
                        raise ModelResponseError("Cluster members must be an array.")
                    group = []
                    for id in members:
                        if isinstance(id, str) and id in by_id and id not in assigned:
                            assigned.add(id)
                            group.append(id)
                    if group:
                        groups.append(sorted(group, key=order.get))
                groups.extend([issue.id] for issue in issues if issue.id not in assigned)
            except _Stopped:
                raise
            except CallbackContractError:
                raise
            except Exception as exc:
                self.notices.append(Notice("cluster", f"{exc} Falling back to original category grouping."))
                buckets = {}
                for issue in issues:
                    key = (issue.category.strip().lower() or "uncategorized").replace(" ", "_")[:80]
                    buckets.setdefault(key, []).append(issue.id)
                groups = list(buckets.values())
        clusters = []
        for ids in groups:
            hints = sorted({by_id[id].category.strip() for id in ids if by_id[id].category.strip()})
            label = ", ".join(hints[:3]) or (by_id[ids[0]].title or by_id[ids[0]].summary)[:120]
            cluster = IssueCluster(f"cluster-{len(self.clusters) + 1}", tuple(ids),
                                  tuple(by_id[id].example_id for id in ids), label)
            self.clusters.append(cluster)
            clusters.append(cluster)
        return clusters

    def passed(self, observation):
        evaluation = observation.evaluation
        if evaluation.error:
            return False
        if evaluation.total_count is not None:
            return evaluation.total_count > 0 and evaluation.matched_count == evaluation.total_count
        return super().passed(observation)

    def make_request(self, stage, payload):
        request = super().make_request(stage, payload)
        string = {"type": "string"}

        def schema(properties):
            return {"type": "object", "properties": properties, "required": list(properties),
                    "additionalProperties": False}

        if stage == "diagnose":
            request = replace(request, instruction=(
                "Diagnose scoring failures for ONE dataset input. Read model output and expected output "
                "as separate sections; they are independent collections, not positionally paired rows. "
                "Include both matched and unmatched evidence. Identify missing items (including partial "
                "under-coverage) and extra items. Recommend concrete local prompt changes, not generic polish. "
                "Return card_title (plain-English headline), issue_summary, rough_modification_opinion, "
                "problem_category_hint (grouping tag), and gt_suspect_note. gt_suspect_note is normally empty; "
                "only give specific evidence if highly confident the reference is wrong. Do not excuse genuine "
                "prompt failures. Return only a JSON object."
            ), response_schema=schema({name: string for name in (
                "card_title", "issue_summary", "rough_modification_opinion", "problem_category_hint", "gt_suspect_note")}))
        elif stage == "propose":
            edit_schema = schema({"name": string, "phase1_addresses": {"type": "array", "minItems": 1,
                "maxItems": 3, "items": string}, "old_sentence": string, "new_sentence": string, "reason": string})
            request = replace(request, instruction=(
                "Produce ONE minimal localized edit to the STORED prompt that fixes ALL findings in the "
                "issue cluster. Copy old_sentence verbatim from a unique contiguous span in the stored prompt, "
                "not from the diagnosis. new_sentence is its replacement, or an empty string for deletion. "
                "Do not output multiple redundant fixes. Expand requirements for missing/under-covered items "
                "and tighten constraints for extra items. Keep unrelated instructions and placeholders. "
                "Return prompt_edits with exactly one object: name, phase1_addresses (1-3 diagnosis items), "
                "old_sentence, new_sentence, reason. Names/reasons must be plain language. Return JSON only."
            ), response_schema=schema({"prompt_edits": {"type": "array", "items": edit_schema,
                                                      "minItems": 1, "maxItems": 1}}))
        elif stage == "paraphrase":
            request = replace(request, instruction=(
                "Write alternatives for ONLY the focus segment of the improved prompt sentence. "
                "Use the rationale and read-only paragraph context. Fit the prefix and suffix, preserve "
                "the rationale's intent and similar tone/length. Return a JSON object with candidates: "
                "exactly num_candidates replacement strings. Do not output the full sentence."
            ))
        return request


class ReviewSession:
    """One immutable review source plus explicit verify/search/accept/revert actions.

    The baseline is evaluated lazily, or supplied as observations from an earlier run.
    Analyze proposes against original_prompt; accepting suggestions only changes prompt.
    Create another session to review that changed prompt, matching the app's workflow.
    """
    def __init__(self, *, model: OptimizationModel, predict: Predict, evaluate: Evaluate,
                 prompt: str, examples: Sequence[Example], config: ReviewConfig | None = None,
                 observations: Sequence[Observation] | None = None,
                 is_cancelled: CancelCheck | None = None, on_event: EventCallback | None = None):
        check.string(prompt, "review.prompt", nonempty=True)
        check.callbacks(model=model, predict=predict, evaluate=evaluate, is_cancelled=is_cancelled, on_event=on_event)
        check.instance(config, ReviewConfig, "review.config", allow_none=True)
        examples = check.examples(examples)
        self.config = config if config is not None else ReviewConfig()
        automatic = Optimizer(model=model, predict=predict, evaluate=evaluate, config=OptimizerConfig(
            max_failed_examples=self.config.max_failed_examples, cluster_threshold=self.config.cluster_threshold,
            max_model_calls=self.config.max_model_calls, max_predictions=self.config.max_predictions,
            pass_threshold=self.config.pass_threshold, seed=self.config.seed, cache_evaluations=False))
        self._core = _ReviewCore(automatic, prompt, deepcopy(examples), is_cancelled, on_event)
        self.original_prompt = self.prompt = prompt
        self._baseline_id: str | None = None
        self._suggestions: list[ReviewSuggestion] = []
        self._verifications: list[Verification] = []
        self._searches: list[ReviewSearchResult] = []
        self._decisions: list[ReviewDecision] = []
        self._applied: set[str] = set()
        self._analyzed = False
        self._cache: dict[tuple[str, tuple[str, ...]], EvaluationBatch] = {}
        if observations is not None:
            observations = check.observations(observations, {item.id for item in examples})
            by_id = {item.example_id: item for item in observations}
            ordered = tuple(deepcopy(by_id[item.id]) for item in examples)
            for item in ordered:
                copy_json(item.prediction)
                if not isinstance(item.evaluation, Evaluation):
                    raise TypeError("Each observation must have an Evaluation.")
            batch = EvaluationBatch("evaluation-1", prompt_id(prompt), ordered, self._core.mean(ordered))
            self._core.evaluations.append(batch)
            self._baseline_id = batch.id

    @property
    def suggestions(self) -> tuple[ReviewSuggestion, ...]:
        return deepcopy(tuple(self._suggestions))

    @property
    def applied_ids(self) -> tuple[str, ...]:
        return tuple(item.id for item in self._suggestions if item.id in self._applied)

    @contextmanager
    def _operation(self):
        try:
            yield
        except _Stopped as exc:
            raise ReviewStopped(exc.reason, self.snapshot()) from None

    def _evaluate(self, prompt, example_ids, *, cache=False):
        core = self._core
        core.check()
        key = (prompt_id(prompt), tuple(example_ids))
        if cache and key in self._cache:
            core.cache_hits += 1
            return self._cache[key]
        if core.prediction_calls + len(example_ids) > self.config.max_predictions:
            raise _Stopped("budget_exhausted")
        observations = []
        for id in example_ids:
            core.check()
            example = core.example_by_id[id]
            core.prediction_calls += 1
            prediction = check.prediction_result(check.invoke(core.optimizer.predict, prompt, deepcopy(example.inputs),
                name="predict", context=f"example_id={example.id!r}"), example.id)
            core.check()
            core.evaluation_calls += 1
            evaluation = check.evaluation_result(check.invoke(core.optimizer.evaluate, deepcopy(example), deepcopy(prediction),
                name="evaluate", context=f"example_id={example.id!r}"), example.id)
            observations.append(Observation(id, prediction, deepcopy(evaluation)))
        core.check()
        batch = EvaluationBatch(f"evaluation-{len(core.evaluations) + 1}", key[0],
                                tuple(observations), core.mean(observations))
        core.evaluations.append(batch)
        if cache:
            self._cache[key] = batch
        return batch

    def _baseline(self):
        if self._baseline_id is None:
            batch = self._evaluate(self.original_prompt, tuple(item.id for item in self._core.examples))
            self._baseline_id = batch.id
        return next(batch for batch in self._core.evaluations if batch.id == self._baseline_id)

    def analyze(self) -> tuple[ReviewSuggestion, ...]:
        """Diagnose failed inputs in original input order; return unapplied proposals."""
        if self._analyzed:
            return self.suggestions
        core = self._core
        with self._operation():
            baseline = self._baseline()
            failed = [item for item in baseline.observations if not core.passed(item)]
            for observation in failed[:self.config.max_failed_examples]:
                core.event("diagnose", f"Diagnosing {observation.example_id}")
                data = core.ask("diagnose", {"prompt": self.original_prompt, **core.evidence(observation)})

                def field(new, old, default=""):
                    return text_field(data, old if old in data else new, stage="diagnose") if old in data or new in data else default

                summary = field("summary", "issue_summary")
                advice = field("advice", "rough_modification_opinion")
                if not summary.strip() or not advice.strip():
                    raise ModelResponseError("diagnosis must contain issue_summary and rough_modification_opinion.",
                        path="model.return[stage='diagnose']", hint="Return the required fields in request.response_schema.")
                core.issues.append(Issue(f"issue-{len(core.issues) + 1}", observation.example_id, baseline.id,
                    summary, advice, field("category", "problem_category_hint"),
                    field("reference_note", "gt_suspect_note"), field("title", "card_title")))
            clusters = core.cluster([replace(issue, reference_note="") for issue in core.issues]) if core.issues else []
            seen = {(item.edit.old_text.strip(), item.edit.new_text) for item in self._suggestions}
            for cluster in clusters:
                core.event("propose", f"Proposing an edit for {cluster.id}")
                # Suspected reference mistakes are display-only in the original method.
                data = core.ask("propose", {"prompt": self.original_prompt, "cluster": asdict(cluster),
                    "issues": [{key: value for key, value in asdict(issue).items() if key != "reference_note"}
                               for issue in core.issues if issue.id in cluster.issue_ids],
                    "observations": [core.evidence(item) for item in baseline.observations
                                     if item.example_id in cluster.example_ids]})
                edits = data.get("prompt_edits", [data])
                if not isinstance(edits, list):
                    raise ModelResponseError("prompt_edits must be an array.")
                # Original asks for one edit but accepts/deduplicates valid returned edits.
                for raw in edits:
                    if not isinstance(raw, dict):
                        raise ModelResponseError("Each prompt edit must be an object.")
                    try:
                        old = text_field(raw, "old_sentence" if "old_sentence" in raw else "old_text", nonempty=True)
                        new = text_field(raw, "new_sentence" if "new_sentence" in raw else "new_text")
                        key = (old.strip(), new)
                        if key in seen:
                            continue
                        seen.add(key)
                        resolved = resolve_unique_span(self.original_prompt, old)
                        if resolved is None:
                            raise ValueError("Proposed old text cannot be uniquely resolved in the stored prompt.")
                        edit = PromptEdit.from_text(id=f"review-edit-{len(self._suggestions) + 1}",
                            prompt=self.original_prompt, old_text=resolved, new_text=new,
                            rationale=text_field(raw, "reason" if "reason" in raw else "rationale", nonempty=True),
                            target_example_ids=cluster.example_ids, issue_ids=cluster.issue_ids)
                        addresses = raw.get("phase1_addresses", [issue.summary for issue in core.issues
                                                                if issue.id in cluster.issue_ids][:3])
                        if not isinstance(addresses, list) or not addresses or not all(
                                isinstance(item, str) and item.strip() for item in addresses):
                            raise ValueError("phase1_addresses must contain diagnosis descriptions.")
                        edit = replace(edit, name=str(raw.get("name") or "Prompt edit"), addresses=tuple(addresses[:3]))
                        self._suggestions.append(ReviewSuggestion(f"suggestion-{len(self._suggestions) + 1}", edit, cluster.id))
                    except (ValueError, TypeError) as exc:
                        core.notices.append(Notice("propose", str(exc), cluster.id))
                    if len(self._suggestions) >= 64:
                        break
                if len(self._suggestions) >= 64:
                    break
            self._analyzed = True
        return self.suggestions

    def add_suggestion(self, edit: PromptEdit) -> ReviewSuggestion:
        """Import an existing edit, allowing independent verification/search without reanalysis."""
        check.instance(edit, PromptEdit, "add_suggestion.edit")
        edit.apply(self.original_prompt)
        ids = set(edit.target_example_ids)
        if not ids or not ids.issubset(self._core.example_by_id):
            raise InputValueError("must contain at least one target ID, and every ID must belong to this dataset.",
                                  path="add_suggestion.edit.target_example_ids")
        suggestion = ReviewSuggestion(f"suggestion-{len(self._suggestions) + 1}",
            replace(deepcopy(edit), id=f"review-edit-{len(self._suggestions) + 1}"))
        self._suggestions.append(suggestion)
        return deepcopy(suggestion)

    def _suggestion(self, id):
        check.string(id, "suggestion_id", nonempty=True)
        return next((item for item in self._suggestions if item.id == id), None) or self._missing(id)

    def _missing(self, id):
        available = ", ".join(item.id for item in self._suggestions[:5]) or "none yet; call analyze() or add_suggestion() first"
        raise UnknownSuggestionError(f"suggestion_id {id!r} does not belong to this review. Available IDs: {available}.")

    def _test_prompt(self, suggestion, text=None):
        edit = suggestion.edit
        replacement = edit.new_text if text is None else text
        return (self.original_prompt[:edit.start] + replacement.strip() + self.original_prompt[edit.end:]).strip()

    def _run_verification(self, suggestion, example_ids, *, text=None, kind="verify", cache=False,
                          continue_on_error=True):
        prompt = self._test_prompt(suggestion, text)
        id = f"verification-{len(self._verifications) + 1}"
        try:
            if kind == "verify" and (not prompt or prompt == self.original_prompt.strip()):
                raise ValueError("Suggestion does not produce a nonempty changed prompt.")
            batch = self._evaluate(prompt, example_ids, cache=cache)
            matched, total = 0, 0
            for item in batch.observations:
                evaluation = item.evaluation
                matched += (evaluation.matched_count if evaluation.total_count is not None
                            else int(self._core.passed(item)))
                total += evaluation.total_count if evaluation.total_count is not None else 1
            verification = Verification(id, suggestion.id, kind, prompt_id(prompt), tuple(example_ids), batch.id,
                matched, total, matched / total if total else 0.0,
                bool(total) and all(self._core.passed(item) for item in batch.observations), "complete")
        except _Stopped:
            raise
        except ValidationError:
            raise
        except Exception as exc:
            verification = Verification(id, suggestion.id, kind, prompt_id(prompt), tuple(example_ids),
                                        None, 0, 0, 0.0, False, "error", exception_message(exc))
            self._verifications.append(verification)
            if not continue_on_error:
                raise
            return verification
        self._verifications.append(verification)
        return verification

    def verify(self, suggestion_id: str) -> Verification:
        """Verify ONLY the target inputs, independently against the stored original prompt."""
        suggestion = self._suggestion(suggestion_id)
        targets = set(suggestion.edit.target_example_ids)
        with self._operation():
            self._core.event("verify", f"Verifying {suggestion_id}")
            return self._run_verification(suggestion, tuple(item.id for item in self._core.examples if item.id in targets))

    def can_accept(self, suggestion_id: str) -> bool:
        """Original Agent acceptance rule: latest direct Verify completed with full pass."""
        self._suggestion(suggestion_id)
        result = next((item for item in reversed(self._verifications)
                       if item.suggestion_id == suggestion_id and item.kind == "verify"), None)
        return result is not None and result.status == "complete" and result.full_pass

    def _rebuild(self):
        text = self.original_prompt
        for item in self._suggestions:
            if item.id not in self._applied:
                continue
            segment = find_segment(text, item.edit.old_text)
            if segment is None:
                self._core.notices.append(Notice("apply", f"{item.id}: span unavailable after other applied edits; skipped."))
                continue
            at = text.find(segment)
            text = text[:at] + item.edit.new_text.strip() + text[at + len(segment):]
        self.prompt = text

    def accept(self, suggestion_id: str, *, require_verified: bool = False) -> str:
        """Explicit human acceptance; opt into the Agent's full-pass gate when desired."""
        check.boolean(require_verified, "accept.require_verified")
        self._suggestion(suggestion_id)
        if require_verified and not self.can_accept(suggestion_id):
            raise InputValueError("the latest direct verification has not fully passed.", path="accept.require_verified",
                                  hint="Run verify(suggestion_id) and inspect its status/full_pass; manual acceptance can use require_verified=False.")
        before = self.prompt
        self._applied.add(suggestion_id)
        self._rebuild()
        self._decisions.append(ReviewDecision(suggestion_id, "accept", before, self.prompt))
        return self.prompt

    def revert(self, suggestion_id: str) -> str:
        self._suggestion(suggestion_id)
        before = self.prompt
        self._applied.discard(suggestion_id)
        self._rebuild()
        self._decisions.append(ReviewDecision(suggestion_id, "revert", before, self.prompt))
        return self.prompt

    def reject(self, suggestion_id: str) -> str:
        self._suggestion(suggestion_id)
        before = self.prompt
        self._applied.discard(suggestion_id)
        self._rebuild()
        self._decisions.append(ReviewDecision(suggestion_id, "reject", before, self.prompt))
        return self.prompt

    def _search_inputs(self, suggestion, baseline, config):
        targets = set(suggestion.edit.target_example_ids)
        if config.validation_scope == "all":
            ids = tuple(item.id for item in self._core.examples)
            return ids, tuple(id for id in ids if id not in targets)
        order = {item.id: index for index, item in enumerate(self._core.examples)}
        extra = [item for item in baseline.observations if item.example_id not in targets]
        extra.sort(key=lambda item: (not self._core.passed(item), order[item.example_id]))
        regression = {item.example_id for item in extra[:config.regression_examples]}
        ids = tuple(item.id for item in self._core.examples if item.id in targets | regression)
        return ids, tuple(id for id in ids if id in regression)

    def _lattice(self, suggestion, config):
        core, edit = self._core, suggestion.edit
        proposal = edit.new_text.strip()
        try:
            data = core.ask("segment", {"old_text": edit.old_text, "new_text": proposal,
                "rationale": edit.rationale, "max_segments": config.max_segments})
            values = data.get("segments")
            if not isinstance(values, list) or not values:
                raise ModelResponseError("Missing segments array.")
            if config.text_handling == "original":
                segments = [str(item).strip() for item in values if item is not None and str(item).strip()]
                if not segments:
                    raise ModelResponseError("No nonempty segments.")
                if len(segments) > config.max_segments:
                    chunk = math.ceil(len(segments) / config.max_segments)
                    segments = ["".join(segments[i:i + chunk]) for i in range(0, len(segments), chunk)]
                if "".join(segments) != proposal:
                    core.notices.append(Notice("segment", "Original behavior: trimmed segments differ from proposal; continuing.", suggestion.cluster_id))
            else:
                segments = values
                if (not all(isinstance(item, str) and item for item in segments)
                        or len(segments) > config.max_segments or "".join(segments) != proposal):
                    raise ModelResponseError("Exact segments must reconstruct the proposal.")
        except ModelResponseError as exc:
            core.notices.append(Notice("segment", f"{exc} Using full proposal.", suggestion.cluster_id))
            segments = [proposal]
        candidates, offset = [], 0
        for index, segment in enumerate(segments):
            try:
                data = core.ask("paraphrase", {"prompt": self.original_prompt,
                    "prompt_context": paragraph_around(self.original_prompt, edit.old_text),
                    "old_text": edit.old_text, "new_text": proposal, "rationale": edit.rationale,
                    "focus": segment, "prefix": proposal[:offset], "suffix": proposal[offset + len(segment):],
                    "segment_index": index, "total_segments": len(segments),
                    "num_candidates": config.candidates_per_segment})
                values = data.get("candidates")
                if not isinstance(values, list):
                    raise ModelResponseError("Missing candidates array.")
                row, seen = [], set()
                for value in values:
                    if config.text_handling == "original":
                        value = str(value).strip() if value is not None else ""
                    if not isinstance(value, str) or not value:
                        continue
                    key = value.casefold() if config.text_handling == "original" else value
                    if key not in seen:
                        seen.add(key)
                        row.append(value)
                        if len(row) >= config.candidates_per_segment:
                            break
                original_key = segment.casefold() if config.text_handling == "original" else segment
                if original_key not in seen:
                    row.insert(0, segment)
            except ModelResponseError as exc:
                core.notices.append(Notice("paraphrase", f"{exc} Keeping original segment.", suggestion.cluster_id))
                row = [segment]
            candidates.append(tuple(row))
            offset += len(segment)
        return SearchSpace(suggestion.cluster_id or suggestion.id, edit.id, tuple(segments), tuple(candidates))

    def search(self, suggestion_id: str, *, config: ReviewSearchConfig | None = None) -> ReviewSearchResult:
        """Original segment search. Always returns a trace; never applies the result."""
        check.instance(config, ReviewSearchConfig, "search.config", allow_none=True)
        suggestion = self._suggestion(suggestion_id)
        if not suggestion.edit.new_text.strip():
            raise InputValueError("empty replacements can be verified/applied but cannot be segment-searched.",
                                  path="search.suggestion_id", hint="Use verify() and accept() for a deletion.")
        config = config if config is not None else ReviewSearchConfig()
        core = self._core
        space, trials, best_picks = None, [], ()
        ids, regression = (), ()
        best_text, best_rate = suggestion.edit.new_text.strip(), -1.0
        status = "complete"
        try:
            baseline = self._baseline()
            ids, regression = self._search_inputs(suggestion, baseline, config)
            space = self._lattice(suggestion, config)
            alpha = [[1.0] * len(row) for row in space.candidates]
            beta = [[1.0] * len(row) for row in space.candidates]
            baseline_by_id = {item.example_id: item for item in baseline.observations}
            # A warm start is explicitly optional; original starts ALL arms at Beta(1,1).
            if config.warm_start:
                prior = next((item for item in reversed(self._verifications)
                    if item.suggestion_id == suggestion_id and item.kind == "verify" and item.status == "complete"), None)
                original_picks = [row.index(segment) if segment in row else None
                                  for row, segment in zip(space.candidates, space.segments)]
                if prior is not None and all(pick is not None for pick in original_picks):
                    for s, pick in enumerate(original_picks):
                        alpha[s][pick] += prior.pass_rate
                        beta[s][pick] += 1 - prior.pass_rate
            seen = set()
            for index in range(1, config.max_trials + 1):
                core.event("search", f"Search trial {index}/{config.max_trials}")
                picks = tuple(max(range(len(row)), key=lambda k: sample_beta(alpha[s][k], beta[s][k], core.rng.random))
                              for s, row in enumerate(space.candidates))
                text = "".join(row[k] for row, k in zip(space.candidates, picks))
                if config.deduplicate:
                    for _ in range(100):
                        if text not in seen:
                            break
                        picks = tuple(max(range(len(row)), key=lambda k: sample_beta(alpha[s][k], beta[s][k], core.rng.random))
                                      for s, row in enumerate(space.candidates))
                        text = "".join(row[k] for row, k in zip(space.candidates, picks))
                    if text in seen:
                        break
                seen.add(text)
                verification = self._run_verification(suggestion, ids, text=text, kind="search",
                    cache=config.cache_evaluations, continue_on_error=config.continue_on_error)
                ok = verification.status == "complete"
                rate = verification.pass_rate if ok else None
                reward = rate if ok else 0.0
                if ok:
                    batch = next(item for item in core.evaluations if item.id == verification.evaluation_id)
                    if config.reward == "score":
                        reward = batch.score
                    if config.penalize_regression and any(
                        item.evaluation.score < baseline_by_id[item.example_id].evaluation.score
                        or (core.passed(baseline_by_id[item.example_id]) and not core.passed(item))
                        for item in batch.observations
                    ):
                        reward = 0.0
                for s, pick in enumerate(picks):
                    alpha[s][pick] += reward
                    beta[s][pick] += 1 - reward
                trials.append(SearchTrial(index, picks, text, verification.id, rate, reward, ok,
                    tuple(tuple(row) for row in alpha), tuple(tuple(row) for row in beta), verification.error))
                # Original selection is by observed pass rate, irrespective of optional reward shaping.
                if ok and rate > best_rate:
                    best_rate, best_text, best_picks = rate, text, picks
                if ok and rate >= 1.0:
                    break
        except _Stopped as exc:
            status = exc.reason
        optimized_id = None
        # Preserve partial search history on stop, but do not append a new suggestion on cancellation/budget cutoff.
        if status == "complete" and any(trial.ok for trial in trials) and best_text.strip():
            optimized_id = f"suggestion-{len(self._suggestions) + 1}"
            self._suggestions.append(ReviewSuggestion(optimized_id,
                replace(suggestion.edit, id=f"review-edit-{len(self._suggestions) + 1}", new_text=best_text),
                suggestion.cluster_id, suggestion.id))
        elif status == "complete":
            status = "failed"
        result = ReviewSearchResult(f"search-{len(self._searches) + 1}", suggestion.id, config, ids, regression,
            space, tuple(trials), best_text, best_rate if best_rate >= 0 else None, tuple(best_picks), optimized_id, status)
        self._searches.append(result)
        return deepcopy(result)

    def snapshot(self) -> ReviewResult:
        core = self._core
        return deepcopy(ReviewResult(self.original_prompt, self.prompt, self.config, core.examples, self._baseline_id,
            tuple(self._suggestions), tuple(core.issues), tuple(core.clusters), tuple(core.evaluations),
            tuple(self._verifications), tuple(self._searches), tuple(self._decisions), self.applied_ids,
            tuple(core.model_calls), tuple(core.notices), RunStats(len(core.model_calls), core.prediction_calls,
                                                               core.evaluation_calls, core.cache_hits)))
