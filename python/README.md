# annobio-optimize

A standalone Python library for prompt optimization: diagnose failed examples, group issues by root cause, propose local edits, verify candidates, and check for regressions. When needed, use Thompson sampling to search combinations of alternative text segments.

This implementation lives alongside the AnnoBio application. It has no runtime imports from `backend/` and does not call the application's API. Biomedical matchers, the pipeline runner, other optimization algorithms, and UI code are outside this package. Python 3.10+ is required. The core has no third-party runtime dependencies; the `original` extra enables the original RapidFuzz span-matching path. The package name is provisional, and the package has not been published to PyPI.

**The main entry point for the original staged workflow is `optimizer.review()`.** Full-dataset regression checks, automatic acceptance, and multiple optimization rounds are available separately through `optimizer.optimize()`.

## Original workflow: analyze, verify, search, and accept

```python
from annobio_optimize import ReviewSearchConfig

# See "Three callbacks" below for the model / predict / evaluate contracts.
review = optimizer.review(prompt, examples)
suggestions = review.analyze()  # Generate suggestions without changing the prompt.

source = suggestions[0]
verification = review.verify(source.id)  # Run only the inputs targeted by this suggestion.
candidate = source
if not verification.full_pass:
    search = review.search(source.id, config=ReviewSearchConfig(max_trials=40))
    if search.optimized_suggestion_id is not None:
        candidate = next(s for s in review.suggestions if s.id == search.optimized_suggestion_id)
        review.verify(candidate.id)  # Search creates a separate, unapplied suggestion; verify it independently.

if review.can_accept(candidate.id):
    review.accept(candidate.id, require_verified=True)  # Use the original Agent's full-pass acceptance rule.

print(review.prompt)
# review.accept(source.id)    # A user may explicitly accept an unverified or failing suggestion, as in the UI.
# review.revert(candidate.id) # Rebuild from the original prompt and remaining accepted edits; undo need not be LIFO.
# review.reject(candidate.id)
trace = review.snapshot()     # ReviewResult: suggestions, verifications, searches, and decision history.
```

See [staged_demo.py](examples/staged_demo.py) for a complete runnable example. If predictions and evaluations already exist, supply `observations=[Observation(...)]` as the baseline to avoid rerunning the task model. You can also import an existing edit with `review.add_suggestion(edit)` and verify or optimize it independently, without repeating diagnosis. Suggestions refer to the fixed `original_prompt`; the working copy after acceptance is `review.prompt`. Create a new review to diagnose the modified prompt.

Default behavior of the original workflow:

| Stage | Preserved behavior |
|---|---|
| Diagnosis | Select failed examples in their original input order. Preserve the title, diagnosis, modification advice, category, and suspected-reference-error note. |
| Clustering | Call the model only when there are more than five issues. Remove duplicate members, add missing members as singletons, and fall back to category grouping on failure. |
| Proposals | Use the same original prompt for all proposals. Deduplicate identical edits and preserve their names, addressed diagnoses, and target examples. Do not apply edits automatically. |
| Verify | Evaluate only the target inputs. The automated acceptance check requires a completed verification with all comparisons passing. |
| Search inputs | Use the target inputs plus up to two other inputs. Prefer inputs that originally passed all comparisons, then use their original input order. |
| Search | Start every candidate at Beta(1,1). Allow repeated combinations, do not update the prior from an existing Verify result, and make fresh predictions for each trial. |
| Reward and selection | Use the comparison-row ratio `matched_count / total_count`. Failed trials increase beta for the selected candidates. Apply no additional regression penalty. Select the highest observed pass rate, keep the first candidate on ties, and stop early at 100%. |
| Budget | Default to 40 search trials, clamped to 4–200. The initial Verify call does not count toward this limit. |
| Output | Append a separate, unapplied suggestion. Preserve the original suggestion and its verification; each suggestion can be accepted or reverted independently. |

For extraction tasks, evaluators can return `Evaluation(score, matched_count=..., total_count=...)` so the library aggregates the pass rate over comparison rows. This keeps the number of passing inputs distinct from the number of matching outputs. Both counts must be supplied together, with `0 <= matched_count <= total_count`. Without counts, each input contributes one Boolean comparison based on `passed` or `pass_threshold`. Zero comparison rows do not constitute a full pass, and evaluations with a nonempty `error` do not pass. Entity pairing remains the responsibility of the user's evaluator.

