"""Invalid inputs fail before model calls; runtime errors identify their callback/data path."""
from dataclasses import replace
from functools import partial
import math
import unittest

from annobio_optimize import (
    AnnoBioError, CallbackContractError, Evaluation, Example, InputTypeError, InputValueError,
    ModelRequest, ModelResponseError, Observation, OptimizationResult, Optimizer, OptimizerConfig,
    PromptEdit, ReviewConfig, ReviewResult, ReviewSearchConfig, ReviewStopped, UnknownSuggestionError,
    ValidationError,
)
from annobio_optimize.types import copy_json


def model(request):
    if request.stage == "diagnose":
        return {"summary": "Wrong", "advice": "Fix", "category": "x", "reference_note": ""}
    if request.stage == "propose":
        return {"old_text": "weak", "new_text": "strong", "rationale": "Fix"}
    if request.stage == "segment":
        return {"segments": ["strong"]}
    if request.stage == "paraphrase":
        return {"candidates": []}
    return {"clusters": []}


def optimizer(**overrides):
    return Optimizer(**{"model": model, "predict": lambda p, x: p,
        "evaluate": lambda e, p: float(p == "strong"), **overrides})


def data():
    return [Example("sample-A", {"text": "data"}, "strong")]


class ArgumentValidationTests(unittest.TestCase):
    def test_invalid_callbacks_are_rejected_during_initialization_without_calls(self):
        calls = []
        for name in ("model", "predict", "evaluate"):
            for value in (None, "fn", {}, 4):
                with self.subTest(name=name, value=value), self.assertRaises(InputTypeError) as caught:
                    optimizer(**{name: value})
                self.assertEqual(caught.exception.path, name)
        self.assertFalse(calls)

    def test_wrong_callback_arity_and_required_keyword_arguments(self):
        for name, fn in (("predict", lambda x: x), ("evaluate", lambda: 1),
                         ("model", lambda x, y: {}), ("predict", lambda *, prompt, inputs: "x")):
            with self.subTest(name=name), self.assertRaisesRegex(InputTypeError, "positional"):
                optimizer(**{name: fn})

    def test_valid_callable_instances_partials_and_variadic_adapters_are_accepted(self):
        class Predictor:
            def __call__(self, prompt, inputs):
                return "strong"
        def evaluate_with_setting(setting, example, prediction):
            return setting
        opt = optimizer(predict=Predictor(), evaluate=partial(evaluate_with_setting, 1.0), model=lambda *args: {})
        self.assertEqual(opt.optimize("weak", data()).score, 1.0)

    def test_async_and_generator_callbacks_are_rejected_before_invocation(self):
        async def async_predict(prompt, inputs):
            return "x"
        def generator_predict(prompt, inputs):
            yield "x"
        class AsyncPredictor:
            async def __call__(self, prompt, inputs):
                return "x"
        for fn in (async_predict, generator_predict, AsyncPredictor()):
            with self.subTest(fn=fn), self.assertRaisesRegex(CallbackContractError, "synchronous"):
                optimizer(predict=fn)

    def test_config_types_fail_at_the_public_boundary(self):
        with self.assertRaisesRegex(InputTypeError, "Optimizer.config"):
            optimizer(config={"max_rounds": 2})
        with self.assertRaisesRegex(InputTypeError, "review.config"):
            optimizer().review("weak", data(), config=OptimizerConfig())
        review = optimizer().review("weak", data())
        with self.assertRaisesRegex(InputTypeError, "search.config"):
            review.search("missing", config=ReviewConfig())

    def test_invalid_examples_and_prompt_never_call_callbacks(self):
        calls = []
        opt = optimizer(predict=lambda p, x: calls.append("predict"), model=lambda req: calls.append("model"))
        cases = [(None, data()), (" ", data()), ("weak", None), ("weak", "data"),
                 ("weak", {"id": "x"}), ("weak", []), ("weak", [{"id": "x"}])]
        for prompt, examples in cases:
            for entry in (opt.optimize, opt.review):
                with self.subTest(prompt=prompt, examples=examples), self.assertRaises(ValidationError):
                    entry(prompt, examples)
        self.assertFalse(calls)

    def test_duplicate_example_error_identifies_both_positions(self):
        with self.assertRaises(InputValueError) as caught:
            optimizer().optimize("weak", [Example("x", 1), Example("x", 2)])
        self.assertEqual(caught.exception.path, "examples[1].id")
        self.assertIn("examples[0].id", str(caught.exception))

    def test_mutated_nested_example_is_revalidated_before_any_calls(self):
        example = Example("x", {"rows": [{"text": "fine"}]})
        example.inputs["rows"][0]["text"] = object()
        with self.assertRaises(InputTypeError) as caught:
            optimizer().optimize("weak", [example])
        self.assertEqual(caught.exception.path, "examples[0].inputs.rows[0].text")

    def test_optional_callback_signatures_checked_before_baseline(self):
        for kwargs in ({"is_cancelled": "no"}, {"is_cancelled": lambda x: False}, {"on_event": False}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValidationError):
                optimizer().optimize("weak", data(), **kwargs)

    def test_string_ids_and_accept_flags_are_checked_before_mutation(self):
        review = optimizer().review("weak", data())
        source = review.analyze()[0]
        for method in (review.verify, review.search, review.accept, review.reject, review.revert, review.can_accept):
            for bad in (source, None, " "):
                with self.subTest(method=method, bad=bad), self.assertRaises(ValidationError):
                    method(bad)
        with self.assertRaisesRegex(InputTypeError, "require_verified"):
            review.accept(source.id, require_verified="false")
        self.assertEqual(review.applied_ids, ())

    def test_unknown_suggestion_reports_valid_ids_and_is_still_key_error(self):
        review = optimizer().review("weak", data())
        source = review.analyze()[0]
        with self.assertRaises(UnknownSuggestionError) as caught:
            review.verify("other-session")
        self.assertIsInstance(caught.exception, KeyError)
        self.assertIn(source.id, str(caught.exception))

    def test_add_suggestion_validates_record_targets_and_prompt(self):
        review = optimizer().review("weak", data())
        with self.assertRaisesRegex(InputTypeError, "add_suggestion.edit"):
            review.add_suggestion({"old_text": "weak"})
        edit = PromptEdit.from_text(id="e", prompt="weak", old_text="weak", new_text="strong", target_example_ids=("unknown",))
        with self.assertRaisesRegex(InputValueError, "target_example_ids"):
            review.add_suggestion(edit)
        self.assertFalse(review.suggestions)

    def test_existing_observation_inputs_report_specific_problems(self):
        bad = ["rows", [{"example_id": "sample-A"}], [Observation("unknown", 1, Evaluation(0))],
               [Observation("sample-A", 1, Evaluation(0))] * 2, []]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(ValidationError) as caught:
                optimizer().review("weak", data(), observations=value)
            self.assertTrue(caught.exception.path.startswith("observations"))


