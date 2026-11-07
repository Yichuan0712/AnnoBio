"""Offline behavior of the v2 engine (python/ENGINE_V2_DESIGN.md) with a toy task and a scripted model.

Toy task: an input passes when the prompt mentions the word it needs. The initial prompt mentions
"base", so inputs needing "base" pass and the others fail until a card adds their word.
"""
from dataclasses import asdict, replace
import json
import unittest

from annobio_optimize import Evaluation, Example
from annobio_optimize.engine import STYLE_SETTINGS, EngineConfig, Operator, OperatorConfig, Session

PROMPT = "Answer the question. Use base facts."
CFG = EngineConfig(regression_examples=3, cluster_threshold=0)  # cluster even a few issues
NEEDS = ["alpha", "alpha", "beta", "base", "base", "base", "base", "base"]


def examples(needs=NEEDS):
    return [Example(f"e{i}", {"need": need}) for i, need in enumerate(needs)]


def predict(prompt, inputs):
    return {"ok": inputs["need"] in prompt}


def evaluate(example, prediction):
    return Evaluation(1.0 if prediction["ok"] else 0.0)


class Model:
    """Scripted optimization model. `rewrite` maps the stored prompt to the rewritten prompt."""
    def __init__(self, *, rewrite=None, paraphrases=None, propose=None):
        self.rewrite = rewrite or (lambda prompt, needs: prompt + " Mention " + " and ".join(needs) + ".")
        self.paraphrases = paraphrases
        self.propose = propose
        self.calls = []

    def __call__(self, request):
        self.calls.append(request)
        p = request.payload
        if request.stage == "diagnose":
            need = p["example"]["inputs"]["need"]
            return {"card_title": f"Missing {need}", "issue_summary": f"needs {need}",
                    "rough_modification_opinion": f"mention {need}", "problem_category_hint": need,
                    "gt_suspect_note": ""}
        if request.stage == "cluster":
            groups = {}
            for issue in p["issues"]:
                groups.setdefault(issue["category"], []).append(issue["id"])
            return {"clusters": [{"issue_ids": ids, "label": label} for label, ids in groups.items()]}
        if request.stage == "propose":
            need = p["issues"][0]["category"]
            if self.propose:
                return self.propose(p, need)
            return {"prompt_edits": [{"name": f"Add {need}", "phase1_addresses": [f"needs {need}"],
                                      "old_sentence": "Answer the question.",
                                      "new_sentence": f"Answer the question. Mention {need}.", "reason": f"fix {need}"}]}
        if request.stage == "rewrite":
            needs = sorted({issue["category"] for issue in p["issues"]})
            return {"name": "Rewrite", "prompt": self.rewrite(p["prompt"], needs), "reason": "fix all"}
        if request.stage == "segment":
            text = p["new_text"]
            cut = len(text) // 2
            return {"segments": [text[:cut], text[cut:]]}
        if request.stage == "paraphrase":
            if self.paraphrases is not None:
                return {"candidates": self.paraphrases(p)}
            return {"candidates": [p["focus"].upper()]}
        raise AssertionError(request.stage)


def session(model=None, needs=NEEDS, **kwargs):
    return Session(model=model or Model(), predict=predict, evaluate=evaluate, prompt=PROMPT,
                   examples=examples(needs), config=kwargs.pop("config", CFG), **kwargs)


