"""Behavioral coverage of the original staged workflow, separate from auto optimization."""
from dataclasses import replace
import ast
import json
from pathlib import Path
import random
import re
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock

from annobio_optimize import (
    Evaluation, Example, Observation, Optimizer, PromptEdit, ReviewConfig, ReviewResult,
    ReviewSearchConfig, ReviewSession, ReviewStopped,
)
from annobio_optimize.original import find_segment, paragraph_around, sample_beta

REFERENCE_REPO = Path(__file__).resolve().parents[2]
HAS_REFERENCE = (REFERENCE_REPO / "app/src/reviewSuggestionOptimization.js").is_file()


def issue():
    return {"card_title": "Incomplete output", "issue_summary": "Missing an item", "rough_modification_opinion": "Include all items",
            "problem_category_hint": "coverage", "gt_suspect_note": ""}


def edit(old="weak", new="better"):
    return {"prompt_edits": [{"name": "Improve coverage", "phase1_addresses": ["Missing an item"],
        "old_sentence": old, "new_sentence": new, "reason": "Fix missing items"}]}


class Model:
    def __init__(self, *, proposals=None, segments=None, candidates=None, clusters=None):
        self.proposals = proposals or edit()
        self.segments = segments or {"segments": ["better"]}
        self.candidates = candidates if candidates is not None else {"candidates": []}
        self.clusters = clusters
        self.calls = []

    def __call__(self, request):
        self.calls.append(request)
        if request.stage == "diagnose":
            return issue()
        response = {"propose": self.proposals, "segment": self.segments,
                    "paraphrase": self.candidates, "cluster": self.clusters}[request.stage]
        if callable(response):
            return response(request)
        if isinstance(response, list):
            return response.pop(0)
        if response is None:
            raise AssertionError(f"Unexpected {request.stage}")
        return response


def make_review(scores, *, model=None, config=None, observations=None):
    examples = [Example(f"s-{index}", index) for index in range(len(scores["weak"]))]
    def evaluate(example, prediction):
        value = scores[prediction["prompt"]][prediction["index"]]
        return value if isinstance(value, Evaluation) else Evaluation(value)
    optimizer = Optimizer(model=model or Model(), predict=lambda prompt, inputs: {"prompt": prompt, "index": inputs},
                          evaluate=evaluate)
    return optimizer.review("weak", examples, config=config, observations=observations)


