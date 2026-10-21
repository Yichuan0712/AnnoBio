"""Original staged workflow: verify, search, append candidate, explicitly accept/revert."""
from annobio_optimize import Evaluation, Example, Optimizer, ReviewSearchConfig
from offline_demo import predict


def evaluate(example, prediction):
    actual, expected = set(prediction), set(example.reference)
    matched = len(actual & expected)
    total = max(len(actual), len(expected))
    f1 = 2 * matched / (len(actual) + len(expected)) if actual or expected else 1.0
    # This demo's own comparison rule; the library does not prescribe entity pairing.
    return Evaluation(f1, feedback=f"Missing: {sorted(expected - actual)}",
                      matched_count=matched if total else 1, total_count=total or 1)


def model(request):
    if request.stage == "diagnose":
        return {"card_title": "Missing gene", "issue_summary": "A second gene was omitted.",
                "rough_modification_opinion": "Ask for all genes.",
                "problem_category_hint": "coverage", "gt_suspect_note": ""}
    if request.stage == "propose":
        return {"prompt_edits": [{"name": "Improve completeness", "phase1_addresses": ["Missing gene"],
            "old_sentence": "Extract the first gene.", "new_sentence": "Extract every gene.",
            "reason": "Remove the first-mention restriction."}]}
    if request.stage == "segment":
        return {"segments": ["Extract every gene."]}
    if request.stage == "paraphrase":
        return {"candidates": ["Extract all genes."]}
    raise AssertionError(request.stage)


def main():
    data = [Example("paper-17", {"text": "TP53 and EGFR were measured."}, ["TP53", "EGFR"]),
            Example("paper-42", {"text": "No genes were reported."}, [])]
    review = Optimizer(model=model, predict=predict, evaluate=evaluate).review("Extract the first gene.", data)
    source = review.analyze()[0]
    verification = review.verify(source.id)
    print(f"Original suggestion verified: {verification.full_pass}")
    search = review.search(source.id, config=ReviewSearchConfig(max_trials=4))
    assert review.prompt == review.original_prompt
    assert review.suggestions[0] == source
    assert search.optimized_suggestion_id is not None
    candidate = next(item for item in review.suggestions if item.id == search.optimized_suggestion_id)
    assert review.verify(candidate.id).full_pass
    print(f"New unapplied suggestion: {candidate.edit.new_text}")
    review.accept(candidate.id, require_verified=True)
    print(f"Accepted: {review.prompt}")
    review.revert(candidate.id)
    print(f"Reverted: {review.prompt}")
    print(f"Stats: {review.snapshot().stats}")
    assert review.prompt == review.original_prompt


if __name__ == "__main__":
    main()