class SessionTests(unittest.TestCase):
    def test_local_cards_are_insertions_verified_on_targets_and_regression_inputs(self):
        s = session()
        cards = s.analyze("local")
        self.assertEqual([c.kind for c in cards], ["insert", "insert"])
        alpha = next(c for c in cards if "alpha" in c.new_text)
        self.assertEqual(alpha.target_example_ids, ("e0", "e1"))
        self.assertEqual(alpha.issue_ids, ("issue-1", "issue-2"))  # traceable to its diagnosis cards
        record = s.verify(alpha.id)
        self.assertEqual(record.fixed_ids, ("e0", "e1"))
        self.assertEqual(len(record.regression_ids), 3)
        self.assertTrue(set(record.regression_ids) <= {"e3", "e4", "e5", "e6", "e7"})
        self.assertEqual(record.lost_ids, ())
        self.assertTrue(record.full_pass)

    def test_identical_proposals_merge_so_no_failed_input_loses_its_card(self):
        # With the app's default (no clustering at <= 5 issues) e0 and e1 each get the same edit.
        s = session(config=EngineConfig(regression_examples=3))
        cards = s.analyze("local")
        alpha = next(c for c in cards if "alpha" in c.new_text)
        self.assertEqual(s.card(alpha.id).target_example_ids, ("e0", "e1"))
        self.assertEqual(s.card(alpha.id).issue_ids, ("issue-1", "issue-2"))

    def test_accept_revert_and_apply_rebuild_from_the_source(self):
        s = session()
        a, b = s.analyze("local")
        s.accept(a.id)
        s.accept(b.id)
        self.assertIn("alpha", s.apply())
        self.assertIn("beta", s.apply())
        s.revert(a.id)
        self.assertNotIn(a.new_text.split(". ")[-1], s.apply())
        self.assertEqual(s.source, PROMPT)  # the source never changes inside a session

    def test_rewrite_card_replaces_the_whole_prompt(self):
        s = session()
        (card,) = s.analyze("rewrite")
        self.assertEqual((card.kind, card.old_text, card.start, card.end), ("rewrite", PROMPT, 0, len(PROMPT)))
        self.assertEqual(card.target_example_ids, ("e0", "e1", "e2"))
        self.assertEqual(s.verify(card.id).fixed_ids, ("e0", "e1", "e2"))

    def test_regression_is_detected(self):
        model = Model(rewrite=lambda prompt, needs: "Answer the question. Mention " + " and ".join(needs) + ".")
        s = session(model)
        (card,) = s.analyze("rewrite")
        record = s.verify(card.id)
        self.assertEqual(record.fixed_ids, ("e0", "e1", "e2"))
        self.assertEqual(len(record.lost_ids), 3)  # "base" dropped: every regression input fails
        self.assertEqual(s.reward(record), 0.0)

    def test_demos_card_is_never_verified_on_the_examples_it_shows(self):
        def with_demos(prompt, shown):
            return prompt + "\n\nWORKED_EXAMPLES\n" + "\n".join(json.dumps(e.inputs) for e in shown)
        s = session(with_demos=with_demos)
        card = s.propose_demos(1)
        self.assertEqual(card.kind, "demos")
        self.assertEqual(len(card.demo_example_ids), 1)
        self.assertNotIn(card.demo_example_ids[0], card.target_example_ids)
        self.assertEqual(card.apply(PROMPT), with_demos(PROMPT, [examples()[int(card.demo_example_ids[0][1:])]]))
        record = s.verify(card.id)
        self.assertNotIn(card.demo_example_ids[0], record.target_ids + record.regression_ids)

    def test_search_keeps_the_insert_anchor_and_creates_an_optimized_card(self):
        # Upper-cased paraphrases lose the needed word, so the original segments win.
        s = session()
        card = s.analyze("local")[0]
        result = s.search(card.id)
        self.assertEqual(result.status, "complete")
        new = s.card(result.optimized_card_id)
        self.assertEqual(new.optimized_from, card.id)
        self.assertTrue(new.new_text.startswith(card.old_text))
        self.assertEqual(s.latest_check(new.id).fixed_ids, card.target_example_ids)
        self.assertEqual(result.best_reward, 1.0)
        self.assertEqual(len({t.text for t in result.trials}), len(result.trials))  # no repeated combination

    def test_search_reward_penalizes_regression(self):
        # A paraphrase that drops "base" fixes the targets but breaks the regression inputs.
        def propose(p, need):
            return {"prompt_edits": [{"name": "x", "phase1_addresses": ["y"], "old_sentence": "Use base facts.",
                                      "new_sentence": f"Use base facts and {need}.", "reason": "r"}]}
        s = session(Model(propose=propose, paraphrases=lambda p: [p["focus"].replace("base", "core")]))
        card = s.analyze("local")[0]
        result = s.search(card.id)
        best = s.card(result.optimized_card_id)
        self.assertIn("base", best.new_text)
        self.assertTrue(any(t.reward < 1.0 for t in result.trials) or len(result.trials) == 1)

    def test_snapshot_is_json_and_history_reports_outcomes(self):
        s = session()
        a, _ = s.analyze("local")
        s.verify(a.id)
        s.accept(a.id)
        snap = s.snapshot()
        json.dumps(snap)
        (item,) = s.history_items()
        self.assertEqual((item.targets, item.fixed, item.lost, item.accepted), (2, 2, 0, True))

    def test_history_reaches_the_next_proposal(self):
        s = session()
        a, _ = s.analyze("local")
        s.verify(a.id)
        model = Model()
        later = session(model, history=s.history_items())
        later.analyze("local")
        propose = next(r for r in model.calls if r.stage == "propose")
        self.assertEqual(propose.payload["history"][0]["fixed"], 2)


class RobustnessTests(unittest.TestCase):
    def test_a_host_stop_exception_is_not_recorded_as_a_check_error(self):
        class Budget(Exception):
            pass
        calls = {"n": 0}

        def limited(prompt, inputs):
            calls["n"] += 1
            if calls["n"] > len(NEEDS):  # the baseline fits, the first verification does not
                raise Budget()
            return predict(prompt, inputs)
        s = Session(model=Model(), predict=limited, evaluate=evaluate, prompt=PROMPT, examples=examples(),
                    config=CFG, stop_on=(Budget,))
        card = s.analyze("local")[0]
        with self.assertRaises(Budget):
            s.verify(card.id)
        # Without stop_on the same failure is an ordinary check error, as in the app.
        calls["n"] = 0
        s = Session(model=Model(), predict=limited, evaluate=evaluate, prompt=PROMPT, examples=examples(), config=CFG)
        card = s.analyze("local")[0]
        self.assertEqual(s.verify(card.id).status, "error")

    def test_a_malformed_diagnosis_skips_that_input(self):
        model = Model()
        inner = model.__call__

        def flaky(request):
            if request.stage == "diagnose" and request.payload["example"]["id"] == "e0":
                return "not json"
            return inner(request)
        s = Session(model=flaky, predict=predict, evaluate=evaluate, prompt=PROMPT, examples=examples(), config=CFG)
        self.assertEqual([i.example_id for i in s.diagnose()], ["e1", "e2"])
        self.assertTrue(any(n.stage == "diagnose" for n in s.notices))

    def test_evidence_is_bounded(self):
        model = Model()
        s = Session(model=model, predict=predict, evaluate=evaluate, prompt=PROMPT,
                    examples=examples(["alpha"] * 6 + ["base"] * 2),
                    config=EngineConfig(regression_examples=2, cluster_threshold=0, max_evidence_examples=2))
        s.analyze("rewrite")
        rewrite = next(r for r in model.calls if r.stage == "rewrite")
        self.assertEqual(len(rewrite.payload["issues"]), 6)
        self.assertEqual(len(rewrite.payload["observations"]), 2)