Enhancements in `ReviewSearchConfig` are explicit opt-ins: `validation_scope="all"`, `reward="score"`, `text_handling="exact"`, `deduplicate=True`, `warm_start=True`, `cache_evaluations=True`, and `penalize_regression=True`. Set `continue_on_error=False` to raise prediction or evaluation exceptions immediately. These switches change algorithm behavior; record the actual configuration in experiments.

The default `text_handling="original"` retains the original segment/candidate `.strip()` behavior, case-insensitive deduplication, insertion of the original segment as an extra candidate, and continuation when joined segments differ from the proposal. This includes the original whitespace-handling issues. Explicitly select `exact` to change these behaviors. The original Beta/Gamma sampler has also been ported: its output can be compared with JavaScript given the same uniform random-number stream. A Python seed alone is not equivalent to a JavaScript random seed.

For review requests, `diagnose` uses the original fields `card_title/issue_summary/rough_modification_opinion/problem_category_hint/gt_suspect_note`. The `propose` stage returns `prompt_edits`, whose entries contain `name/phase1_addresses/old_sentence/new_sentence/reason`. Field aliases from the automatic strategy are also accepted. Clustering supports stable `issue_ids` and the original `member_indices`. Follow the `response_schema` supplied with each request.

The original backend's near-exact matching, truncated-span extension, and Markdown/quote/prefix matching have been retained as standalone functions. Install `python -m pip install "./python[original]"` to enable the same RapidFuzz matching path. Without that extra, the dependency-free paths and whitespace-normalization fallback remain available, but full fuzzy matching is unavailable. Resolved spans are stored in `PromptEdit` using the actual original text and character offsets.

`ReviewResult.to_json()/from_json()` uses the separate format `annobio.review`, version 1. It records manual decisions and keeps search trials distinct from accepted prompt versions. Budget exhaustion or cancellation during `analyze/verify` raises `ReviewStopped` with a partial trace; `search` returns a `ReviewSearchResult` with the stopping status. Interrupted searches preserve their history without appending or accepting a candidate.

## Installation and examples

From the repository root:

```shell
python -m pip install ./python
python python/examples/staged_demo.py
python python/examples/offline_demo.py
```

For development, use `python -m pip install -e ./python`. Neither offline example requires an API key. `staged_demo.py` demonstrates the original workflow, while `offline_demo.py` demonstrates the optional automatic strategy.

## Three callbacks

```python
from annobio_optimize import Evaluation, Example, Optimizer, OptimizerConfig

def predict(prompt, inputs):
    # Call your task model. The library does not interpolate the prompt or assume input field names.
    return your_task_model(prompt, inputs)

def evaluate(example, prediction):
    score, explanation = your_metric(prediction, example.reference)
    return Evaluation(score=score, feedback=explanation)

def model(request):
    # Call the model used for diagnosis, proposals, and paraphrases, using your chosen SDK.
    # request.instruction: instructions for the current stage
    # request.payload: task context for the current stage, as a JSON object
    # request.response_schema: the expected response JSON Schema
    # Return a dict matching the schema, or a string containing that JSON object.
    return your_json_model(request.instruction, request.payload, request.response_schema)

optimizer = Optimizer(
    model=model,
    predict=predict,
    evaluate=evaluate,
    config=OptimizerConfig(max_rounds=3, max_trials=20, seed=42),
)
result = optimizer.optimize(
    "Your task instruction with any placeholders you choose",
    [Example(id="document-42", inputs={"text": "..."}, reference=[{"entity": "..."}])],
)
print(result.prompt, result.score, result.stop_reason)
```

Replace the `your_*` functions with your own implementations. See [offline_demo.py](examples/offline_demo.py) for a complete runnable version. The task model and optimization model can be entirely different.

## Input validation and errors

The library checks public entry points, data structures, and callback results. Invalid arguments are reported before the task or optimization model is called. Callback results are checked when they return. Error messages include a specific field path, a reason, and a repair hint when available.

```python
from annobio_optimize import ValidationError

try:
    result = optimizer.optimize(prompt, examples)
except ValidationError as error:
    print(error)       # Full explanation
    print(error.path)  # A path suitable for locating the input or data field
    print(error.hint)  # Optional repair hint
```

Examples:

```text
examples[1].id: duplicate ID 'sample-1'; first used at examples[0].id. Each Example needs a unique ID.
Example.inputs.documents[1].text: expected a JSON value, received object. ...
evaluate.return[example_id='sample-1']: must be in [0, 1]; received 1.5. Normalize your metric so higher is better.
review.config: expected ReviewConfig, received OptimizerConfig. Construct ReviewConfig(...) ...
```

