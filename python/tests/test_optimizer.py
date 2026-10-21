"""Behavioral tests with deterministic task and optimizer models; no network/API keys."""
from dataclasses import replace
import json
import math
import unittest

from annobio_optimize import (
    Evaluation, Example, ModelResponseError, OptimizationResult, Optimizer, OptimizerConfig, PromptEdit,
)


class ScriptedModel:
    def __init__(self, **responses):
        self.responses = responses
        self.calls = []

    def __call__(self, request):
        self.calls.append(request)
        if request.stage == "diagnose":
            return {"summary": "Missing an item", "advice": "Improve coverage", "category": "coverage", "reference_note": ""}
        if request.stage not in self.responses:
            raise AssertionError(f"Unexpected model stage: {request.stage}")
        value = self.responses[request.stage]
        if callable(value):
            return value(request)
        if isinstance(value, list):
            if not value:
                raise AssertionError(f"Exhausted responses: {request.stage}")
            return value.pop(0)
        return value


def proposal(old, new):
    return {"old_text": old, "new_text": new, "rationale": "Fix the missing item"}


def task_optimizer(scores, model, **config):
    # Each prediction is one score; inputs carry a stable column in this synthetic task.
    return Optimizer(model=model, predict=lambda prompt, inputs: scores[prompt][inputs],
                     evaluate=lambda example, prediction: Evaluation(prediction, feedback="Task feedback"),
                     config=OptimizerConfig(**config))


def examples(n):
    return [Example(f"sample-{i}", i) for i in range(n)]