class PartialCreditTests(unittest.TestCase):
    """Like BioRED's per-document F1: an input scores the fraction of its needed words in the prompt."""
    def test_partial_improvements_count_and_regression_inputs_are_the_best_scored(self):
        needs = [["alpha", "beta"], ["alpha", "gamma"], ["alpha", "delta"], ["base", "zeta"], ["base", "eta"]] + [["base"]] * 3

        def partial_predict(prompt, inputs):
            return {"share": sum(w in prompt for w in inputs["need"]) / len(inputs["need"])}

        def partial_evaluate(example, prediction):
            return Evaluation(prediction["share"])

        def propose(p, need):
            return {"prompt_edits": [{"name": "x", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                                      "new_sentence": "Answer the question. Mention alpha.", "reason": "r"}]}
        model = Model(propose=propose)
        model_diag = model.__call__

        def scripted(request):  # diagnoses name the first missing word as the category
            if request.stage == "diagnose":
                need = next(w for w in request.payload["example"]["inputs"]["need"] if w not in request.payload["prompt"])
                return {"card_title": need, "issue_summary": f"needs {need}", "rough_modification_opinion": need,
                        "problem_category_hint": "words", "gt_suspect_note": ""}
            return model_diag(request)
        exs = [Example(f"e{i}", {"need": n}) for i, n in enumerate(needs)]
        s = Session(model=scripted, predict=partial_predict, evaluate=partial_evaluate, prompt=PROMPT, examples=exs,
                    config=EngineConfig(regression_examples=3, cluster_threshold=0))
        (card,) = s.analyze("local")
        record = s.verify(card.id)
        self.assertEqual(record.fixed_ids, ())             # no input becomes fully correct ...
        self.assertAlmostEqual(record.target_gain, 1.5)    # ... but e0-e2 each gain half a point
        self.assertEqual(set(record.regression_ids), {"e5", "e6", "e7"})  # the fully correct ones, not e3/e4
        op = Operator(model=scripted, predict=partial_predict, evaluate=partial_evaluate,
                      config=EngineConfig(regression_examples=3, cluster_threshold=0),
                      operator=OperatorConfig(schedule="fine_only", min_gain=1.0))
        first = op.run(PROMPT, [exs]).rounds[0]
        self.assertTrue(first.committed)
        self.assertAlmostEqual(first.gain, 1.5)


