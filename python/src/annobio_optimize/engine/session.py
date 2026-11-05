"""One optimization session: the app's Optimize panel as a Python API (ENGINE_V2_DESIGN.md section 3).

A session reviews ONE source prompt on a set of examples. Its operations are the UI's:
analyze -> cards; verify(card); search(card) -> a new card "optimized from"; accept / revert;
apply. Nothing is accepted automatically: the user, the Agent, or the automatic Operator
decides, each through these same methods. A changed prompt is reviewed by a new session,
as in the app; `history_items()` carries what was tried into the next session.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, replace
import json
import math
import random
from typing import Callable, Sequence

from .. import validation as check
from ..errors import AnnoBioError, CallbackContractError, InputValueError, ModelResponseError, ValidationError, exception_message
from ..model import text_field
from ..original import find_segment, paragraph_around, resolve_unique_span, sample_beta
from ..types import (
    CancelCheck, Evaluate, EvaluationBatch, EventCallback, Example, Issue, IssueCluster, ModelCall,
    Notice, Observation, OptimizationModel, Predict, ProgressEvent, copy_json, prompt_id,
)
from . import prompts
from .records import Card, Check, Decision, EngineConfig, HistoryItem, Mode, SearchRecord, SearchTrialRecord

WithDemos = Callable[[str, list], str]


class EngineStopped(AnnoBioError, RuntimeError):
    """Cancelled or out of budget; the session's records up to that point stay available."""
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Session:
    def __init__(self, *, model: OptimizationModel, predict: Predict, evaluate: Evaluate, prompt: str,
                 examples: Sequence[Example], config: EngineConfig | None = None,
                 observations: Sequence[Observation] | None = None, history: Sequence[HistoryItem] = (),
                 with_demos: WithDemos | None = None, is_cancelled: CancelCheck | None = None,
                 on_event: EventCallback | None = None):
        check.string(prompt, "Session.prompt", nonempty=True)
        check.callbacks(model=model, predict=predict, evaluate=evaluate, is_cancelled=is_cancelled, on_event=on_event)
        check.instance(config, EngineConfig, "Session.config", allow_none=True)
        self.config = config if config is not None else EngineConfig()
        self.model, self.predict, self.evaluate = model, predict, evaluate
        self.with_demos = with_demos
        self.is_cancelled = is_cancelled or (lambda: False)
        self.on_event = on_event
        self.source = self.prompt = prompt
        self.examples = tuple(check.examples(examples))
        self.by_id = {item.id: item for item in self.examples}
        self.history = tuple(history)[-self.config.history_items:] if self.config.history_items else ()
        self.rng = random.Random(self.config.seed)
        self.issues: list[Issue] = []
        self.clusters: list[IssueCluster] = []
        self.cards: list[Card] = []
        self.checks: list[Check] = []
        self.searches: list[SearchRecord] = []
        self.decisions: list[Decision] = []
        self.evaluations: list[EvaluationBatch] = []
        self.model_calls: list[ModelCall] = []
        self.notices: list[Notice] = []
        self.applied: list[str] = []
        self.predictions = 0
        self._baseline: EvaluationBatch | None = None
        self._regression: tuple[str, ...] | None = None
        if observations is not None:
            observations = check.observations(observations, set(self.by_id))
            by_example = {item.example_id: item for item in observations}
            ordered = tuple(deepcopy(by_example[item.id]) for item in self.examples)
            self._baseline = self._record(prompt, ordered)

    # ------------------------------------------------------------------ plumbing

    def _check(self):
        stop = check.invoke(self.is_cancelled, name="is_cancelled")
        if not isinstance(stop, bool):
            raise CallbackContractError("must return bool.", path="is_cancelled.return")
        if stop:
            raise EngineStopped("cancelled")

    def _event(self, stage: str, message: str):
        if self.on_event is not None:
            check.invoke(self.on_event, ProgressEvent(stage, message, 0), name="on_event", context=f"stage={stage!r}")
        self._check()

    def _ask(self, stage: str, payload: dict) -> dict:
        self._check()
        if self.config.max_model_calls is not None and len(self.model_calls) >= self.config.max_model_calls:
            raise EngineStopped("budget_exhausted")
        request = prompts.request(stage, payload)
        response = check.invoke(self.model, deepcopy(request), name="model", context=f"stage={stage!r}")
        try:
            raw = copy_json(response, f"model.return[stage={stage!r}]")
        except ValidationError as exc:
            raise CallbackContractError(exc.message, path=exc.path, hint=exc.hint) from exc
        self.model_calls.append(ModelCall(f"model-{len(self.model_calls) + 1}", request, raw))
        if isinstance(response, str):
            content = response.strip()
            if content.startswith("```") and content.endswith("```"):
                content = content.split("\n", 1)[-1].rsplit("```", 1)[0]
            try:
                response = json.loads(content)
            except ValueError as exc:
                raise ModelResponseError("invalid JSON.", path=f"model.return[stage={stage!r}]") from exc
        if not isinstance(response, dict):
            raise ModelResponseError("expected a JSON object.", path=f"model.return[stage={stage!r}]")
        return response

    def passed(self, observation: Observation) -> bool:
        value = observation.evaluation
        if value.error:
            return False
        if value.total_count is not None:  # the app's rule: every comparison row of the input matched
            return value.total_count > 0 and value.matched_count == value.total_count
        return value.passed if value.passed is not None else value.score >= self.config.pass_threshold

    def _record(self, prompt: str, observations) -> EvaluationBatch:
        observations = tuple(observations)
        mean = sum(item.evaluation.score for item in observations) / len(observations) if observations else 0.0
        batch = EvaluationBatch(f"evaluation-{len(self.evaluations) + 1}", prompt_id(prompt), observations, mean)
        self.evaluations.append(batch)
        return batch

    def run(self, prompt: str, example_ids: Sequence[str]) -> EvaluationBatch:
        """Predict and score `prompt` on the given inputs (public: the Operator scores whole batches)."""
        self._check()
        if self.config.max_predictions is not None and self.predictions + len(example_ids) > self.config.max_predictions:
            raise EngineStopped("budget_exhausted")
        observations = []
        for id in example_ids:
            self._check()
            example = self.by_id[id]
            self.predictions += 1
            prediction = check.prediction_result(check.invoke(self.predict, prompt, deepcopy(example.inputs),
                                                 name="predict", context=f"example_id={id!r}"), id)
            evaluation = check.evaluation_result(check.invoke(self.evaluate, deepcopy(example), deepcopy(prediction),
                                                 name="evaluate", context=f"example_id={id!r}"), id)
            observations.append(Observation(id, prediction, evaluation))
        return self._record(prompt, observations)

    def baseline(self) -> EvaluationBatch:
        if self._baseline is None:
            self._baseline = self.run(self.source, [item.id for item in self.examples])
        return self._baseline

    def _evidence(self, observation: Observation) -> dict:
        return {"example": asdict(self.by_id[observation.example_id]), "prediction": observation.prediction,
                "evaluation": asdict(observation.evaluation)}

    def _history_payload(self) -> list:
        return [asdict(item) for item in self.history]

    def card(self, card_id: str) -> Card:
        for item in self.cards:
            if item.id == card_id:
                return item
        raise InputValueError(f"unknown card {card_id!r}.", path="card_id")

    def _add(self, card: Card) -> Card | None:
        """Add a card. A proposal identical to an earlier one is merged into it (its targets and
        diagnoses are added), so no failed input loses its card. An optimized card is always added,
        as in the app ("Optimized from #N"), even when the search kept the original wording."""
        if card.optimized_from is None:
            for index, other in enumerate(self.cards):
                if (other.kind, other.old_text.strip(), other.new_text) == (card.kind, card.old_text.strip(), card.new_text):
                    order = [e.id for e in self.examples]
                    targets = sorted(set(other.target_example_ids) | set(card.target_example_ids), key=order.index)
                    self.cards[index] = replace(other, target_example_ids=tuple(targets),
                        issue_ids=tuple(dict.fromkeys(other.issue_ids + card.issue_ids)),
                        addresses=tuple(dict.fromkeys(other.addresses + card.addresses))[:3])
                    return None
        if len(self.cards) >= self.config.max_cards:
            self.notices.append(Notice("propose", "card limit reached"))
            return None
        self.cards.append(card)
        return card

    def _next_card_id(self) -> str:
        return f"card-{len(self.cards) + 1}"

    # ------------------------------------------------------------------ analyze

    def failed(self) -> list[Observation]:
        return [item for item in self.baseline().observations if not self.passed(item)]

    def diagnose(self) -> list[Issue]:
        """Diagnosis cards, one per failed input in input order, up to max_failed_examples."""
        if self.issues:
            return list(self.issues)
        baseline = self.baseline()
        for observation in self.failed()[:self.config.max_failed_examples]:
            self._event("diagnose", f"Diagnosing {observation.example_id}")
            data = self._ask("diagnose", {"prompt": self.source, **self._evidence(observation)})
            summary = text_field(data, "issue_summary", stage="diagnose")
            advice = text_field(data, "rough_modification_opinion", stage="diagnose")
            if not summary.strip() or not advice.strip():
                raise ModelResponseError("diagnosis needs issue_summary and rough_modification_opinion.",
                                         path="model.return[stage='diagnose']")
            optional = {name: data.get(name) if isinstance(data.get(name), str) else ""
                        for name in ("problem_category_hint", "gt_suspect_note", "card_title")}
            self.issues.append(Issue(f"issue-{len(self.issues) + 1}", observation.example_id, baseline.id, summary, advice,
                                     optional["problem_category_hint"], optional["gt_suspect_note"], optional["card_title"]))
        return list(self.issues)

    def _cluster(self) -> list[IssueCluster]:
        if self.clusters:
            return list(self.clusters)
        issues = self.issues
        by_id = {issue.id: issue for issue in issues}
        groups = [[issue.id] for issue in issues]
        if len(issues) > self.config.cluster_threshold:
            try:
                data = self._ask("cluster", {"issues": [{k: v for k, v in asdict(i).items() if k != "reference_note"}
                                                        for i in issues]})
                raw = data.get("clusters")
                if not isinstance(raw, list):
                    raise ModelResponseError("clusters must be an array.")
                assigned, groups = set(), []
                for entry in raw:
                    members = entry.get("issue_ids") if isinstance(entry, dict) else None
                    group = [id for id in members or [] if isinstance(id, str) and id in by_id and id not in assigned]
                    assigned.update(group)
                    if group:
                        groups.append(group)
                groups.extend([issue.id] for issue in issues if issue.id not in assigned)
            except (ModelResponseError, TypeError, AttributeError) as exc:
                self.notices.append(Notice("cluster", f"{exc} Grouping by category instead."))
                buckets: dict[str, list[str]] = {}
                for issue in issues:
                    buckets.setdefault(issue.category.strip().lower() or "uncategorized", []).append(issue.id)
                groups = list(buckets.values())
        for ids in groups:
            hints = sorted({by_id[id].category.strip() for id in ids if by_id[id].category.strip()})
            label = ", ".join(hints[:3]) or (by_id[ids[0]].title or by_id[ids[0]].summary)[:120]
            self.clusters.append(IssueCluster(f"cluster-{len(self.clusters) + 1}", tuple(ids),
                                              tuple(by_id[id].example_id for id in ids), label))
        return list(self.clusters)

    def analyze(self, mode: Mode = "local") -> list[Card]:
        """Diagnose, then propose: one localized card per issue cluster (mode "local"), or one
        whole-prompt rewrite card for all diagnoses (mode "rewrite"; the coarse phase)."""
        check.choice(mode, ("local", "rewrite"), "analyze.mode")
        issues = self.diagnose()
        if not issues:
            return []
        added = []
        if mode == "rewrite":
            self._event("propose", "Proposing a rewrite")
            card = self._rewrite_card(issues)
            if card is not None and self._add(card):
                added.append(card)
            return added
        baseline = self.baseline()
        for cluster in self._cluster():
            self._event("propose", f"Proposing an edit for {cluster.id}")
            data = self._ask("propose", {
                "prompt": self.source, "cluster": asdict(cluster), "history": self._history_payload(),
                "issues": [{k: v for k, v in asdict(i).items() if k != "reference_note"}
                           for i in issues if i.id in cluster.issue_ids],
                "observations": [self._evidence(o) for o in baseline.observations if o.example_id in cluster.example_ids]})
            edits = data.get("prompt_edits", [data])
            if not isinstance(edits, list):
                self.notices.append(Notice("propose", "prompt_edits must be an array.", cluster.id))
                continue
            for raw in edits:
                try:
                    card = self._local_card(raw, cluster)
                except (ValueError, TypeError, ModelResponseError) as exc:
                    self.notices.append(Notice("propose", str(exc), cluster.id))
                    continue
                if self._add(card):
                    added.append(card)
        return added

    def _local_card(self, raw, cluster: IssueCluster) -> Card:
        if not isinstance(raw, dict):
            raise ValueError("Each prompt edit must be an object.")
        old = text_field(raw, "old_sentence", nonempty=True)
        new = text_field(raw, "new_sentence")
        resolved = resolve_unique_span(self.source, old)
        if resolved is None:
            raise ValueError("old_sentence cannot be uniquely resolved in the stored prompt.")
        start = self.source.find(resolved)
        kind = "insert" if len(new.strip()) > len(resolved.strip()) and new.strip().startswith(resolved.strip()) else "replace"
        addresses = raw.get("phase1_addresses")
        if not isinstance(addresses, list) or not all(isinstance(a, str) and a.strip() for a in addresses) or not addresses:
            addresses = [i.summary for i in self.issues if i.id in cluster.issue_ids]
        return Card(self._next_card_id(), kind, str(raw.get("name") or "Prompt edit"),
                    text_field(raw, "reason", nonempty=True), prompt_id(self.source), start, start + len(resolved),
                    resolved, new, cluster.example_ids, cluster.issue_ids, tuple(addresses[:3]), cluster.id, cluster.label)

    def _rewrite_card(self, issues: list[Issue]) -> Card | None:
        baseline = self.baseline()
        targets = tuple(dict.fromkeys(issue.example_id for issue in issues))
        data = self._ask("rewrite", {
            "prompt": self.source, "history": self._history_payload(),
            "issues": [{k: v for k, v in asdict(i).items() if k != "reference_note"} for i in issues],
            "observations": [self._evidence(o) for o in baseline.observations if o.example_id in targets]})
        try:
            new = text_field(data, "prompt", nonempty=True, stage="rewrite").strip()
            reason = text_field(data, "reason", nonempty=True, stage="rewrite")
        except ModelResponseError as exc:
            self.notices.append(Notice("rewrite", str(exc)))
            return None
        if new == self.source.strip():
            self.notices.append(Notice("rewrite", "rewrite returned the prompt unchanged"))
            return None
        return Card(self._next_card_id(), "rewrite", str(data.get("name") or "Rewrite the prompt"), reason,
                    prompt_id(self.source), 0, len(self.source), self.source, new, targets,
                    tuple(issue.id for issue in issues), tuple(issue.summary for issue in issues[:3]))

    def propose_demos(self, cap: int) -> Card | None:
        """The "add worked examples" card (design 4.2): one representative failed input per issue
        cluster, with its reference answer, excluding inputs whose reference is suspected wrong.
        Its targets are the OTHER failed inputs: a card is never verified on the examples it shows."""
        check.integer(cap, "propose_demos.cap", minimum=1)
        if self.with_demos is None:
            raise InputValueError("this session has no with_demos callback.", path="propose_demos")
        issues = self.diagnose()
        clusters = self._cluster() if issues else []
        suspect = {issue.example_id for issue in issues if issue.reference_note.strip()}
        chosen = []
        for cluster in sorted(clusters, key=lambda c: -len(c.example_ids)):
            pick = next((id for id in cluster.example_ids if id not in suspect and id not in chosen), None)
            if pick is not None:
                chosen.append(pick)
            if len(chosen) >= cap:
                break
        failed = [item.example_id for item in self.failed()]
        targets = tuple(id for id in failed if id not in chosen)
        if not chosen or not targets:
            self.notices.append(Notice("demos", "not enough failed inputs to both show and verify worked examples"))
            return None
        new_prompt = check.invoke(self.with_demos, self.source, [deepcopy(self.by_id[id]) for id in chosen], name="with_demos")
        if not isinstance(new_prompt, str) or not new_prompt.startswith(self.source) or new_prompt == self.source:
            raise CallbackContractError("must return the prompt followed by the examples block.", path="with_demos.return")
        start = _closing_anchor(self.source)
        old = self.source[start:]
        new = old + new_prompt[len(self.source):]
        by_example = {issue.example_id: issue for issue in issues}
        reason = "Worked examples, one per failure type: " + "; ".join(
            f"{id} ({by_example[id].title or by_example[id].summary})" for id in chosen)
        card = Card(self._next_card_id(), "demos", "Add worked examples", reason, prompt_id(self.source), start,
                    len(self.source), old, new, targets, tuple(by_example[id].id for id in chosen),
                    tuple(by_example[id].summary for id in chosen[:3]), demo_example_ids=tuple(chosen))
        return self._add(card)

    # ------------------------------------------------------------------ verify and search

    def regression_ids(self) -> tuple[str, ...]:
        """Inputs that pass at baseline, drawn once per session with its seed (design 6)."""
        if self._regression is None:
            passed = [item.example_id for item in self.baseline().observations if self.passed(item)]
            self._regression = tuple(sorted(self.rng.sample(passed, min(self.config.regression_examples, len(passed))),
                                            key=[e.id for e in self.examples].index))
        return self._regression

    def _check_prompt(self, card: Card, prompt: str, kind: str) -> Check:
        baseline = {item.example_id: item for item in self.baseline().observations}
        targets = tuple(id for id in (e.id for e in self.examples) if id in set(card.target_example_ids))
        regression = tuple(id for id in self.regression_ids() if id not in set(targets) and id not in set(card.demo_example_ids))
        id = f"check-{len(self.checks) + 1}"
        try:
            if prompt.strip() == self.source.strip():
                raise ValueError("the card does not change the prompt")
            batch = self.run(prompt, targets + regression)
        except EngineStopped:
            raise
        except ValidationError:
            raise
        except Exception as exc:
            record = Check(id, card.id, kind, prompt_id(prompt), targets, regression, (), (), 0, 0, 0.0, False,
                           "error", exception_message(exc))
            self.checks.append(record)
            return record
        by_id = {item.example_id: item for item in batch.observations}
        matched = total = 0
        for id_ in targets:
            evaluation = by_id[id_].evaluation
            matched += evaluation.matched_count if evaluation.total_count is not None else int(self.passed(by_id[id_]))
            total += evaluation.total_count if evaluation.total_count is not None else 1
        fixed = tuple(i for i in targets if self.passed(by_id[i]) and not self.passed(baseline[i]))
        lost = tuple(i for i in regression if self.passed(baseline[i]) and not self.passed(by_id[i]))
        record = Check(id, card.id, kind, prompt_id(prompt), targets, regression, fixed, lost, matched, total,
                       (sum(self.passed(by_id[i]) for i in targets) / len(targets)) if targets else 0.0,
                       bool(targets) and all(self.passed(by_id[i]) for i in targets), "complete")
        self.checks.append(record)
        return record

    def verify(self, card_id: str) -> Check:
        """Apply ONLY this card to the source prompt; run its targets and the regression inputs."""
        card = self.card(card_id)
        self._event("verify", f"Verifying {card_id}")
        return self._check_prompt(card, card.apply(self.source), "verify")

    def latest_check(self, card_id: str) -> Check | None:
        return next((c for c in reversed(self.checks) if c.card_id == card_id and c.kind == "verify"), None)

    def reward(self, record: Check) -> float:
        if record.status != "complete":
            return 0.0
        penalty = self.config.regression_penalty * (len(record.lost_ids) / len(record.regression_ids)) if record.regression_ids else 0.0
        return min(1.0, max(0.0, record.target_rate - penalty))

    def searchable(self, card_id: str) -> bool:
        card = self.card(card_id)
        return card.kind in ("replace", "insert") and bool(self._search_text(card).strip())

    @staticmethod
    def _search_text(card: Card) -> str:
        # An insertion keeps its anchor sentence fixed and searches only the added text.
        return card.new_text[len(card.old_text):] if card.kind == "insert" else card.new_text

    def search(self, card_id: str) -> SearchRecord:
        """Segment the card's new text, write alternatives per segment and pick a combination by
        Thompson sampling. Reward: target pass rate minus the regression penalty. A successful search
        adds a new card optimized_from this one, already verified by its best trial."""
        card = self.card(card_id)
        if not self.searchable(card_id):
            raise InputValueError("only replace/insert cards with new text can be searched.", path="search.card_id")
        fixed_prefix = card.old_text if card.kind == "insert" else ""
        proposal = self._search_text(card)
        segments, candidates = self._lattice(card, proposal)
        alpha = [[1.0] * len(row) for row in candidates]
        beta = [[1.0] * len(row) for row in candidates]
        trials, seen, status = [], set(), "complete"
        best = (None, -1.0, "")  # (check, reward, text)
        try:
            for index in range(1, self.config.max_trials + 1):
                self._event("search", f"Search trial {index}/{self.config.max_trials}")
                for _ in range(50):
                    picks = tuple(max(range(len(row)), key=lambda k: sample_beta(alpha[s][k], beta[s][k], self.rng.random))
                                  for s, row in enumerate(candidates))
                    text = "".join(row[k] for row, k in zip(candidates, picks))
                    if text not in seen:
                        break
                if text in seen:
                    break  # every reachable combination was tried
                seen.add(text)
                trial_card = replace(card, new_text=fixed_prefix + text)
                record = self._check_prompt(trial_card, trial_card.apply(self.source), "search")
                reward = self.reward(record)
                for s, pick in enumerate(picks):
                    alpha[s][pick] += reward
                    beta[s][pick] += 1 - reward
                trials.append(SearchTrialRecord(index, picks, text, record.id, reward, record.status == "complete"))
                better = reward > best[1] or (reward == best[1] and best[0] is not None and len(text) < len(best[2]))
                if record.status == "complete" and better:
                    best = (record, reward, text)
                if record.status == "complete" and reward >= 1.0:
                    break
        except EngineStopped as exc:
            status = exc.reason
        optimized = None
        if status == "complete" and best[0] is not None and best[1] > 0:
            new_card = replace(card, id=self._next_card_id(), new_text=fixed_prefix + best[2], optimized_from=card.id)
            if self._add(new_card):
                optimized = new_card.id
                # The best trial already ran exactly this prompt: record it as the new card's Verify.
                self.checks.append(replace(best[0], id=f"check-{len(self.checks) + 1}", card_id=new_card.id, kind="verify"))
        elif status == "complete":
            status = "failed"
        record = SearchRecord(f"search-{len(self.searches) + 1}", card.id, tuple(segments),
                              tuple(tuple(row) for row in candidates), tuple(trials), best[2],
                              best[1] if best[0] is not None else None, optimized, status)
        self.searches.append(record)
        return record

    def _lattice(self, card: Card, proposal: str):
        try:
            data = self._ask("segment", {"old_text": card.old_text, "new_text": proposal, "rationale": card.rationale,
                                         "max_segments": self.config.max_segments})
            values = data.get("segments")
            if (not isinstance(values, list) or not values or not all(isinstance(v, str) and v for v in values)
                    or "".join(values) != proposal):
                raise ModelResponseError("segments must reproduce new_text exactly.")
            segments = list(values)
            if len(segments) > self.config.max_segments:
                size = math.ceil(len(segments) / self.config.max_segments)
                segments = ["".join(segments[i:i + size]) for i in range(0, len(segments), size)]
        except ModelResponseError as exc:
            self.notices.append(Notice("segment", f"{exc} Using the whole text as one segment.", card.cluster_id))
            segments = [proposal]
        candidates, offset = [], 0
        for index, segment in enumerate(segments):
            row = [segment]
            try:
                data = self._ask("paraphrase", {
                    "prompt_context": paragraph_around(self.source, card.old_text), "old_text": card.old_text,
                    "new_text": proposal, "rationale": card.rationale, "focus": segment,
                    "prefix": proposal[:offset], "suffix": proposal[offset + len(segment):],
                    "segment_index": index, "total_segments": len(segments),
                    "num_candidates": self.config.candidates_per_segment})
                values = data.get("candidates")
                if not isinstance(values, list):
                    raise ModelResponseError("candidates must be an array.")
                for value in values:
                    if isinstance(value, str) and value.strip() and value not in row:
                        row.append(value)
                    if len(row) > self.config.candidates_per_segment:
                        break
            except ModelResponseError as exc:
                self.notices.append(Notice("paraphrase", f"{exc} Keeping the original segment.", card.cluster_id))
            candidates.append(row)
            offset += len(segment)
        return segments, candidates

    # ------------------------------------------------------------------ decisions

    def accept(self, card_id: str) -> str:
        self.card(card_id)
        before = self.prompt
        if card_id not in self.applied:
            self.applied.append(card_id)
        self._rebuild()
        self.decisions.append(Decision(card_id, "accept", prompt_id(before), prompt_id(self.prompt)))
        return self.prompt

    def revert(self, card_id: str) -> str:
        self.card(card_id)
        before = self.prompt
        if card_id in self.applied:
            self.applied.remove(card_id)
        self._rebuild()
        self.decisions.append(Decision(card_id, "revert", prompt_id(before), prompt_id(self.prompt)))
        return self.prompt

    def _rebuild(self):
        """Working prompt = source + every accepted card, in acceptance order (the app's rule)."""
        text = self.source
        for card_id in self.applied:
            card = self.card(card_id)
            if card.kind == "rewrite":
                if text != self.source:
                    self.notices.append(Notice("apply", f"{card_id}: a rewrite replaces earlier accepted cards."))
                text = card.new_text
                continue
            segment = find_segment(text, card.old_text)
            if segment is None:
                self.notices.append(Notice("apply", f"{card_id}: its text is no longer in the prompt; skipped."))
                continue
            at = text.find(segment)
            text = text[:at] + card.new_text + text[at + len(segment):]
        self.prompt = text

    def apply(self) -> str:
        """The prompt the app saves as a new Prompt version."""
        return self.prompt

    # ------------------------------------------------------------------ records

    def history_items(self) -> list[HistoryItem]:
        items = []
        for card in self.cards:
            record = self.latest_check(card.id)
            if record is None:
                continue
            items.append(HistoryItem(card.kind, card.title, card.rationale[:400], card.old_text[:400],
                                     card.new_text[:800], len(record.target_ids), len(record.fixed_ids),
                                     len(record.regression_ids), len(record.lost_ids), card.id in self.applied))
        return items

    def snapshot(self) -> dict:
        return json.loads(json.dumps({
            "version": "annobio-engine-session-v1", "source": self.source, "prompt": self.prompt,
            "config": asdict(self.config), "examples": [asdict(e) for e in self.examples],
            "history": [asdict(h) for h in self.history], "issues": [asdict(i) for i in self.issues],
            "clusters": [asdict(c) for c in self.clusters], "cards": [asdict(c) for c in self.cards],
            "checks": [asdict(c) for c in self.checks], "searches": [asdict(s) for s in self.searches],
            "decisions": [asdict(d) for d in self.decisions], "applied": list(self.applied),
            "evaluations": [asdict(e) for e in self.evaluations], "model_calls": [asdict(m) for m in self.model_calls],
            "notices": [asdict(n) for n in self.notices], "predictions": self.predictions}, ensure_ascii=False))


def _closing_anchor(prompt: str) -> int:
    """Start of the shortest unique tail of the prompt that begins at a line start (the demos card's old text)."""
    lines = prompt.rstrip("\n").split("\n")
    start = len(prompt.rstrip("\n")) - len(lines[-1])
    while prompt.count(prompt[start:]) > 1 and start > 0:
        start = prompt.rfind("\n", 0, start - 1) + 1
    return start
