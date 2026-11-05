"""Offline behavior of the v2 engine (python/ENGINE_V2_DESIGN.md) with a toy task and a scripted model.

Toy task: an input passes when the prompt mentions the word it needs. The initial prompt mentions
"base", so inputs needing "base" pass and the others fail until a card adds their word.
"""
from dataclasses import asdict
import json
import unittest

from annobio_optimize import Evaluation, Example
from annobio_optimize.engine import EngineConfig, Operator, OperatorConfig, Session

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


class OperatorTests(unittest.TestCase):
    def batches(self, n=4):
        return [examples() for _ in range(n)]

    def test_a_beneficial_rewrite_is_committed_in_the_coarse_phase(self):
        rounds = []
        op = Operator(model=Model(), predict=predict, evaluate=evaluate,
                      config=CFG, on_round=lambda p, r: rounds.append(r))
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
                      operator=OperatorConfig(coarse_patience=1))
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

    def test_runs_are_deterministic(self):
        def run():
            op = Operator(model=Model(), predict=predict, evaluate=evaluate, config=CFG,
                          operator=OperatorConfig(schedule="fine_only"))
            return [asdict(r) for r in op.run(PROMPT, self.batches(2)).rounds]
        self.assertEqual(run(), run())


if __name__ == "__main__":
    unittest.main()
