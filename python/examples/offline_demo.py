"""Run a complete optimization without API keys; replace callbacks for a real task."""
import re

from annobio_optimize import Evaluation, Example, ModelRequest, Optimizer, OptimizerConfig


def predict(prompt, inputs):
    # Deliberately simple stand-in for a task model, not a biomedical extraction method.
    genes = list(dict.fromkeys(re.findall(r"\b(?:TP53|EGFR)\b", inputs["text"])))
    return genes if "all genes" in prompt else genes[:1]


def evaluate(example, prediction):
    predicted, expected = set(prediction), set(example.reference)
    denominator = len(predicted) + len(expected)
    f1 = 2 * len(predicted & expected) / denominator if denominator else 1.0
    return Evaluation(f1, feedback=f"Missing: {sorted(expected - predicted)}; extra: {sorted(predicted - expected)}",
                      metrics={"f1": f1})


def optimization_model(request: ModelRequest):
    # Deterministic stand-in for the LLM that diagnoses errors and proposes edits.
    if request.stage == "diagnose":
        return {"summary": "The output omits a second gene.", "advice": "Require complete coverage.",
                "category": "under_extraction", "reference_note": ""}
    if request.stage == "propose":
        return {"old_text": "Extract the first gene.", "new_text": "Extract every gene.",
                "rationale": "Remove the restriction to the first mention."}
    if request.stage == "segment":
        return {"segments": ["Extract ", "every gene."]}
    if request.stage == "paraphrase":
        return {"candidates": ["all genes."] if request.payload["segment_index"] == 1 else []}
    raise AssertionError(f"Unexpected stage: {request.stage}")


def main():
    data = [
        Example("paper-17", {"text": "TP53 and EGFR were measured."}, ["TP53", "EGFR"]),
        Example("paper-42", {"text": "No genes were reported."}, []),
    ]
    optimizer = Optimizer(model=optimization_model, predict=predict, evaluate=evaluate,
                          config=OptimizerConfig(max_trials=5, seed=42))
    result = optimizer.optimize("Extract the first gene.", data)
    print(f"Prompt: {result.prompt}")
    print(f"Score: {result.initial_score:.3f} -> {result.score:.3f}")
    print(f"Stop: {result.stop_reason}; stats: {result.stats}")
    for trial in result.trials:
        print(f"  {trial.id}: {trial.edit.new_text!r}, eligible={trial.eligible}, {trial.rejection_reason}")
    # Full, versioned trace. Save explicitly if desired:
    # Path("optimization.json").write_text(result.to_json(), encoding="utf-8")
    assert result.prompt == "Extract all genes."
    assert result.score == 1.0


if __name__ == "__main__":
    main()