class ReviewTests(unittest.TestCase):
    def test_staged_verify_search_accept_revert_keeps_source(self):
        review = make_review({"weak": [0, 1], "better": [0.5, 1], "best": [1, 1]},
            model=Model(candidates={"candidates": ["best"]}))
        source = review.analyze()[0]
        self.assertEqual(review.prompt, "weak")
        verify = review.verify(source.id)
        self.assertEqual(verify.example_ids, ("s-0",))
        self.assertFalse(verify.full_pass)
        result = review.search(source.id)
        self.assertEqual(result.best_text, "best")
        self.assertEqual(result.example_ids, ("s-0", "s-1"))
        self.assertEqual(review.prompt, "weak")
        self.assertEqual(len(review.suggestions), 2)
        optimized = review.suggestions[-1]
        self.assertEqual(optimized.optimized_from_id, source.id)
        self.assertEqual(review.suggestions[0], source)
        self.assertFalse(review.can_accept(source.id))  # Search did not overwrite source verification.
        self.assertFalse(review.can_accept(optimized.id))  # New suggestion needs its OWN verification.
        self.assertTrue(review.verify(optimized.id).full_pass)
        self.assertEqual(review.accept(optimized.id, require_verified=True), "best")
        self.assertEqual(review.revert(optimized.id), "weak")
        self.assertEqual(review.applied_ids, ())

    def test_manual_accept_without_full_pass_and_explicit_agent_gate(self):
        review = make_review({"weak": [0], "better": [0.5]})
        suggestion = review.analyze()[0]
        with self.assertRaisesRegex(ValueError, "verification"):
            review.accept(suggestion.id, require_verified=True)
        self.assertEqual(review.accept(suggestion.id), "better")
        self.assertEqual(review.reject(suggestion.id), "weak")

    def test_full_pass_verify_does_not_automatically_search_or_apply(self):
        model = Model()
        review = make_review({"weak": [0], "better": [1]}, model=model)
        suggestion = review.analyze()[0]
        self.assertTrue(review.verify(suggestion.id).full_pass)
        self.assertEqual([request.stage for request in model.calls], ["diagnose", "propose"])
        self.assertEqual(review.prompt, "weak")

    def test_original_search_uses_uniform_priors_not_previous_verify(self):
        review = make_review({"weak": [0], "better": [0.5]})
        suggestion = review.analyze()[0]
        review.verify(suggestion.id)
        result = review.search(suggestion.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(len(result.trials), 4)
        self.assertEqual(result.trials[0].alpha, ((1.0,),))
        self.assertEqual(result.trials[0].beta, ((2.0,),))
        self.assertEqual(result.best_rate, 0.0)
        self.assertEqual(review.snapshot().stats.prediction_calls, 6)  # baseline + Verify + FOUR new predictions

    def test_original_repeats_combinations_and_records_failed_trials(self):
        calls = 0
        def predict(prompt, inputs):
            nonlocal calls
            calls += 1
            if prompt == "better" and calls % 2 == 0:
                raise ConnectionError("temporary error")
            return 0.0
        review = ReviewSession(model=Model(), predict=predict, evaluate=lambda e, p: p,
                              prompt="weak", examples=[Example("x", 0)])
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(len(result.trials), 4)
        self.assertEqual([trial.ok for trial in result.trials], [False, True, False, True])
        self.assertEqual(result.trials[0].beta, ((2.0,),))
        self.assertEqual(result.trials[-1].beta, ((5.0,),))
        self.assertEqual(result.status, "complete")

    def test_matched_total_counts_preserve_extraction_row_pass_rate(self):
        scores = {"weak": [Evaluation(0, matched_count=0, total_count=2), Evaluation(1, matched_count=8, total_count=8)],
                  "better": [Evaluation(0.5, matched_count=1, total_count=2), Evaluation(1, matched_count=8, total_count=8)]}
        review = make_review(scores)
        source = review.analyze()[0]
        verification = review.verify(source.id)
        self.assertEqual((verification.matched_count, verification.total_count), (1, 2))
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.best_rate, 0.9)  # 9/10 comparison rows, NOT 1/2 inputs or mean score .75.
        self.assertEqual(result.trials[0].alpha, ((1.9,),))
        self.assertAlmostEqual(result.trials[0].beta[0][0], 1.1)

    def test_regression_inputs_prefer_passed_then_original_order(self):
        scores = {"weak": [0, 0.4, 1, 1, 1], "better": [0.4, 0.4, 1, 1, 1]}
        review = make_review(scores, config=ReviewConfig(max_failed_examples=1))
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.example_ids, ("s-0", "s-2", "s-3"))
        self.assertEqual(result.regression_example_ids, ("s-2", "s-3"))

    def test_original_reward_does_not_add_regression_penalty(self):
        scores = {"weak": [0, 1], "better": [1, 0]}
        review = make_review(scores)
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.trials[0].reward, 0.5)
        self.assertEqual(result.best_rate, 0.5)
        self.assertIsNotNone(result.optimized_suggestion_id)
        self.assertEqual(review.prompt, "weak")

    def test_original_split_trims_and_continues_on_join_mismatch(self):
        model = Model(proposals=edit(new="almost right"), segments={"segments": ["almost ", "right"]})
        review = make_review({"weak": [0], "almostright": [0]}, model=model)
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.space.segments, ("almost", "right"))
        self.assertEqual(result.trials[0].text, "almostright")
        self.assertTrue(any("continuing" in notice.message for notice in review.snapshot().notices))

    def test_exact_segmentation_remains_available_as_opt_in(self):
        model = Model(proposals=edit(new="almost right"), segments={"segments": ["almost", "right"]})
        review = make_review({"weak": [0], "almost right": [0.5]}, model=model)
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4, text_handling="exact"))
        self.assertEqual(result.space.segments, ("almost right",))

    def test_original_candidate_casefold_and_extra_original_slot(self):
        model = Model(candidates={"candidates": ["X", "x", " Y ", "Z", "W", "ignored"]})
        scores = {"weak": [0], **{text: [0] for text in ("better", "X", "Y", "Z", "W")}}
        review = make_review(scores, model=model)
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.space.candidates, (("better", "X", "Y", "Z", "W"),))
        request = next(request for request in model.calls if request.stage == "paraphrase")
        self.assertEqual(request.payload["num_candidates"], 4)
        self.assertIn("prompt_context", request.payload)

    def test_failed_inputs_diagnosed_in_original_order(self):
        model = Model()
        review = make_review({"weak": [0.8, 0.1, 0.5], "better": [1, 1, 1]}, model=model,
                             config=ReviewConfig(max_failed_examples=2))
        review.analyze()
        diagnoses = [request.payload["example"]["id"] for request in model.calls if request.stage == "diagnose"]
        self.assertEqual(diagnoses, ["s-0", "s-1"])
        self.assertEqual(len(review.suggestions), 1)  # Same edit deduplicated across clusters.

    def test_all_proposals_use_original_prompt_even_after_acceptance(self):
        model = Model(proposals=[edit("weak", "better"), edit("weak", "best")])
        review = make_review({"weak": [0, 0], "better": [1, 0], "best": [0, 1]}, model=model)
        suggestions = review.analyze()
        review.accept(suggestions[0].id)
        review.verify(suggestions[1].id)
        latest = review.snapshot().evaluations[-1]
        self.assertEqual(latest.prompt_id, review.snapshot().verifications[-1].prompt_id)
        self.assertEqual(latest.observations[0].prediction, {"prompt": "best", "index": 1})
        self.assertEqual([r.payload["prompt"] for r in model.calls if r.stage == "propose"], ["weak", "weak"])

    def test_baseline_can_reuse_existing_observations_without_predictions(self):
        review = make_review({"weak": [0], "better": [1]}, observations=[Observation("s-0", "previous-output", Evaluation(0))])
        review.analyze()
        self.assertEqual(review.snapshot().stats.prediction_calls, 0)
        self.assertEqual(review.snapshot().evaluations[0].observations[0].prediction, "previous-output")

    def test_suspected_reference_note_is_not_forwarded_to_clustering_or_proposals(self):
        model = Model(clusters=lambda request: {"clusters": [{"issue_ids": [i["id"] for i in request.payload["issues"]], "label": "one"}]})
        original = model.__call__
        def wrapper(request):
            if request.stage == "diagnose":
                return {**issue(), "gt_suspect_note": "secret-reference-note"}
            return original(request)
        review = ReviewSession(model=wrapper, predict=lambda p, x: 0, evaluate=lambda e, p: 0.0,
            prompt="weak", examples=[Example("x", 0), Example("y", 1)], config=ReviewConfig(cluster_threshold=1))
        review.analyze()
        self.assertEqual(review.snapshot().issues[0].reference_note, "secret-reference-note")
        for request in model.calls:
            self.assertNotIn("secret-reference-note", json.dumps(request.payload))

    def test_whitespace_span_resolution_restores_original_capability(self):
        model = Model(proposals=edit(old="weak instruction", new="better"))
        review = ReviewSession(model=model, predict=lambda p, x: 0, evaluate=lambda e, p: 0.0,
                              prompt="weak\n   instruction", examples=[Example("x", 0)])
        suggestion = review.analyze()[0]
        self.assertEqual(suggestion.edit.old_text, "weak\n   instruction")
        self.assertEqual(review.accept(suggestion.id), "better")
        self.assertEqual(review.revert(suggestion.id), "weak\n   instruction")

    def test_several_independent_accepts_and_non_lifo_revert(self):
        review = ReviewSession(model=Model(), predict=lambda p, x: 0, evaluate=lambda e, p: 0.0,
                              prompt="first second", examples=[Example("x", 0)])
        ids = []
        for old, new in (("first", "one"), ("second", "two")):
            ids.append(review.add_suggestion(PromptEdit.from_text(id="external", prompt="first second",
                old_text=old, new_text=new, target_example_ids=("x",))).id)
        self.assertEqual(review.accept(ids[0]), "one second")
        self.assertEqual(review.accept(ids[1]), "one two")
        self.assertEqual(review.revert(ids[0]), "first two")

    def test_search_does_not_inherit_other_applied_suggestions(self):
        prompts = []
        def predict(prompt, inputs):
            prompts.append(prompt)
            return 0.0
        review = ReviewSession(model=Model(segments={"segments": ["two"]}), predict=predict,
            evaluate=lambda e, p: p, prompt="first second", examples=[Example("x", 0)])
        first = review.add_suggestion(PromptEdit.from_text(id="a", prompt="first second", old_text="first",
            new_text="one", target_example_ids=("x",)))
        second = review.add_suggestion(PromptEdit.from_text(id="b", prompt="first second", old_text="second",
            new_text="two", target_example_ids=("x",)))
        review.accept(first.id)
        review.search(second.id, config=ReviewSearchConfig(max_trials=4))
        self.assertTrue(all(prompt in ("first second", "first two") for prompt in prompts))

    def test_deletion_verifies_and_applies_without_search(self):
        review = ReviewSession(model=Model(), predict=lambda p, x: 1, evaluate=lambda e, p: 1.0,
                              prompt="good bad", examples=[Example("x", 0)])
        suggestion = review.add_suggestion(PromptEdit.from_text(id="a", prompt="good bad", old_text=" bad",
            new_text="", target_example_ids=("x",)))
        self.assertTrue(review.verify(suggestion.id).full_pass)
        with self.assertRaises(ValueError):
            review.search(suggestion.id)
        self.assertEqual(review.accept(suggestion.id), "good")

    def test_search_all_errors_retains_trials_without_new_suggestion(self):
        def predict(prompt, inputs):
            if prompt != "weak":
                raise RuntimeError("offline")
            return 0.0
        review = ReviewSession(model=Model(), predict=predict, evaluate=lambda e, p: p,
                              prompt="weak", examples=[Example("x", 0)])
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.status, "failed")
        self.assertEqual(len(result.trials), 4)
        self.assertIsNone(result.optimized_suggestion_id)
        self.assertEqual(len(review.suggestions), 1)

    def test_verify_errors_are_records_and_clear_automated_acceptability(self):
        calls = 0
        def predict(prompt, inputs):
            nonlocal calls
            calls += 1
            if calls > 2:
                raise ConnectionError("offline")
            return 0.0 if prompt == "weak" else 1.0
        review = ReviewSession(model=Model(), predict=predict, evaluate=lambda e, p: p,
                              prompt="weak", examples=[Example("x", 0)])
        source = review.analyze()[0]
        self.assertTrue(review.verify(source.id).full_pass)
        self.assertTrue(review.can_accept(source.id))
        self.assertEqual(review.verify(source.id).status, "error")
        self.assertFalse(review.can_accept(source.id))

    def test_zero_comparison_rows_never_count_as_full_pass(self):
        review = make_review({"weak": [Evaluation(0, matched_count=0, total_count=0)],
                              "better": [Evaluation(1, matched_count=0, total_count=0)]})
        source = review.analyze()[0]
        verify = review.verify(source.id)
        self.assertEqual(verify.total_count, 0)
        self.assertFalse(verify.full_pass)

    def test_search_budget_cutoff_keeps_partial_history_unapplied(self):
        review = make_review({"weak": [0], "better": [0]}, config=ReviewConfig(max_predictions=3))
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.status, "budget_exhausted")
        self.assertEqual(len(result.trials), 2)
        self.assertIsNone(result.optimized_suggestion_id)
        self.assertEqual(review.prompt, "weak")

    def test_analysis_cancellation_exposes_partial_snapshot(self):
        review = ReviewSession(model=Model(), predict=lambda p, x: 0, evaluate=lambda e, p: 0.0,
            prompt="weak", examples=[Example("x", 0)], is_cancelled=lambda: True)
        with self.assertRaises(ReviewStopped) as caught:
            review.analyze()
        self.assertEqual(caught.exception.reason, "cancelled")
        self.assertEqual(caught.exception.result.prompt, "weak")

    def test_search_cancellation_records_completed_trials_and_no_new_suggestion(self):
        cancelled = False
        def on_event(event):
            nonlocal cancelled
            if event.stage == "search" and "2/" in event.message:
                cancelled = True
        review = ReviewSession(model=Model(), predict=lambda p, x: 0, evaluate=lambda e, p: 0.0,
            prompt="weak", examples=[Example("x", 0)], is_cancelled=lambda: cancelled, on_event=on_event)
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.status, "cancelled")
        self.assertEqual(len(result.trials), 1)
        self.assertEqual(len(review.suggestions), 1)

    def test_optional_dedup_cache_and_full_validation_are_available(self):
        review = make_review({"weak": [0, 1, 1, 1], "better": [0.5, 1, 1, 1]})
        source = review.analyze()[0]
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4,
            validation_scope="all", deduplicate=True, cache_evaluations=True, text_handling="exact"))
        self.assertEqual(result.example_ids, ("s-0", "s-1", "s-2", "s-3"))
        self.assertEqual(len(result.trials), 1)
        self.assertEqual(review.snapshot().stats.prediction_calls, 8)

    def test_snapshot_round_trip_and_mutation_isolation(self):
        review = make_review({"weak": [0], "better": [0.5]})
        source = review.analyze()[0]
        review.verify(source.id)
        review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        review.accept(source.id)
        review.revert(source.id)
        result = review.snapshot()
        restored = ReviewResult.from_json(result.to_json())
        self.assertEqual(restored, result)
        self.assertEqual(restored.to_dict(), result.to_dict())
        result.model_calls[0].request.payload["prompt"] = "mutated"
        self.assertEqual(review.snapshot().model_calls[0].request.payload["prompt"], "weak")

    def test_original_config_clamps_match_app(self):
        config = ReviewSearchConfig(max_trials=1, max_segments=1, candidates_per_segment=1)
        self.assertEqual((config.max_trials, config.max_segments, config.candidates_per_segment), (4, 2, 2))
        config = ReviewSearchConfig(max_trials=1000, max_segments=100, candidates_per_segment=100)
        self.assertEqual((config.max_trials, config.max_segments, config.candidates_per_segment), (200, 8, 8))
        with self.assertRaises(ValueError):
            Evaluation(0.5, matched_count=1)

    def test_cluster_normalization_keeps_valid_members_and_adds_missing_singletons(self):
        model = Model(clusters={"clusters": [{"issue_ids": ["issue-2", "issue-1", "issue-2", "unknown"], "label": "one"}]})
        review = make_review({"weak": [0, 0, 0], "better": [1, 1, 1]}, model=model,
                             config=ReviewConfig(cluster_threshold=1))
        review.analyze()
        self.assertEqual([cluster.issue_ids for cluster in review.snapshot().clusters],
                         [("issue-1", "issue-2"), ("issue-3",)])

    def test_original_cluster_member_index_response_is_supported(self):
        model = Model(clusters={"clusters": [{"member_indices": [1, 0, 1, 300], "group_label": "same"}]})
        review = make_review({"weak": [0, 0, 0], "better": [1, 1, 1]}, model=model,
                             config=ReviewConfig(cluster_threshold=1))
        review.analyze()
        self.assertEqual([cluster.issue_ids for cluster in review.snapshot().clusters],
                         [("issue-1", "issue-2"), ("issue-3",)])

    def test_optional_reward_and_warm_start_do_not_change_original_defaults(self):
        review = make_review({"weak": [0], "better": [0.5]})
        source = review.analyze()[0]
        review.verify(source.id)
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4, reward="score", warm_start=True))
        self.assertEqual(result.trials[0].reward, 0.5)
        self.assertEqual(result.trials[0].alpha, ((1.5,),))
        self.assertEqual(result.trials[0].beta, ((2.5,),))  # Failed direct verify seeded beta +1.

    def test_optional_regression_penalty(self):
        review = make_review({"weak": [0, 1], "better": [1, 0]})
        result = review.search(review.analyze()[0].id, config=ReviewSearchConfig(max_trials=4, penalize_regression=True))
        self.assertEqual(result.trials[0].reward, 0)
        self.assertEqual(result.trials[0].pass_rate, 0.5)

    def test_optional_cache_keys_include_input_subset(self):
        review = make_review({"weak": [0], "better": [0.5]})
        result = review.search(review.analyze()[0].id, config=ReviewSearchConfig(max_trials=4, cache_evaluations=True))
        self.assertEqual(len(result.trials), 4)
        self.assertEqual(review.snapshot().stats.prediction_calls, 2)
        self.assertEqual(review.snapshot().stats.cache_hits, 3)

    def test_optional_fail_fast_raises_task_callback_error(self):
        def predict(prompt, inputs):
            if prompt != "weak":
                raise ConnectionError("offline")
            return 0.0
        review = ReviewSession(model=Model(), predict=predict, evaluate=lambda e, p: p,
            prompt="weak", examples=[Example("x", 0)])
        with self.assertRaisesRegex(ConnectionError, "offline"):
            review.search(review.analyze()[0].id, config=ReviewSearchConfig(continue_on_error=False))
        self.assertEqual(review.snapshot().verifications[-1].status, "error")