class OperatorTests(unittest.TestCase):
    def batches(self, n=4):
        return [examples() for _ in range(n)]

    def test_a_beneficial_rewrite_is_committed_in_the_coarse_phase(self):
        rounds = []
        op = Operator(model=Model(), predict=predict, evaluate=evaluate,
                      config=CFG, on_round=lambda p, r: rounds.append(r),
                      operator=OperatorConfig(schedule="coarse_to_fine"))
        result = op.run(PROMPT, self.batches(2))
        self.assertTrue(result.rounds[0].committed)
        self.assertEqual(result.rounds[0].phase, "coarse")
        for need in ("alpha", "beta", "base"):
            self.assertIn(need, result.prompt)
        self.assertEqual(result.rounds[1].reason, "no failed inputs in this batch")
        self.assertEqual(len(rounds), 2)

    def test_the_initial_prompt_stays_when_nothing_beats_it(self):
        # Every rewrite drops "base" and every local edit breaks it: nothing may be committed.
        def propose(p, need):
            return {"prompt_edits": [{"name": "x", "phase1_addresses": ["y"], "old_sentence": "Use base facts.",
                                      "new_sentence": f"Use {need} facts.", "reason": "r"}]}
        model = Model(rewrite=lambda prompt, needs: "Answer. Mention " + " ".join(needs) + ".",
                      propose=propose, paraphrases=lambda p: [])
        op = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG,
                      operator=OperatorConfig(schedule="coarse_to_fine", coarse_patience=1))
        result = op.run(PROMPT, self.batches(3))
        self.assertEqual(result.prompt, PROMPT)
        self.assertFalse(any(r.committed for r in result.rounds))
        self.assertEqual([r.phase for r in result.rounds], ["coarse", "fine", "fine"])  # switched after patience 1

    def test_schedules(self):
        never = Model(rewrite=lambda prompt, needs: "Answer. Mention " + " ".join(needs) + ".")
        fine = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                        operator=OperatorConfig(schedule="fine_only"))
        self.assertEqual(fine.run(PROMPT, self.batches(1)).rounds[0].phase, "fine")
        coarse = Operator(model=never, predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="coarse_only", coarse_patience=1))
        self.assertEqual({r.phase for r in coarse.run(PROMPT, self.batches(3)).rounds}, {"coarse"})

    def test_fine_phase_commits_local_cards(self):
        op = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                      operator=OperatorConfig(schedule="fine_only"))
        result = op.run(PROMPT, self.batches(1))
        self.assertTrue(result.rounds[0].committed)
        self.assertEqual(len(result.rounds[0].accepted_card_ids), 2)
        self.assertEqual(result.rounds[0].gain, 3.0)
        self.assertIn("alpha", result.prompt)
        self.assertIn("beta", result.prompt)

    def test_noise_margin_blocks_a_one_item_gain(self):
        op = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                      operator=OperatorConfig(schedule="fine_only", min_gain=4.0))
        result = op.run(PROMPT, self.batches(1))
        self.assertFalse(result.rounds[0].committed)  # +3 items is inside a margin of 4
        self.assertEqual(result.prompt, PROMPT)

    def test_demos_card_is_proposed_until_accepted(self):
        def with_demos(prompt, shown):
            return prompt + "\n\nWORKED_EXAMPLES\n" + " ".join(e.inputs["need"] for e in shown)
        op = Operator(model=Model(rewrite=lambda prompt, needs: prompt), predict=predict, evaluate=evaluate,
                      config=CFG, with_demos=with_demos,
                      operator=OperatorConfig(schedule="coarse_only", demos_cap=2))
        result = op.run(PROMPT, self.batches(1))
        self.assertTrue(result.rounds[0].committed)
        self.assertIn("WORKED_EXAMPLES", result.prompt)

    def test_compete_proposes_both_kinds_and_the_shorter_equal_option_wins(self):
        # Both the rewrite and the two localized cards fix all three failures (+3); the rewrite is shorter.
        op = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG)
        first = op.run(PROMPT, self.batches(1)).rounds[0]
        self.assertEqual((first.phase, first.committed, first.chosen), ("both", True, "rewrite"))
        self.assertEqual({o["name"] for o in first.options}, {"localized", "best_localized", "rewrite"})
        self.assertEqual(first.gain, 3.0)

    def test_compete_uses_localized_cards_when_the_rewrite_breaks_inputs(self):
        model = Model(rewrite=lambda prompt, needs: "Answer the question. Mention " + " and ".join(needs) + ".")
        op = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG)
        first = op.run(PROMPT, self.batches(1)).rounds[0]
        self.assertEqual((first.committed, first.chosen), (True, "localized"))
        self.assertNotIn("rewrite", {o["name"] for o in first.options})  # it failed verification

    def test_compete_late_rewrites_only_when_stalled(self):
        # Past the early budget share, a rewrite is proposed only after coarse_patience idle rounds.
        def propose(p, need):
            return {"prompt_edits": [{"name": "x", "phase1_addresses": ["y"], "old_sentence": "Use base facts.",
                                      "new_sentence": f"Use {need} facts.", "reason": "r"}]}
        model = Model(rewrite=lambda prompt, needs: "Answer. Mention " + " ".join(needs) + ".",
                      propose=propose, paraphrases=lambda p: [])
        op = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG, budget_fraction=lambda: 1.0,
                      operator=OperatorConfig(coarse_patience=1))
        result = op.run(PROMPT, self.batches(4))
        self.assertEqual([r.phase for r in result.rounds], ["fine", "both", "fine", "both"])
        self.assertEqual(result.prompt, PROMPT)

    def test_several_directions_per_cluster_one_card_each_in_the_combined_option(self):
        def propose(p, need):
            return {"prompt_edits": [
                {"name": "wrong", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                 "new_sentence": "Answer the question. Mention gamma.", "reason": "r"},
                {"name": "right", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                 "new_sentence": f"Answer the question. Mention {need}.", "reason": "r"},
                {"name": "also right", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                 "new_sentence": f"Answer the question. Always mention {need}.", "reason": "r"},
                {"name": "beyond the limit", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                 "new_sentence": "Answer the question. Mention delta.", "reason": "r"}]}
        model = Model(propose=propose)
        config = EngineConfig(regression_examples=3, cluster_threshold=0, proposals_per_cluster=3)
        op = Operator(model=model, predict=predict, evaluate=evaluate, config=config,
                      operator=OperatorConfig(schedule="fine_only"))
        first = op.run(PROMPT, [examples()]).rounds[0]
        request = next(r for r in model.calls if r.stage == "propose")
        self.assertEqual(request.payload["num_edits"], 3)
        self.assertIn("DIFFERENT approach", request.instruction)
        self.assertEqual(request.response_schema["properties"]["prompt_edits"]["maxItems"], 3)
        # 3 directions x 2 clusters, the 4th reply ignored; both clusters' identical "gamma" edit merges into one card.
        self.assertEqual(first.cards, 5)
        self.assertEqual((first.committed, first.chosen, len(first.accepted_card_ids)), (True, "localized", 2))
        # Each cluster already had a passing card, so the failing "gamma" cards were not searched.
        self.assertFalse(any(r.stage == "segment" for r in model.calls))

    def test_search_only_promising_drops_cards_that_moved_nothing(self):
        def propose(p, need):
            return {"prompt_edits": [{"name": "wrong", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                                      "new_sentence": "Answer the question. Mention gamma.", "reason": "r"}]}
        for promising, searched in ((False, True), (True, False)):
            model = Model(propose=propose)
            op = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", search_only_promising=promising))
            op.run(PROMPT, [examples()])
            self.assertEqual(any(r.stage == "segment" for r in model.calls), searched)

    def test_finished_sessions_survive_a_host_stop(self):
        class Budget(Exception):
            pass
        calls = {"n": 0}

        def limited(prompt, inputs):
            calls["n"] += 1
            if calls["n"] > 60:
                raise Budget()
            return predict(prompt, inputs)
        op = Operator(model=Model(), predict=limited, evaluate=evaluate, config=CFG, stop_on=(Budget,),
                      operator=OperatorConfig(schedule="fine_only"))
        with self.assertRaises(Budget):
            op.run(PROMPT, self.batches(10))
        self.assertGreaterEqual(len(op.result.sessions), 1)  # including the session the stop interrupted
        self.assertTrue(op.result.sessions[0]["cards"])

    def test_held_out_gate_rejects_a_change_that_only_fixes_the_diagnosed_batch(self):
        # Batch 1 fails on "alpha"; batch 2 (the gate) has no "alpha" inputs, so adding alpha gains nothing there.
        first = examples(["alpha", "alpha", "alpha", "base", "base", "base", "base", "base"])
        second = [Example(f"g{i}", {"need": "base"}) for i in range(8)]
        config = EngineConfig(regression_examples=3, cluster_threshold=0)
        held_out = Operator(model=Model(), predict=predict, evaluate=evaluate, config=config,
                            operator=OperatorConfig(schedule="fine_only", min_gain=1.0)).run(PROMPT, [first, second])
        self.assertFalse(held_out.rounds[0].committed)
        self.assertEqual(held_out.rounds[0].gate, "next")
        self.assertIn("held-out next batch", held_out.rounds[0].reason)
        self.assertEqual(held_out.sessions[0]["gate"]["examples"], [e.id for e in second])
        same = Operator(model=Model(), predict=predict, evaluate=evaluate, config=config,
                        operator=OperatorConfig(schedule="fine_only", min_gain=1.0, gate="same")).run(PROMPT, [first, second])
        self.assertTrue(same.rounds[0].committed)  # in-sample: the fixed targets count as gain

    def test_the_gate_batch_predictions_are_reused_by_the_next_round(self):
        calls = {"n": 0}

        def counting(prompt, inputs):
            calls["n"] += 1
            return predict(prompt, inputs)
        batches = [examples(), [Example(f"x{i}", {"need": n}) for i, n in enumerate(NEEDS)]]
        result = Operator(model=Model(), predict=counting, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only")).run(PROMPT, batches)
        second = result.sessions[1]
        # Round 2 starts from the observations its batch got as round 1's gate: no new baseline run.
        self.assertEqual(second["evaluations"][0]["prompt_id"], result.rounds[0].end_prompt_id)
        self.assertEqual(second["predictions"], sum(len(c["target_ids"]) + len(c["regression_ids"])
                                                    for c in second["checks"] if c["status"] == "complete")
                         + sum(len(e["observations"]) for e in second["evaluations"][1:]
                               if e["prompt_id"] not in {c["prompt_id"] for c in second["checks"]}))

    def test_the_gate_can_pool_several_following_batches(self):
        batches = [examples(), [Example(f"x{i}", {"need": n}) for i, n in enumerate(NEEDS)],
                   [Example(f"y{i}", {"need": n}) for i, n in enumerate(NEEDS)]]
        result = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", gate_batches=2)).run(PROMPT, batches, max_rounds=1)
        self.assertEqual(len(result.rounds), 1)
        self.assertEqual(result.sessions[0]["gate"]["examples"], [e.id for e in batches[1] + batches[2]])
        # A repeat of the diagnosed batch never enters its own gate.
        repeat = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", gate_batches=2)).run(
            PROMPT, [batches[0], batches[1], batches[0]], max_rounds=1)
        self.assertEqual(repeat.sessions[0]["gate"]["examples"], [e.id for e in batches[1]])

    def test_after_a_commit_later_gates_skip_the_inputs_that_selected_the_incumbent(self):
        # Predictions are reused per (prompt, input): on the inputs that made it win, the new
        # incumbent keeps its lucky draws, so the next gate reads further batches instead.
        batches = [examples()] + [[Example(f"{tag}{i}", {"need": n}) for i, n in enumerate(NEEDS)]
                                  for tag in ("x", "y", "z", "w")]
        result = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", gate_batches=2)).run(PROMPT, batches, max_rounds=2)
        self.assertTrue(result.rounds[0].committed)
        self.assertEqual(result.sessions[0]["gate"]["examples"], [e.id for e in batches[1] + batches[2]])
        self.assertEqual(result.sessions[1]["gate"]["examples"], [e.id for e in batches[3] + batches[4]])

    def test_a_rejected_option_becomes_the_incumbent_once_its_evidence_accumulates(self):
        # Each batch has one "alpha" input, so adding alpha gains +1 per 8-input gate: below min_gain 1.5
        # every time, but kept as a challenger it gains +1, +2, +3 on fresh inputs, and +3 clears
        # 1.5 x sqrt(3) = 2.6 on the third gate after its entry.
        batches = [[Example(f"b{k}a", {"need": "alpha"})] + [Example(f"b{k}x{i}", {"need": "base"}) for i in range(7)]
                   for k in range(6)]
        settings = dict(schedule="fine_only", min_gain=1.5)
        plain = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                         operator=OperatorConfig(**settings)).run(PROMPT, batches, max_rounds=4)
        self.assertFalse(any(r.committed for r in plain.rounds))
        kept = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                        operator=OperatorConfig(**settings, challengers=2)).run(PROMPT, batches, max_rounds=4)
        self.assertEqual([r.committed for r in kept.rounds], [False, False, False, True])
        self.assertEqual(kept.rounds[3].chosen, "challenger round 0 localized")
        self.assertIn("alpha", kept.prompt)
        evidence = [o for o in kept.rounds[2].options if o["name"].startswith("challenger")][0]
        self.assertEqual((evidence["evidence_gain"], evidence["evidence_items"]), (2.0, 16))  # b2, b3; not b1
        # Traceable: the switch names the round-0 card the challenger was built from.
        self.assertEqual(kept.rounds[3].accepted_card_ids, (kept.sessions[0]["cards"][0]["id"],))

    def test_a_challenger_without_a_decision_is_dropped_after_its_evidence_limit(self):
        # Only b0 and b1 need alpha: the alpha option gains +1 on its entry gate (b1), then 0 on b2-b5.
        # After challenger_max_gates (4) gates' worth of fresh inputs it is dropped and no longer run.
        needs = ["alpha", "alpha", "", "", "", "", ""]
        batches = [[Example(f"b{k}a", {"need": needs[k] or "base"})] +
                   [Example(f"b{k}x{i}", {"need": "base"}) for i in range(7)] for k in range(7)]
        result = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", min_gain=1.5, challengers=2)).run(
            PROMPT, batches, max_rounds=6)
        rows = [[o for o in r.options if o["name"].startswith("challenger")] for r in result.rounds]
        self.assertEqual([len(r) for r in rows], [0, 1, 1, 1, 1, 0])
        self.assertEqual([r[0]["evidence_items"] for r in rows[1:5]], [8, 16, 24, 32])
        self.assertFalse(any(r.committed for r in result.rounds))

    def test_challenger_settings_are_checked(self):
        with self.assertRaises(Exception):
            OperatorConfig(challengers=-1)
        with self.assertRaises(Exception):
            OperatorConfig(challenger_max_gates=0)
        with self.assertRaises(Exception):
            OperatorConfig(min_gain=-1.0, challengers=2)  # every gaining option is accepted: nothing to keep
        with self.assertRaises(Exception):
            OperatorConfig(final="first")
        with self.assertRaises(Exception):
            OperatorConfig(max_batch_drop=-1.0)

    def test_a_lenient_gate_accepts_a_small_loss_and_best_seen_hands_over_the_better_version(self):
        # Every batch needs alpha, beta, delta and gamma once (gamma is never fixed, so each round rewrites).
        # The first rewrite adds alpha and beta (+2 on the gate); the second drops delta (-1), which a
        # negative min_gain still accepts. The incumbent ends worse; "best_seen" hands over the first rewrite.
        needs = ["alpha", "beta", "delta", "gamma", "base", "base", "base", "base"]
        batches = [[Example(f"b{k}x{i}", {"need": n}) for i, n in enumerate(needs)] for k in range(3)]
        start = PROMPT + " Use delta."

        def rewrites():
            calls = {"n": 0}

            def rewrite(prompt, _needs):
                calls["n"] += 1
                if calls["n"] == 1:
                    return prompt + " Mention alpha and beta."
                return prompt.replace(" Use delta.", "") + " Mention zeta."
            return rewrite
        settings = dict(schedule="coarse_only", min_gain=-2.0, min_fix=0.0)
        best = Operator(model=Model(rewrite=rewrites()), predict=predict, evaluate=evaluate, config=CFG,
                        operator=OperatorConfig(**settings, final="best_seen")).run(start, batches, max_rounds=2)
        self.assertEqual([(r.committed, r.gain) for r in best.rounds], [(True, 2.0), (True, -1.0)])
        self.assertIn("no loss beyond the noise margin", best.rounds[1].reason)
        first = start + " Mention alpha and beta."
        self.assertNotIn("delta", best.prompt)  # the incumbent
        self.assertEqual(best.final, first)
        self.assertEqual(best.rounds[-1].final_prompt_id, best.rounds[0].end_prompt_id)
        last = Operator(model=Model(rewrite=rewrites()), predict=predict, evaluate=evaluate, config=CFG,
                        operator=OperatorConfig(**settings)).run(start, batches, max_rounds=2)
        self.assertEqual(last.final, last.prompt)
        self.assertEqual(last.rounds[-1].final_prompt_id, last.rounds[-1].end_prompt_id)

    def drifting(self):
        """The scenario above: rewrite 1 gains (+2), rewrite 2 loses delta (-1) and is still accepted."""
        needs = ["alpha", "beta", "delta", "gamma", "base", "base", "base", "base"]
        start = PROMPT + " Use delta."
        calls = {"n": 0}

        def rewrite(prompt, _needs):
            calls["n"] += 1
            if calls["n"] == 1:
                return prompt + " Mention alpha and beta."
            return prompt.replace(" Use delta.", "") + " Mention zeta."
        batches = lambda tag, n: [[Example(f"{tag}{k}x{i}", {"need": need}) for i, need in enumerate(needs)]
                                  for k in range(n)]
        return start, Model(rewrite=rewrite), batches

    def test_holdout_inputs_are_set_aside_and_the_shortest_version_within_the_margin_is_handed_over(self):
        for margin, expected in ((0.0, "first"), (2.0, "start")):
            start, model, batches = self.drifting()
            held, rest = batches("h", 1), batches("b", 3)
            result = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG, operator=OperatorConfig(
                schedule="coarse_only", min_gain=-2.0, min_fix=0.0, final="holdout", holdout_batches=1,
                final_margin=margin)).run(start, held + rest, max_rounds=2)
            first = start + " Mention alpha and beta."
            self.assertEqual([r.committed for r in result.rounds], [True, True])
            # Holdout scores: start 5/8, first 7/8, second (no delta) 6/8. Margin 0: the best; margin 2: the shortest.
            self.assertEqual(result.final, {"first": first, "start": start}[expected])
            used = {o["example_id"] for snap in result.sessions for e in snap["evaluations"] for o in e["observations"]}
            used |= {id for snap in result.sessions for id in snap["gate"]["examples"]}
            self.assertFalse(used & {e.id for e in held[0]})  # never diagnosed or gated

    def test_rollback_returns_to_an_earlier_version_that_beats_the_incumbent_on_held_out_inputs(self):
        # After round 1 the incumbent (no delta) scores 6/8 on its gate; the first rewrite scored 14/16 on
        # its two gates: z = (.875 - .75) / .185 = .68.
        for z, back in ((0.5, True), (2.0, False)):
            start, model, batches = self.drifting()
            result = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG, operator=OperatorConfig(
                schedule="coarse_only", min_gain=-2.0, min_fix=0.0, rollback_z=z)).run(start, batches("b", 3), max_rounds=2)
            first = start + " Mention alpha and beta."
            self.assertEqual(result.prompt == first, back)
            self.assertEqual(bool(result.rounds[1].rolled_back_to), back)
            if back:
                self.assertEqual(result.rounds[1].rolled_back_to, result.rounds[0].end_prompt_id)
        with self.assertRaises(Exception):
            OperatorConfig(final="holdout")  # needs holdout_batches
        with self.assertRaises(Exception):
            OperatorConfig(rollback_z=-1.0)

    def test_auto_style_is_judged_once_before_the_first_round_and_its_settings_apply(self):
        class Judged(Model):
            def __init__(self, votes, **kwargs):
                super().__init__(**kwargs)
                self.votes = list(votes)

            def __call__(self, request):
                if request.stage != "style":
                    return super().__call__(request)
                self.calls.append(request)
                vote = self.votes.pop(0)
                return {"reason": f"looks {vote}", "style": vote} if vote in STYLE_SETTINGS else "not json"

        for votes, expected in ((["detailed"] * 3, "detailed"), (["detailed", "concise", "detailed"], "concise"),
                                (["detailed", "detailed", "garbled"], "concise")):
            start, _, batches = self.drifting()
            model = Judged(votes)
            runner = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG, operator=OperatorConfig(
                schedule="coarse_only", min_fix=0.0, style="auto"))
            result = runner.run(start, batches("b", 5), max_rounds=1)
            asked = [r for r in model.calls if r.stage == "style"]
            self.assertEqual(len(asked), 3)
            self.assertEqual([r.payload["judgment"] for r in asked], [1, 2, 3])  # distinct requests
            self.assertEqual(model.calls[:3], asked)  # before any diagnosis
            self.assertEqual(result.style.style, expected)
            self.assertEqual(result.style.setting, "auto")
            # Judged on the third batch, which neither style sets aside.
            self.assertTrue(all(id.startswith("b2") for id in result.style.example_ids))
            self.assertEqual(len(asked[0].payload["examples"]), 2)
            for name, value in STYLE_SETTINGS[expected].items():
                self.assertEqual(getattr(runner.settings, name), value)
            if votes[-1] == "garbled":
                self.assertEqual(result.style.votes, ("detailed", "detailed", ""))
            used = {id for snap in result.sessions for id in snap["gate"]["examples"]} | {
                o["example_id"] for snap in result.sessions for e in snap["evaluations"] for o in e["observations"]}
            # concise sets the first two batches aside (never diagnosed or gated); detailed uses them.
            self.assertEqual(any(id.startswith(("b0", "b1")) for id in used), expected == "detailed")

    def test_a_set_style_applies_its_settings_without_asking_and_fixed_keeps_the_fields(self):
        for style in ("concise", "detailed", "fixed"):
            start, model, batches = self.drifting()
            runner = Operator(model=model, predict=predict, evaluate=evaluate, config=CFG, operator=OperatorConfig(
                schedule="coarse_only", min_fix=0.0, min_gain=-2.0, style=style))
            result = runner.run(start, batches("b", 4), max_rounds=1)
            self.assertFalse([r for r in model.calls if r.stage == "style"])
            if style == "fixed":
                self.assertIsNone(result.style)
                self.assertEqual(runner.settings.min_gain, -2.0)
            else:
                self.assertEqual((result.style.setting, result.style.style, result.style.votes), (style, style, ()))
                self.assertEqual(runner.settings.min_gain, STYLE_SETTINGS[style]["min_gain"])
        with self.assertRaises(Exception):
            OperatorConfig(style="long")

    def test_rewrite_integrate_asks_the_rewrite_to_integrate_rather_than_append(self):
        for integrate in (False, True):
            model = Model()
            session(model, config=replace(CFG, rewrite_integrate=integrate)).analyze("rewrite")
            instruction = next(r for r in model.calls if r.stage == "rewrite").instruction
            self.assertEqual("Do not merely append" in instruction, integrate)
            self.assertNotIn("Do not merely append", next(r for r in model.calls if r.stage == "diagnose").instruction)

    def test_a_combined_option_records_only_the_cards_it_applied(self):
        # Both cards rewrite the same sentence: in the combined option the second is skipped, so the
        # committed decision must not list it.
        def propose(p, need):
            return {"prompt_edits": [{"name": f"Add {need}", "phase1_addresses": [f"needs {need}"],
                                      "old_sentence": "Use base facts.", "new_sentence": f"Use base facts; mention {need}.",
                                      "reason": f"fix {need}"}]}
        s = session(Model(propose=propose))
        first, second = s.analyze("local")
        s.accept(first.id)
        s.accept(second.id)
        self.assertEqual(s.inactive, [second.id])
        gate = [Example(f"x{i}", {"need": n}) for i, n in enumerate(NEEDS)]
        result = Operator(model=Model(propose=propose), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only", min_gain=1.0)).run(PROMPT, [examples(), gate], max_rounds=1)
        self.assertTrue(result.rounds[0].committed)
        self.assertEqual(len(result.rounds[0].accepted_card_ids), 1)
        self.assertEqual(result.sessions[0]["applied"], list(result.rounds[0].accepted_card_ids))

    def test_search_stops_after_patience_trials_without_improvement(self):
        def propose(p, need):
            return {"prompt_edits": [{"name": "wrong", "phase1_addresses": ["y"], "old_sentence": "Answer the question.",
                                      "new_sentence": "Answer the question. Mention gamma.", "reason": "r"}]}
        counts = []
        for patience in (0, 2):
            session = Session(model=Model(propose=propose), predict=predict, evaluate=evaluate, prompt=PROMPT,
                              examples=examples(), config=replace(CFG, search_patience=patience))
            card = session.analyze("local")[0]
            counts.append(len(session.search(card.id).trials))
        self.assertEqual(counts[1], 3)  # the first trial sets the best; then 2 without a better reward
        self.assertGreater(counts[0], 3)

    def test_the_gate_judges_by_the_task_set_score_when_given(self):
        # Fixing two small inputs counts +2 by item, but little under a size-weighted (pooled) set score,
        # e.g. relation F1 summed over documents where the fixed documents hold few relations.
        first = examples(["alpha", "alpha", "alpha", "base", "base", "base", "base", "base"])
        gate = [Example("s0", {"need": "alpha"}), Example("s1", {"need": "alpha"})] + \
               [Example(f"b{i}", {"need": "base"}) for i in range(6)]
        weight = {e.id: 1.0 for e in first} | {"s0": 1.0, "s1": 1.0} | {f"b{i}": 10.0 for i in range(6)}

        def pooled(observations):
            return sum(weight[o.example_id] * o.evaluation.score for o in observations) / sum(weight[o.example_id] for o in observations)
        config = EngineConfig(regression_examples=3, cluster_threshold=0)
        settings = OperatorConfig(schedule="fine_only", min_gain=1.0)
        by_item = Operator(model=Model(), predict=predict, evaluate=evaluate, config=config,
                           operator=settings).run(PROMPT, [first, gate], max_rounds=1)
        by_set = Operator(model=Model(), predict=predict, evaluate=evaluate, config=config, operator=settings,
                          aggregate=pooled).run(PROMPT, [first, gate], max_rounds=1)
        self.assertTrue(by_item.rounds[0].committed)
        self.assertEqual(by_item.rounds[0].gain, 2.0)
        self.assertFalse(by_set.rounds[0].committed)
        self.assertAlmostEqual(by_set.rounds[0].options[0]["gain"], 8 * 2 / 62)

    def test_a_bad_aggregate_reply_is_a_contract_error(self):
        session = Session(model=Model(), predict=predict, evaluate=evaluate, prompt=PROMPT, examples=examples(),
                          config=CFG, aggregate=lambda observations: "high")
        with self.assertRaises(Exception) as caught:
            session.set_score(session.baseline().observations)
        self.assertIn("aggregate", str(caught.exception))

    def test_runs_are_deterministic(self):
        def run():
            op = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only"))
            return [asdict(r) for r in op.run(PROMPT, self.batches(2)).rounds]
        self.assertEqual(run(), run())


if __name__ == "__main__":
    unittest.main()
