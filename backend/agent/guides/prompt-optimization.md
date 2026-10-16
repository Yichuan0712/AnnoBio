# Prompt optimisation

## The loop

Prompts are improved from evidence, not by rewriting them blind:

1. Run the prompt on a Dataset that has ground truth (a sampled subset is fine while iterating).
2. Evaluate the Generate.
3. Optimize the prompt using the evaluation results. An Optimize node analyses the unmatched rows and proposes concrete edits: the old
   sentence, the new sentence and the reason.
4. Verify suggestions. Verification re-runs the prompt with the edit on the rows it targets and reports
   whether they now match, including rows the source prompt already had right.
5. Accept the suggestions that verified, and apply them. Applying creates a new prompt version linked to
   the old one: the checkpoint for this review.
6. Optionally fold promising suggestions that did not fully verify into a further version, when their
   reason names a real failure and the verification rows show the direction was right.
7. Run and score the new version on the same Dataset, and compare with the previous version.

Read an existing Optimize before starting another. If its status is interrupted, request `run_nodes`
with kind `resume_review` and its `review` id; this resumes the existing node. An interrupted run is
not a successful optimization, even when it has already produced some suggestions.

`inspect_node` exposes paged `rowDiagnostics`, `dataRefinement`, `stages` and `suggestions`. Use its
section, start_row and max_rows arguments to read more; the verification section also needs
suggestion_id and returns per-row evidence. Read these results before explaining why an edit helps
or whether the ground truth may be wrong.

When a suggestion's verification did not fully pass (verifyState `optimization`) and the method
supports it, request kind `optimize_suggestion` with review and suggestion_id. It uses the same
wording search and sample selection as the card's Click to Optimize action, including up to two
regression inputs. It appends a new unapplied suggestion; verify that candidate in a separate stage
before applying it. Methods with supportsSuggestionOptimization false do not offer this action.

Always compare versions on the same input Dataset and the same Evaluate rules; otherwise the difference is
not attributable to the prompt.

## Comparing versions

The Prompt Version tab shows each prompt family as a left-to-right tree, including prompts that
have not been run. Branch labels identify Manual edit, Agent edit, or Optimize and its method when
recorded. Click a node to locate and highlight its Prompt on the canvas; click a branch or its label to compare the parent and child.
Independent duplicates start their own families. Inspect the Generate and Evaluate nodes to compare results;
this panel displays version ancestry rather than evaluation metrics.

The workspace summary gives the same version links, and each Evaluate line gives the same precision,
recall and F1 as the table. Compare versions from those numbers rather than estimating.

## Optimize methods

Optimize nodes use the review method set in Settings → Optimize:
- Thompson Prompt Search (the default): issue analysis followed by targeted sentence-level edits.
- GEPA: reflective evolution of the prompt across candidates.
- MIPROv2: optimises instructions together with few-shot examples.
- BootstrapFewShot with random search: optimises few-shot examples only.
- TextGrad, COPRO and SIMBA: further instruction optimisers.

## Advising the user

- Find out where the pipeline stands first: does the prompt already have a Generate, an Evaluate node, an Optimize node, a
  newer version? Continue from the furthest point instead of starting over.
- Before optimising, check the evaluation is trustworthy: read some unmatched rows. If most failures
  are formatting or ground-truth problems, fix the Evaluate rules or the data, not the prompt.
- Each step costs model calls (Generate steps, Optimize nodes and verification all do), so confirm with the user before
  recommending a full cycle on a large Dataset, and suggest a Sampler subset while iterating.
- After a cycle, report the metric change between versions and the rows that changed, then ask the user
  whether to continue, stop, or try something else.

## Without ground truth

The optimisers above only work from an Evaluate node, and an Evaluate node needs a ground-truth Dataset. When the prompt
has none, do not silently rewrite it:
- Tell the user, once, that these optimisers exist and what they need, then let them choose how to go on.
- A small labelled set is enough to start: a Sampler draws 20-50 rows from the input Dataset, and the
  user fills in the expected outputs, either in the Dataset window (it can add columns and edit cells) or
  in a spreadsheet exported from it and imported back. Rows that cover the main kinds of failure matter
  more than volume.
- If the user already has labelled data, import it and build the Evaluate on it.
- You may draft expected outputs to speed up labelling, but say plainly that a person must check them
  before they serve as ground truth: scoring a prompt against answers a model wrote grades the model
  against itself.
- A hand-written revision is still possible when the user wants one now. Say it is unverified, and
  suggest scoring it once ground truth exists.