@unittest.skipUnless(HAS_REFERENCE, "Live application sources only exist in the full repository")
class OriginalBackendSpanTests(unittest.TestCase):
    def test_live_backend_span_helpers_with_optional_fuzzy_branch_disabled(self):
        from annobio_optimize import spans
        source = (Path(__file__).resolve().parents[2] / "backend/review_pipeline.py").read_text(encoding="utf-8")
        functions = {name for name in vars(spans) if name.startswith("_") and callable(getattr(spans, name))}
        module = ast.parse(source)
        nodes = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in functions]
        namespace = {"re": re, "fuzz": SimpleNamespace(partial_ratio_alignment=lambda *a, **k: None),
                     "utils": SimpleNamespace(default_process=lambda text: text),
                     "_MD_NUMBERED_ITEM_START": re.compile(r"\s*\d+\.\s")}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "live_backend_span_helpers", "exec"), namespace)
        cases = [
            ('Use “exact quotes”.', 'Use "exact quotes".'),
            ("first\r\nsecond", "first\nsecond"),
            ("Read **all** entities—carefully.\n\nOther paragraph.", "Read all entities-carefully."),
            ("A long instruction that continues after this sentence and stops here.\n\nNext paragraph.",
             "A long instruction that continues after this"),
            ("repeat repeat", "repeat"),
            ("nothing in here", "absent statement"),
        ]
        # Calling the copied helper directly checks backend semantics without the
        # wrapper's additional no-dependency whitespace normalization fallback.
        for prompt, old in cases:
            with self.subTest(prompt=prompt), mock.patch.dict("sys.modules", {"rapidfuzz": None}):
                self.assertEqual(spans._resolve_old_sentence_unique(prompt, old),
                                 namespace["_resolve_old_sentence_unique"](prompt, old))