class PayloadValidationTests(unittest.TestCase):
    def test_nested_json_error_gives_path_and_does_not_print_data_values(self):
        with self.assertRaises(InputTypeError) as caught:
            Example("x", {"documents": [{"text": "private-value"}, {"text": object()}]})
        self.assertEqual(caught.exception.path, "Example.inputs.documents[1].text")
        self.assertNotIn("private-value", str(caught.exception))

    def test_circular_payload_gives_validation_error_instead_of_recursion_error(self):
        value = {"rows": []}
        value["rows"].append(value)
        with self.assertRaisesRegex(InputValueError, "circular") as caught:
            Example("x", value)
        self.assertEqual(caught.exception.path, "Example.inputs.rows[0]")

    def test_deep_json_reports_nesting_limit(self):
        value = 0
        for _ in range(110):
            value = [value]
        with self.assertRaisesRegex(InputValueError, "100 levels"):
            Example("x", value)

    def test_shared_objects_are_valid_when_they_do_not_form_a_cycle(self):
        row = {"a": 1}
        self.assertEqual(copy_json([row, row]), [{"a": 1}, {"a": 1}])

    def test_metric_and_count_errors_have_field_paths(self):
        for kwargs, path in (({"score": 2}, "Evaluation.score"),
            ({"score": 0, "metrics": {"f1": math.inf}}, "Evaluation.metrics.f1"),
            ({"score": 0, "matched_count": 3, "total_count": 2}, "Evaluation.matched_count"),
            ({"score": 0, "passed": "yes"}, "Evaluation.passed")):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValidationError) as caught:
                Evaluation(**kwargs)
            self.assertEqual(caught.exception.path, path)

    def test_very_large_numeric_weights_fail_cleanly(self):
        with self.assertRaises(InputValueError):
            Example("x", "data", weight=10 ** 1000)

    def test_single_id_string_is_not_split_into_characters(self):
        with self.assertRaisesRegex(InputTypeError, "one ID"):
            PromptEdit.from_text(id="e", prompt="weak", old_text="weak", new_text="strong", target_example_ids="sample-A")

    def test_prompt_edit_direct_constructor_checks_offsets(self):
        edit = PromptEdit.from_text(id="e", prompt="weak", old_text="weak", new_text="strong")
        for kwargs in ({"start": True}, {"end": 20}, {"target_example_ids": ["x", "x"]}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValidationError):
                replace(edit, **kwargs)
        with self.assertRaisesRegex(InputTypeError, "apply.prompt"):
            edit.apply(None)

    def test_model_request_constructor_checks_stage_and_objects(self):
        for kwargs in ({"stage": "unknown"}, {"payload": []}, {"instruction": None}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValidationError):
                ModelRequest(**{"stage": "diagnose", "instruction": "test", "payload": {}, "response_schema": {}, **kwargs})

    def test_config_errors_identify_the_correct_config_class(self):
        for cls in (OptimizerConfig, ReviewConfig, ReviewSearchConfig):
            with self.assertRaises(ValidationError) as caught:
                cls(**({"seed": "42"} if cls is not ReviewSearchConfig else {"deduplicate": "true"}))
            self.assertTrue(caught.exception.path.startswith(cls.__name__))