class OptimizerTests(unittest.TestCase):
    def test_full_loop_and_result_round_trip(self):
        model = ScriptedModel(propose=proposal("weak", "strong"))
        result = task_optimizer({"weak": [0, 1], "strong": [1, 1]}, model).optimize("weak", examples(2))
        self.assertEqual(result.prompt, "strong")
        self.assertEqual(result.stop_reason, "perfect")
        self.assertEqual((result.initial_score, result.score), (0.5, 1.0))
        self.assertEqual(result.stats.prediction_calls, 4)
        self.assertEqual(result.stats.evaluation_calls, 4)
        self.assertEqual(result.stats.model_calls, 2)
        self.assertEqual(result.issues[0].example_id, "sample-0")
        self.assertEqual(result.issues[0].evaluation_id, result.evaluations[0].id)
        self.assertEqual(result.versions[-1].parent_id, result.versions[0].id)
        self.assertEqual(result.rounds[0].accepted_trial_ids, (result.trials[0].id,))
        self.assertEqual(result.accepted_edits[0].apply("weak"), "strong")
        restored = OptimizationResult.from_json(result.to_json())
        self.assertEqual(restored, result)
        self.assertEqual(restored.accepted_edits, result.accepted_edits)
        self.assertEqual(restored.to_dict(), json.loads(result.to_json()))

    def test_already_perfect_never_calls_optimization_model(self):
        model = ScriptedModel()
        result = task_optimizer({"done": [1]}, model).optimize("done", examples(1))
        self.assertEqual(result.stop_reason, "perfect")
        self.assertFalse(result.rounds)
        self.assertEqual(result.stats.model_calls, 0)

    def test_thompson_search_preserves_segment_whitespace(self):
        model = ScriptedModel(propose=proposal("weak", "almost right"),
                              segment={"segments": ["almost ", "right"]},
                              paraphrase=lambda request: {"candidates": ["fully "] if request.payload["segment_index"] == 0 else []})
        result = task_optimizer({"weak": [0, 1], "almost right": [0.5, 1], "fully right": [1, 1]},
                                model, max_trials=3).optimize("weak", examples(2))
        self.assertEqual(result.prompt, "fully right")
        self.assertEqual(result.search_spaces[0].segments, ("almost ", "right"))
        self.assertEqual(result.trials[-1].picks, (1, 0))
        self.assertEqual(result.stats.prediction_calls, 6)
        self.assertEqual(OptimizationResult.from_dict(result.to_dict()), result)

    def test_regression_rejects_higher_total_score(self):
        model = ScriptedModel(propose=proposal("weak", "risky"))
        result = task_optimizer({"weak": [0, 0.9], "risky": [1, 0.5]}, model,
                                max_trials=1, pass_threshold=0.9).optimize("weak", examples(2))
        self.assertGreater(result.trials[0].total_gain, 0)
        self.assertEqual(result.prompt, "weak")
        self.assertEqual(result.trials[0].regressed_example_ids, ("sample-1",))
        self.assertFalse(result.trials[0].eligible)

    def test_regression_on_non_target_failed_sample_is_also_checked(self):
        model = ScriptedModel(propose=proposal("weak", "risky"))
        result = task_optimizer({"weak": [0, 0.6], "risky": [1, 0.5]}, model,
                                max_trials=1, max_failed_examples=1).optimize("weak", examples(2))
        self.assertEqual(result.trials[0].regressed_example_ids, ("sample-1",))
        self.assertEqual(result.prompt, "weak")

    def test_configurable_small_score_drop(self):
        model = ScriptedModel(propose=proposal("weak", "better"))
        result = task_optimizer({"weak": [0, 0.6], "better": [1, 0.55]}, model,
                                max_trials=1, max_failed_examples=1, max_rounds=1,
                                max_score_drop=0.1).optimize("weak", examples(2))
        self.assertEqual(result.prompt, "better")

    def test_passed_to_failed_is_regression_even_with_permitted_score_drop(self):
        model = ScriptedModel(propose=proposal("weak", "risky"))
        optimizer = Optimizer(model=model, predict=lambda prompt, inputs: [prompt, inputs],
            evaluate=lambda example, pred: Evaluation(0 if pred == ["weak", 0] else 1,
                passed=pred not in (["weak", 0], ["risky", 1])),
            config=OptimizerConfig(max_trials=1, max_score_drop=1))
        result = optimizer.optimize("weak", examples(2))
        self.assertFalse(result.trials[0].eligible)
        self.assertEqual(result.trials[0].regressed_example_ids, ("sample-1",))

    def test_weighted_scores(self):
        model = ScriptedModel(propose=proposal("weak", "strong"))
        result = task_optimizer({"weak": [0, 1], "strong": [1, 1]}, model).optimize(
            "weak", [Example("a", 0, weight=3), Example("b", 1)])
        self.assertEqual(result.initial_score, 0.25)
        self.assertEqual(result.trials[0].total_gain, 0.75)

    def test_invalid_or_ambiguous_edit_is_not_silently_applied(self):
        for old in ("weak", "missing"):
            with self.subTest(old=old):
                model = ScriptedModel(propose=proposal(old, "strong"))
                result = task_optimizer({"weak weak": [0]}, model).optimize("weak weak", examples(1))
                self.assertEqual(result.prompt, "weak weak")
                self.assertFalse(result.trials)
                self.assertTrue(result.notices)

    def test_deletion_does_not_request_segments(self):
        model = ScriptedModel(propose=proposal(" bad", ""))
        result = task_optimizer({"good bad": [0], "good": [1]}, model).optimize("good bad", examples(1))
        self.assertEqual(result.prompt, "good")

    def test_invalid_split_falls_back_without_corrupting_text(self):
        model = ScriptedModel(propose=proposal("weak", "almost right"), segment={"segments": ["almost", "right"]},
                              paraphrase={"candidates": ["fully right"]})
        result = task_optimizer({"weak": [0], "almost right": [0.5], "fully right": [1]}, model).optimize("weak", examples(1))
        self.assertEqual(result.prompt, "fully right")
        self.assertEqual(result.search_spaces[0].segments, ("almost right",))
        self.assertTrue(any(notice.stage == "segment" for notice in result.notices))

    def test_budget_cutoff_keeps_verified_partial_improvement(self):
        model = ScriptedModel(propose=proposal("weak", "better"))
        result = task_optimizer({"weak": [0], "better": [0.5]}, model,
                                max_model_calls=2).optimize("weak", examples(1))
        self.assertEqual(result.stop_reason, "budget_exhausted")
        self.assertEqual(result.prompt, "better")
        self.assertEqual(result.rounds[0].accepted_trial_ids, (result.trials[0].id,))
        self.assertEqual(result.score, 0.5)

    def test_prediction_budget_reserves_full_candidate_batch(self):
        model = ScriptedModel(propose=proposal("weak", "strong"))
        result = task_optimizer({"weak": [0, 1], "strong": [1, 1]}, model,
                                max_predictions=3).optimize("weak", examples(2))
        self.assertEqual(result.stop_reason, "budget_exhausted")
        self.assertEqual(result.stats.prediction_calls, 2)
        self.assertEqual(len(result.evaluations), 1)

    def test_zero_optimization_model_budget_still_evaluates_baseline(self):
        result = task_optimizer({"weak": [0]}, ScriptedModel(), max_model_calls=0).optimize("weak", examples(1))
        self.assertEqual(result.stop_reason, "budget_exhausted")
        self.assertEqual(result.score, 0)

    def test_cancel_before_baseline_returns_original_prompt_without_calls(self):
        result = task_optimizer({"weak": [0]}, ScriptedModel()).optimize("weak", examples(1), is_cancelled=lambda: True)
        self.assertEqual(result.stop_reason, "cancelled")
        self.assertEqual(result.prompt, "weak")
        self.assertIsNone(result.score)
        self.assertEqual(result.stats.prediction_calls, 0)

    def test_cancel_during_search_does_not_accept_pending_candidate(self):
        cancelled = False
        def segment(request):
            nonlocal cancelled
            cancelled = True
            return {"segments": ["better"]}
        model = ScriptedModel(propose=proposal("weak", "better"), segment=segment)
        result = task_optimizer({"weak": [0], "better": [0.5]}, model).optimize("weak", examples(1), is_cancelled=lambda: cancelled)
        self.assertEqual(result.stop_reason, "cancelled")
        self.assertEqual(result.prompt, "weak")
        self.assertFalse(result.rounds[0].accepted_trial_ids)

    def test_cluster_partition_and_ids_are_preserved(self):
        model = ScriptedModel(cluster=lambda request: {"clusters": [{
            "issue_ids": [issue["id"] for issue in request.payload["issues"]], "label": "shared"}]},
            propose=proposal("weak", "strong"))
        result = task_optimizer({"weak": [0, 0], "strong": [1, 1]}, model,
                                cluster_threshold=1).optimize("weak", examples(2))
        self.assertEqual(len(result.clusters), 1)
        self.assertEqual(result.accepted_edits[0].target_example_ids, ("sample-0", "sample-1"))

    def test_invalid_cluster_partition_falls_back(self):
        model = ScriptedModel(cluster={"clusters": [{"issue_ids": ["issue-1", "issue-1"], "label": "bad"}]},
                              propose=proposal("weak", "strong"))
        result = task_optimizer({"weak": [0, 0], "strong": [1, 1]}, model,
                                cluster_threshold=1).optimize("weak", examples(2))
        self.assertEqual(len(result.clusters), 1)
        self.assertEqual(result.clusters[0].issue_ids, ("issue-1", "issue-2"))
        self.assertTrue(any(item.stage == "cluster" for item in result.notices))

    def test_reproducible_rng_and_no_session_state_leak(self):
        def make_model():
            return ScriptedModel(propose=proposal("weak", "middle"), segment={"segments": ["middle"]},
                                 paraphrase={"candidates": ["better", "best"]})
        scores = {"weak": [0], "middle": [0.25], "better": [0.5], "best": [0.75]}
        first = task_optimizer(scores, make_model(), max_rounds=1, seed=7)
        a = first.optimize("weak", examples(1))
        b = first.optimize("weak", examples(1))
        self.assertEqual(a.to_dict(), b.to_dict())
        self.assertEqual({t.edit.new_text for t in a.trials}, {"middle", "better", "best"})
        self.assertEqual(a.prompt, "best")

    def test_numeric_evaluator_and_structured_outputs(self):
        model = ScriptedModel(propose=proposal("weak", "strong"))
        optimizer = Optimizer(model=model, predict=lambda p, x: {"items": [] if p == "weak" else x["entities"]},
            evaluate=lambda e, p: float(p == e.reference))
        result = optimizer.optimize("weak", [Example("doc-42", {"entities": ["A", "B"]}, {"items": ["A", "B"]})])
        self.assertEqual(result.score, 1)
        self.assertEqual(model.calls[0].payload["example"]["reference"], {"items": ["A", "B"]})

    def test_callbacks_cannot_mutate_stored_examples_predictions_or_requests(self):
        example = Example("x", {"text": "x"}, {"answer": "a"})
        def predict(prompt, inputs):
            inputs["text"] = "mutated"
            return {"answer": "b" if prompt == "weak" else "a"}
        def evaluate(example, prediction):
            score = float(prediction == example.reference)
            example.reference["answer"] = "mutated"
            prediction["answer"] = "mutated"
            return score
        def model(request):
            request.payload["prompt"] = "mutated"
            if request.stage == "diagnose":
                return {"summary": "Wrong", "advice": "Fix", "category": "x", "reference_note": ""}
            return proposal("weak", "strong")
        result = Optimizer(model=model, predict=predict, evaluate=evaluate).optimize("weak", [example])
        self.assertEqual(result.prompt, "strong")
        self.assertEqual(result.examples[0].reference, {"answer": "a"})
        self.assertEqual(result.evaluations[0].observations[0].prediction, {"answer": "b"})
        self.assertEqual(result.model_calls[0].request.payload["prompt"], "weak")

    def test_task_callback_errors_are_not_misreported_as_bad_candidates(self):
        def broken(prompt, inputs):
            raise ConnectionError("offline")
        with self.assertRaisesRegex(ConnectionError, "offline"):
            Optimizer(model=ScriptedModel(), predict=broken, evaluate=lambda e, p: 1.0).optimize("weak", examples(1))

    def test_bad_model_json_raises_with_no_hidden_retries(self):
        model = lambda request: "invalid JSON"
        with self.assertRaises(ModelResponseError):
            task_optimizer({"weak": [0]}, model).optimize("weak", examples(1))

    def test_duplicate_ids_rejected_before_calls(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            task_optimizer({"weak": [0]}, ScriptedModel()).optimize("weak", [Example("x", 0), Example("x", 0)])

    def test_multi_round_reanalyzes_current_predictions(self):
        model = ScriptedModel(propose=[proposal("weak", "better"), proposal("better", "strong")])
        result = task_optimizer({"weak": [0], "better": [0.5], "strong": [1]}, model,
                                max_trials=1).optimize("weak", examples(1))
        self.assertEqual(result.prompt, "strong")
        self.assertEqual(len(result.rounds), 2)
        diagnoses = [request for request in model.calls if request.stage == "diagnose"]
        self.assertEqual([request.payload["prediction"] for request in diagnoses], [0, 0.5])

    def test_new_proposal_uses_current_prompt_after_previous_acceptance(self):
        model = ScriptedModel(propose=[proposal("weak", "better"), proposal("better", "strong")])
        result = task_optimizer({"weak": [0, 0], "better": [1, 0], "strong": [1, 1]}, model,
                                max_trials=1).optimize("weak", examples(2))
        self.assertEqual(len(result.rounds), 1)
        self.assertEqual(result.prompt, "strong")
        self.assertEqual([call.payload["prompt"] for call in model.calls if call.stage == "propose"], ["weak", "better"])

    def test_repeated_rejected_candidate_cache_is_local_and_optional(self):
        for cached, expected_calls in ((True, 6), (False, 9)):
            with self.subTest(cache=cached):
                model = ScriptedModel(propose=proposal("weak", "risky"))
                result = task_optimizer({"weak": [0, 0, 1], "risky": [1, 1, 0]}, model,
                    max_trials=1, cache_evaluations=cached).optimize("weak", examples(3))
                self.assertEqual(len(result.trials), 2)
                self.assertEqual(result.stats.prediction_calls, expected_calls)
                self.assertEqual(result.stats.cache_hits, 1 if cached else 0)
                self.assertEqual(result.prompt, "weak")

    def test_search_selects_safe_candidate_over_higher_scoring_regression(self):
        model = ScriptedModel(propose=proposal("weak", "risky"), segment={"segments": ["risky"]},
                              paraphrase={"candidates": ["safe"]})
        result = task_optimizer({"weak": [0, 1], "risky": [1, 0.9], "safe": [0.5, 1]}, model,
            max_trials=2, max_rounds=1).optimize("weak", examples(2))
        self.assertEqual(result.prompt, "safe")
        self.assertGreater(result.evaluations[1].score, result.score)
        self.assertFalse(result.trials[0].eligible)
        self.assertEqual(result.versions[-1].accepted_trial_id, result.trials[1].id)

    def test_trial_budget_includes_proposal(self):
        model = ScriptedModel(propose=proposal("weak", "middle"), segment={"segments": ["middle"]},
                              paraphrase={"candidates": ["one", "two", "three"]})
        result = task_optimizer({"weak": [0], "middle": [0.1], "one": [0.2], "two": [0.3], "three": [0.4]},
            model, max_rounds=1, max_trials=2).optimize("weak", examples(1))
        self.assertEqual(len(result.trials), 2)
        self.assertEqual(result.stats.prediction_calls, 3)

    def test_cancel_after_acceptance_records_committed_version_in_round(self):
        cancelled = False
        def on_event(event):
            nonlocal cancelled
            if event.stage == "accepted":
                cancelled = True
        result = task_optimizer({"weak": [0], "strong": [1]},
            ScriptedModel(propose=proposal("weak", "strong"))).optimize(
                "weak", examples(1), is_cancelled=lambda: cancelled, on_event=on_event)
        self.assertEqual(result.stop_reason, "cancelled")
        self.assertEqual(result.prompt, "strong")
        self.assertEqual(result.rounds[0].accepted_trial_ids, (result.trials[0].id,))

    def test_cancel_mid_baseline_never_records_partial_aggregate(self):
        calls = 0
        def predict(prompt, inputs):
            nonlocal calls
            calls += 1
            return 1
        result = Optimizer(model=ScriptedModel(), predict=predict, evaluate=lambda e, p: 1.0).optimize(
            "weak", examples(2), is_cancelled=lambda: calls > 0)
        self.assertEqual(result.stop_reason, "cancelled")
        self.assertEqual(result.stats.prediction_calls, 1)
        self.assertEqual(result.stats.evaluation_calls, 0)
        self.assertFalse(result.evaluations)
        self.assertIsNone(result.initial_score)

    def test_model_json_string_response(self):
        def model(request):
            if request.stage == "diagnose":
                return json.dumps({"summary": "Missing", "advice": "Fix", "category": "x", "reference_note": ""})
            return "```json\n" + json.dumps(proposal("weak", "strong")) + "\n```"
        result = task_optimizer({"weak": [0], "strong": [1]}, model).optimize("weak", examples(1))
        self.assertEqual(result.prompt, "strong")

    def test_invalid_paraphrases_leave_eligible_proposal_available(self):
        model = ScriptedModel(propose=proposal("weak", "better"), segment={"segments": ["better"]},
                              paraphrase={"candidates": [None]})
        result = task_optimizer({"weak": [0], "better": [0.5]}, model,
                                max_rounds=1).optimize("weak", examples(1))
        self.assertEqual(result.prompt, "better")
        self.assertEqual(len(result.trials), 1)
        self.assertTrue(any(item.stage == "paraphrase" for item in result.notices))

    def test_minimum_improvement_checks_target_and_total(self):
        model = ScriptedModel(propose=proposal("weak", "better"))
        result = task_optimizer({"weak": [0, 1], "better": [0.1, 1]}, model,
                                max_trials=1, min_improvement=0.075).optimize("weak", examples(2))
        self.assertEqual(result.prompt, "weak")
        self.assertGreater(result.trials[0].target_gain, 0.075)
        self.assertIn("insufficient overall", result.trials[0].rejection_reason)

    def test_model_budget_mid_diagnosis_retains_partial_issue_provenance(self):
        result = task_optimizer({"weak": [0, 0]}, ScriptedModel(), max_model_calls=1).optimize("weak", examples(2))
        self.assertEqual(result.stop_reason, "budget_exhausted")
        self.assertEqual(len(result.issues), 1)
        self.assertEqual(result.rounds[0].issue_ids, (result.issues[0].id,))
        self.assertEqual(result.score, 0)

    def test_multisegment_combinations_find_best_with_seeded_sampling(self):
        for seed in (1, 7, 42):
            with self.subTest(seed=seed):
                model = ScriptedModel(propose=proposal("weak", "A B"), segment={"segments": ["A ", "B"]},
                    paraphrase=lambda request: {"candidates": ["X "] if request.payload["segment_index"] == 0 else ["Y"]})
                result = task_optimizer({"weak": [0], "A B": [0.2], "X B": [0.3], "A Y": [0.4], "X Y": [0.8]},
                    model, max_rounds=1, max_trials=10, seed=seed).optimize("weak", examples(1))
                self.assertEqual(result.prompt, "X Y")
                self.assertEqual(len(result.trials), 4)
                self.assertEqual({trial.edit.new_text for trial in result.trials}, {"A B", "X B", "A Y", "X Y"})

    def test_composed_text_deduplication_across_different_picks(self):
        model = ScriptedModel(propose=proposal("weak", "abc"), segment={"segments": ["a", "bc"]},
            paraphrase=lambda request: {"candidates": ["ab"] if request.payload["segment_index"] == 0 else ["c"]})
        result = task_optimizer({"weak": [0], "abc": [0.1], "abbc": [0.5], "ac": [0.4]}, model,
            max_rounds=1, max_trials=10).optimize("weak", examples(1))
        self.assertEqual(result.prompt, "abbc")
        self.assertEqual(len(result.trials), 3)
        self.assertEqual(result.stats.prediction_calls, 4)

    def test_evaluator_error_record_cannot_be_automatically_accepted(self):
        optimizer = Optimizer(model=ScriptedModel(propose=proposal("weak", "strong")),
            predict=lambda prompt, inputs: prompt,
            evaluate=lambda example, prediction: Evaluation(0) if prediction == "weak" else Evaluation(1, error="invalid output"),
            config=OptimizerConfig(max_trials=1))
        result = optimizer.optimize("weak", examples(1))
        self.assertEqual(result.prompt, "weak")
        self.assertIn("evaluation error", result.trials[0].rejection_reason)


class DataContractTests(unittest.TestCase):
    def test_score_validation(self):
        for value in (math.nan, math.inf, -0.1, 1.1, True, "1"):
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                Evaluation(value)

    def test_non_json_payload_and_invalid_weight_rejected(self):
        for payload in (object(), {1: "x"}, [math.nan], (1, 2)):
            with self.subTest(payload=payload), self.assertRaises(TypeError):
                Example("x", payload)
        for weight in (0, -1, math.inf, True):
            with self.assertRaises((ValueError, TypeError)):
                Example("x", "text", weight=weight)

    def test_edit_is_bound_to_exact_unicode_prompt_and_position(self):
        edit = PromptEdit.from_text(id="edit", prompt="中文 weak 文本", old_text="weak", new_text="好")
        self.assertEqual((edit.start, edit.end), (3, 7))
        self.assertEqual(edit.apply("中文 weak 文本"), "中文 好 文本")
        with self.assertRaises(ValueError):
            edit.apply("中文 weak 文本!")
        with self.assertRaises(ValueError):
            replace(edit, start=-1).apply("中文 weak 文本")
        with self.assertRaises(ValueError):
            PromptEdit.from_text(id="edit", prompt="aaa", old_text="aa", new_text="x")

    def test_config_limits(self):
        for kwargs in ({"max_trials": 0}, {"max_rounds": True}, {"max_score_drop": -1}, {"seed": "42"}):
            with self.assertRaises((ValueError, TypeError)):
                OptimizerConfig(**kwargs)

    def test_result_format_version_rejected(self):
        with self.assertRaisesRegex(ValueError, "format"):
            OptimizationResult.from_dict({"format": "annobio.optimization", "format_version": 2})


if __name__ == "__main__":
    unittest.main()