Checks cover:

- Whether `model/predict/evaluate` are callable and accept the required positional arguments. The synchronous interface rejects async/generator functions and accidentally returned coroutines/generators.
- Prompts, example types, duplicate IDs, missing/duplicate/unknown observation IDs, and edit offsets and target IDs.
- Nested JSON paths, non-string keys, NaN/Inf, circular references, and excessive nesting. Convert SDK/Pydantic objects before returning them.
- Score ranges, Boolean flags, comparison-row counts, configuration types, and enum values. A string such as `"false"` is not treated as `False`, and a single ID string is not split into characters.
- Suggestion IDs for Verify/Search/Accept and related operations. Unknown-ID errors list available IDs. `require_verified` must be a Boolean.
- Saved-result JSON formats, versions, required fields, nested field types, and major record references. Loading identifies the invalid path before later property access can fail with `KeyError/StopIteration`.

`ValidationError` subclasses include `InputTypeError`, `InputValueError`, `CallbackContractError`, and `ModelResponseError`. The first two are also compatible with Python's `TypeError` and `ValueError`, respectively. `UnknownSuggestionError` can still be caught as `KeyError`. `AnnoBioError` is the common base for the library's public errors, including `ReviewStopped`.

External errors raised inside user callbacks, such as `ConnectionError`, retain their original exception type, cause, and traceback, with added callback, stage, or example-ID context. The original review workflow preserves its error-recording and continuation policies for recoverable Verify/Search failures; those records also include context. **Callback contract violations raise directly.** They are not treated as poor candidate performance. Existing model-format fallbacks for clustering, segmentation, and paraphrasing remain available and are recorded in `notices`.

Validation does not infer task semantics. Your callbacks still determine whether `inputs` requires a `text` key, how entities are paired, and how scores are calculated.

## Evaluation feedback

`evaluate` evaluates one `Example` at a time and returns either an `Evaluation` or a number in `[0, 1]`, with higher values indicating better performance. Normalize metrics outside that range yourself. The automatic strategy's overall objective is the weighted mean of per-example scores using `Example.weight`. The library does not prescribe accuracy, F1, entity pairing, or task-specific rules; `metrics` are recorded for analysis. For non-additive corpus-level metrics, define appropriate example grouping and scoring yourself. A mean of document-level F1 scores is not equivalent to corpus-level micro-F1.

`Evaluation(score, feedback="", passed=None, metrics={}, details=None)`:

- `score`: the optimization objective, a finite number in `[0, 1]`. NaN, Inf, and Boolean values are rejected.
- `feedback`: optional natural-language error feedback supplied to the diagnosis model.
- `passed`: an optional explicit pass flag. When absent, use `score >= config.pass_threshold`. It controls failed-example selection and early stopping when all examples pass. The automatic strategy still ranks candidates by `score`; the original review workflow uses comparison-row pass rates as described above.
- `metrics`: additional metrics. `details`: arbitrary JSON-compatible details. Both are retained in the trace and available for diagnosis.

One example represents one task call and may contain multiple prediction rows and reference entities. Avoid duplicating an input for each output entity. Use `reference=None` for reference-free tasks evaluated entirely by a custom evaluator. Inputs, references, predictions, and additional data must be JSON-compatible, with finite numeric values. Reading files, images, or non-JSON objects is the responsibility of your callbacks.

## Optimization model protocol

The model receives `ModelRequest(stage, instruction, payload, response_schema)`. All responses are JSON objects. The automatic strategy uses these fields:

| Stage | Response fields |
|---|---|
| `diagnose` | `summary`, `advice`, `category`, `reference_note`, all strings |
| `cluster` | `clusters: [{issue_ids: [str], label: str}]` |
| `propose` | `old_text`, `new_text`, `rationale`, all strings |
| `segment` | `segments: [str]` |
| `paraphrase` | `candidates: [str]` |

`reference_note` is normally empty. It records evidence of a suspected reference error without changing the reference or score. The library assigns issue, cluster, edit, and trial IDs; the model does not choose which examples an edit targets. The original review workflow uses the field names documented earlier; follow each request's `response_schema`.

## Optional automatic strategy: verification and acceptance

The following rules apply only to `optimizer.optimize()`.

Each round starts by diagnosing currently failing examples, ordered from lowest score upward, up to `max_failed_examples`. When the number of issues exceeds `cluster_threshold` (default 5), the model clusters them; otherwise, each issue forms its own cluster.