class CallbackValidationTests(unittest.TestCase):
    def test_sdk_prediction_object_reports_callback_and_example_id(self):
        with self.assertRaises(CallbackContractError) as caught:
            optimizer(predict=lambda p, x: object()).optimize("weak", data())
        self.assertIn("predict.return", caught.exception.path)
        self.assertIn("sample-A", caught.exception.path)
        self.assertIn("SDK/Pydantic", str(caught.exception))

    def test_bad_evaluator_returns_report_expected_contract(self):
        for value in (None, True, "1", {"score": 1}, math.nan, 1.5):
            with self.subTest(value=value), self.assertRaises(CallbackContractError) as caught:
                optimizer(evaluate=lambda e, p: value).optimize("weak", data())
            self.assertIn("evaluate.return", caught.exception.path)
            self.assertIn("sample-A", caught.exception.path)

    def test_invalid_evaluation_constructed_inside_callback_keeps_context(self):
        def evaluate(e, p):
            return Evaluation(score=4)
        with self.assertRaises(CallbackContractError) as caught:
            optimizer(evaluate=evaluate).optimize("weak", data())
        self.assertIn("sample-A", caught.exception.path)
        self.assertIn("Evaluation.score", caught.exception.path)

    def test_accidentally_returned_coroutine_is_closed_and_explained(self):
        async def work():
            return "strong"
        awaitables = []
        def predict(p, x):
            value = work()
            awaitables.append(value)
            return value
        with self.assertRaisesRegex(CallbackContractError, "awaitable"):
            optimizer(predict=predict).optimize("weak", data())
        self.assertIsNone(awaitables[0].cr_frame)

    def test_cancellation_callback_must_return_bool(self):
        with self.assertRaisesRegex(CallbackContractError, "is_cancelled.return"):
            optimizer().optimize("weak", data(), is_cancelled=lambda: "no")

    def test_progress_callback_must_return_none(self):
        with self.assertRaisesRegex(CallbackContractError, "on_event.return"):
            optimizer().optimize("weak", data(), on_event=lambda event: 1)

    def test_external_callback_exceptions_preserve_type_and_traceback_context(self):
        def predict(p, x):
            raise ConnectionError("network offline")
        with self.assertRaises(ConnectionError) as caught:
            optimizer(predict=predict).optimize("weak", data())
        notes = str(caught.exception) + " ".join(getattr(caught.exception, "__notes__", ()))
        self.assertIn("predict", notes)
        self.assertIn("sample-A", notes)

    def test_review_records_network_error_with_callback_context(self):
        def predict(prompt, inputs):
            if prompt == "strong":
                raise ConnectionError("network offline")
            return prompt
        review = optimizer(predict=predict).review("weak", data())
        result = review.verify(review.analyze()[0].id)
        self.assertEqual(result.status, "error")
        self.assertIn("predict", result.error)
        self.assertIn("sample-A", result.error)

    def test_review_does_not_misclassify_callback_contract_error_as_failed_trial(self):
        opt = optimizer()
        review = opt.review("weak", data())
        source = review.analyze()[0]
        review._core.optimizer.predict = lambda p, x: object()
        with self.assertRaises(CallbackContractError):
            review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertFalse(review.snapshot().searches)

    def test_model_json_parse_and_field_errors_identify_stage(self):
        for response in ("not-json", "[]", {"summary": []}, {}):
            with self.subTest(response=response), self.assertRaises(ModelResponseError) as caught:
                optimizer(model=lambda request: response).optimize("weak", data())
            self.assertIn("stage='diagnose'", caught.exception.path)

    def test_model_sdk_response_requires_explicit_conversion(self):
        with self.assertRaises(CallbackContractError) as caught:
            optimizer(model=lambda request: object()).optimize("weak", data())
        self.assertIn("model.return", caught.exception.path)

    def test_model_deep_json_is_a_response_error_not_a_recursion_traceback(self):
        nested = '{"data":' + '[' * 2000 + '0' + ']' * 2000 + '}'
        with self.assertRaisesRegex(ModelResponseError, "deeply|nesting"):
            optimizer(model=lambda request: nested).optimize("weak", data())

    def test_original_recoverable_model_errors_still_use_notice_fallback(self):
        def broken_segment(request):
            if request.stage == "segment":
                return "not-json"
            return model(request)
        review = optimizer(model=broken_segment, evaluate=lambda e, p: 0.0).review("weak", data())
        result = review.search(review.analyze()[0].id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.status, "complete")
        self.assertTrue(any("stage='segment'" in notice.message for notice in review.snapshot().notices))