@unittest.skipUnless(shutil.which("node") and HAS_REFERENCE, "JS parity requires Node and the full repository")
class OriginalParityTests(unittest.TestCase):
    """Compare live repository JS functions, not a second reimplementation."""

    def node(self, script):
        repo = Path(__file__).resolve().parents[2]
        result = subprocess.run(["node", "--input-type=module"], cwd=repo, input=script,
                                capture_output=True, text=True, encoding="utf-8", check=True)
        return json.loads(result.stdout)

    def test_live_js_beta_sampler_on_identical_uniform_stream(self):
        seed = random.Random(103)
        uniforms = [seed.random() for _ in range(1000)]
        parameters = [(1, 1), (1.5, 2.5), (0.5, 0.8), (5, 2)]
        js = """
import fs from 'node:fs';
const source = fs.readFileSync('app/src/reviewSuggestionOptimization.js', 'utf8');
const start = source.indexOf('function randomGaussian()');
const end = source.indexOf('function throwIfAborted', start);
const uniforms = UNIFORMS;
let offset = 0;
Math.random = () => uniforms[offset++];
const sample = new Function(source.slice(start, end) + '; return sampleBeta;')();
console.log(JSON.stringify(PARAMETERS.map(([a,b]) => sample(a,b))));
""".replace("UNIFORMS", json.dumps(uniforms)).replace("PARAMETERS", json.dumps(parameters))
        expected = self.node(js)
        stream = iter(uniforms)
        actual = [sample_beta(a, b, lambda: next(stream)) for a, b in parameters]
        for a, b in zip(actual, expected):
            self.assertAlmostEqual(a, b, places=14)

    def test_live_js_input_selection_prioritizes_two_regression_inputs(self):
        js = """
import fs from 'node:fs';
const source = fs.readFileSync('app/src/reviewSuggestionOptimizer.js', 'utf8');
const start = source.indexOf('export function suggestionOptimizationInputs');
const end = source.indexOf('export async function optimizeReviewSuggestion', start);
const fn = new Function('suggestionTargetScoreRowIndices', source.slice(start,end).replace('export ', '') + '; return suggestionOptimizationInputs;')(s => s.targets);
const rows = [false,false,true,true,true].map((matched,i) => ({input_row_index:i,row_index:i,matched}));
const result = fn({targets:[0]}, rows);
console.log(JSON.stringify({inputs:result.entries.map(([i]) => i), extra:result.extraIndices}));
"""
        expected = self.node(js)
        review = make_review({"weak": [0, 0.4, 1, 1, 1], "better": [0.5, 0.4, 1, 1, 1]},
                             config=ReviewConfig(max_failed_examples=1))
        result = review.search(review.analyze()[0].id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual([int(id[2:]) for id in result.example_ids], expected["inputs"])
        self.assertEqual([int(id[2:]) for id in result.regression_example_ids], expected["extra"])

    def test_live_js_text_location_and_paragraph_context(self):
        cases = [("a weak\n  instruction b", "weak instruction"), ("a\n\nweak here\n\nz", "weak"),
                 ("中文 weak 文本", " weak "), ("repeat repeat", "repeat"), ("test", "missing")]
        js = """
import fs from 'node:fs';
const source = fs.readFileSync('app/src/reviewWorkingText.js', 'utf8');
const start = source.indexOf('export function findSegmentInContent');
const end = source.indexOf('export function effectiveNewSentenceForApply', start);
const f = new Function(source.slice(start,end).replaceAll('export function','function') + '; return [findSegmentInContent,paragraphAround];')();
console.log(JSON.stringify(CASES.map(([text,old]) => [f[0](text,old),f[1](text,old)])));
""".replace("CASES", json.dumps(cases))
        expected = self.node(js)
        actual = [[find_segment(text, old), paragraph_around(text, old)] for text, old in cases]
        self.assertEqual(actual, expected)

    def test_live_js_entire_search_loop_on_identical_uniform_stream(self):
        generator = random.Random(103)
        uniforms = [generator.random() for _ in range(10000)]
        rates = {"better": 0.25, "A": 0.5, "B": 0.75, "C": 0.0}
        js = """
import fs from 'node:fs';
import {rebuildWorkingFromApplied} from './app/src/reviewWorkingText.js';
const source = fs.readFileSync('app/src/reviewSuggestionOptimization.js', 'utf8');
const a = source.indexOf('function randomGaussian()');
const b = source.indexOf('function throwIfAborted', a);
const uniforms = UNIFORMS;
let offset = 0;
Math.random = () => uniforms[offset++];
const beta = new Function(source.slice(a,b) + '; return sampleBeta;')();
const start = source.indexOf('export async function runSuggestionOptimizationCompositional');
const body = source.slice(start).replace('export async function', 'async function');
const fakeFetch = async url => ({ok:true,json:async()=>url.endsWith('/segments') ? {segments:['better']} : {candidates:['better','A','B','C']}});
const verify = async ({templateText}) => ({passRate:RATES[templateText],ok:true});
const fn = new Function('API_BASE','fetch','sampleBeta','throwIfAborted','rebuildWorkingFromApplied','runVerifyPassRate','unregisterOptimizationSession',body + '; return runSuggestionOptimizationCompositional;')('',fakeFetch,beta,()=>{},rebuildWorkingFromApplied,verify,()=>{});
const result = await fn({credentialId:'x',oldSentence:'weak',newSentence:'better',maxTrials:4,allSuggestions:[{old_sentence:'weak',new_sentence:'better'}],sugIdx:0,originalText:'weak',inputEntries:[[0,{row:{},gtRows:[]}]],outputSchema:{}});
console.log(JSON.stringify({bestText:result.bestText,bestRate:result.bestObservedRate,trials:result.trialLog.map(t=>({picks:t.picks,rate:t.passRate}))}));
""".replace("UNIFORMS", json.dumps(uniforms)).replace("RATES", json.dumps(rates))
        expected = self.node(js)
        scores = {"weak": [Evaluation(0, matched_count=0, total_count=4)]}
        scores.update({text: [Evaluation(rate, matched_count=int(rate * 4), total_count=4)] for text, rate in rates.items()})
        review = make_review(scores, model=Model(candidates={"candidates": ["better", "A", "B", "C"]}))
        source = review.analyze()[0]
        stream = iter(uniforms)
        review._core.rng = SimpleNamespace(random=lambda: next(stream))
        result = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
        self.assertEqual(result.best_text, expected["bestText"])
        self.assertEqual(result.best_rate, expected["bestRate"])
        self.assertEqual([{"picks": list(t.picks), "rate": t.pass_rate} for t in result.trials], expected["trials"])


if __name__ == "__main__":
    unittest.main()