For each cluster, propose one edit to the **current prompt** and evaluate it on **all input examples**. A candidate must meet all of these conditions:

1. The target examples' weighted mean score increases by more than `min_improvement`.
2. The overall weighted mean score increases by more than `min_improvement`.
3. No example's score drops by more than `max_score_drop` (default 0), and no previously passing example becomes a failure.

This is an explicit automatic acceptance policy. Once an edit is accepted, the next cluster uses the updated prompt and scores as its baseline. The next round diagnoses failures again. `result.accepted_edits` records accepted changes. Regression checks cover only the data you provide and do not guarantee performance on unseen examples.

If the initial proposal does not make every target example pass, the library segments its replacement text, generates alternatives for each segment, and uses independent Beta posteriors for Thompson sampling. Each segment retains its original text as a candidate. Segments are joined verbatim without trimming whitespace; invalid splits fall back to a single full-text segment. Each combination is evaluated on all examples. Candidates causing regressions receive zero search reward; other candidates use the overall weighted score. Search candidates must still satisfy the acceptance conditions above. Choose the highest-scoring eligible candidate, keep the first candidate on ties, and stop that search early when all target examples pass.

`max_trials` limits candidate evaluations **per cluster**, including the initial proposal. Set it to 1 to disable segment search. Combinations are deduplicated by their final text, and search may stop early when the search space is exhausted. Pure deletions can be verified and accepted but do not undergo empty-text segment search.

## Budgets, stopping, and results

The following configuration and stopping behavior apply to the automatic strategy:

```python
config = OptimizerConfig(
    max_rounds=3,
    max_trials=20,
    max_model_calls=100,   # Total diagnosis, clustering, proposal, segmentation, and paraphrasing calls
    max_predictions=1000, # Total task prediction calls, including the baseline
    seed=42,
)
```

Before evaluating a candidate, the library checks that the remaining budget covers the entire batch. It does not produce scores from partial batches. On reaching a budget limit, an already verified eligible candidate may still be accepted; the result reports `budget_exhausted`. The initial prediction budget must cover at least one full pass over the input examples.

`stats` separately counts optimization-model, task-prediction, and evaluator calls. Budgets limit callback invocations made by the library. Retries, requests, tokens, and costs inside a callback remain under user control. The library performs no implicit network retries.

By default, automatic runs cache complete evaluation batches by full prompt content within a single run, keeping comparisons consistent and avoiding repeated requests. Set `cache_evaluations=False` to disable caching. The cache is not shared across runs. `seed` controls only the library's search RNG and cannot guarantee reproducibility of external models.

`optimize(..., is_cancelled=lambda: ..., on_event=callback)` supports synchronous cooperative cancellation and progress events. Cancellation is checked at callback boundaries and cannot interrupt an external request already in progress. It returns the last accepted prompt version. If cancellation occurs before the baseline, the score is `None`. Prediction or evaluation exceptions raise directly. Model-output parsing errors raise `ModelResponseError`; recoverable format errors in clustering, segmentation, and paraphrasing use conservative fallbacks recorded in `notices`. Proposals whose spans cannot be resolved are skipped.

`stop_reason` is one of `perfect`, `converged`, `max_rounds`, `budget_exhausted`, or `cancelled`. `perfect` requires all input examples to pass. `converged` means no edits were accepted during a full round; it does not imply a global optimum.

`result` contains the initial and final prompts, per-example candidate evaluations, issues, clusters, exact edits, search spaces, trials, the accepted-version chain, model requests/responses, budget counters, and stopping reason.

```python
from pathlib import Path
from annobio_optimize import OptimizationResult

Path("optimization.json").write_text(result.to_json(), encoding="utf-8")
restored = OptimizationResult.from_json(Path("optimization.json").read_text(encoding="utf-8"))
assert restored.prompt == result.prompt
```

Saving is explicit. Exported traces contain user-provided inputs, references, predictions, and model responses. The format is versioned. Loading supports inspection and analysis; there is currently no API to resume execution from an interrupted trace.

Examples used for proposals, search, and acceptance are training/development data. Keep the test set separate and evaluate the selected prompt with your own `predict/evaluate` callbacks after optimization.

## Tests

After installation, run from the repository root:

```shell
python -m unittest discover -s python/tests -v
```

See [DESIGN.md](DESIGN.md) for data structures and differences from the application implementation.