class SavedResultValidationTests(unittest.TestCase):
    def test_malformed_json_and_filename_get_a_readable_hint(self):
        for cls in (OptimizationResult, ReviewResult):
            with self.assertRaisesRegex(InputValueError, "filename"):
                cls.from_json("review.json")
            with self.assertRaisesRegex(InputTypeError, "from_json.text"):
                cls.from_json(None)

    def test_wrong_root_and_missing_required_fields(self):
        for cls, format in ((OptimizationResult, "annobio.optimization"), (ReviewResult, "annobio.review")):
            with self.assertRaises(InputTypeError):
                cls.from_dict([])
            with self.assertRaises(InputValueError) as caught:
                cls.from_dict({"format": format, "format_version": 1})
            self.assertTrue(caught.exception.path.startswith(cls.__name__))

    def test_bad_saved_score_points_to_exact_sample(self):
        saved = optimizer().optimize("weak", data()).to_dict()
        saved["evaluations"][0]["observations"][0]["evaluation"]["score"] = 4
        with self.assertRaises(InputValueError) as caught:
            OptimizationResult.from_dict(saved)
        self.assertEqual(caught.exception.path, "OptimizationResult.evaluations[0].observations[0].evaluation.score")

    def test_unknown_config_field_suggests_spelling(self):
        saved = optimizer().optimize("weak", data()).to_dict()
        saved["config"]["max_trial"] = 4
        with self.assertRaisesRegex(InputValueError, "max_trials"):
            OptimizationResult.from_dict(saved)

    def test_broken_result_links_fail_during_loading_not_property_access(self):
        saved = optimizer().optimize("weak", data()).to_dict()
        saved["versions"][-1]["evaluation_id"] = "missing"
        with self.assertRaisesRegex(InputValueError, "unknown record ID"):
            OptimizationResult.from_dict(saved)

    def test_bad_review_collections_do_not_turn_strings_into_tuples(self):
        review = optimizer().review("weak", data())
        review.analyze()
        saved = review.snapshot().to_dict()
        saved["suggestions"][0]["edit"]["target_example_ids"] = "sample-A"
        with self.assertRaisesRegex(InputTypeError, "target_example_ids"):
            ReviewResult.from_dict(saved)

    def test_boolean_format_version_is_not_integer_one(self):
        saved = optimizer().optimize("weak", data()).to_dict()
        saved["format_version"] = True
        with self.assertRaisesRegex(InputValueError, "format_version"):
            OptimizationResult.from_dict(saved)

    def test_deep_saved_json_has_a_readable_error(self):
        with self.assertRaisesRegex(InputValueError, "deeply|nesting"):
            ReviewResult.from_json('{"data":' + '[' * 2000 + '0' + ']' * 2000 + '}')

    def test_stopped_review_is_catchable_as_a_library_error(self):
        with self.assertRaises(AnnoBioError) as caught:
            optimizer().review("weak", data(), is_cancelled=lambda: True).analyze()
        self.assertIsInstance(caught.exception, ReviewStopped)

    def test_dump_reports_corrupted_payload_path_and_bad_indent(self):
        result = optimizer().optimize("weak", data())
        with self.assertRaisesRegex(InputTypeError, "indent"):
            result.to_json(indent="two")
        result.examples[0].inputs["bad"] = object()
        with self.assertRaises(InputTypeError) as caught:
            result.to_json()
        self.assertEqual(caught.exception.path, "OptimizationResult.examples[0].inputs.bad")


if __name__ == "__main__":
    unittest.main()
