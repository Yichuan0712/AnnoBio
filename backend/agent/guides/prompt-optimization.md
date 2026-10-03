# Prompt optimisation

## The loop

Prompts are improved from evidence, not by rewriting them blind:

1. Run the prompt on a Dataset that has ground truth (a sampled subset is fine while iterating).
2. Score the Run.
3. Review the Score. A Review node analyses the unmatched rows and proposes concrete edits: a target
   section, the old sentence, the new sentence and the reason.
4. Verify suggestions. Verification re-runs the prompt with the edit on the rows it targets and reports
   whether they now match, including rows the source prompt already had right.
5. Accept the suggestions that verified, and apply them. Applying creates a new prompt version linked to
   the old one: the checkpoint for this review.
6. Optionally fold promising suggestions that did not fully verify into a further version, when their
   reason names a real failure and the verification rows show the direction was right.
7. Run and score the new version on the same Dataset, and compare with the previous version.

Always compare versions on the same input Dataset and the same Score rules; otherwise the difference is
not attributable to the prompt.

## Comparing versions

The Prompt Optimization tab of the bottom panel shows each prompt's versions as a tree. A version
made by applying a Review, or added as a new version, sits under the version it came from; the From
column says which ("Review ... of ...", "New version of ..."). Each row is one Score of one Run, with
the ground truth it used and its precision, recall and F1. Clicking a row finds that Prompt, Run and
Score on the canvas. **Export Excel** saves the table, tree included.

The workspace summary gives the same version links, and each Score line gives the same precision,
recall and F1 as the table. Compare versions from those numbers rather than estimating.

## Review methods

Reviews use the review method set in Settings → Review defaults:
- Thompson Prompt Search (the default): issue analysis followed by targeted sentence-level edits.
- GEPA: reflective evolution of the prompt across candidates.
- MIPROv2: optimises instructions together with few-shot examples.
- BootstrapFewShot with random search: optimises few-shot examples only.
- TextGrad, COPRO and SIMBA: further instruction optimisers.

## Advising the user

- Find out where the pipeline stands first: does the prompt already have a Run, a Score, a Review, a
  newer version? Continue from the furthest point instead of starting over.
- Before optimising, check the evaluation is trustworthy: read some unmatched rows. If most failures
  are formatting or ground-truth problems, fix the Score rules or the data, not the prompt.
- Each step costs model calls (Runs, Reviews and verification all do), so confirm with the user before
  recommending a full cycle on a large Dataset, and suggest a Sampler subset while iterating.
- After a cycle, report the metric change between versions and the rows that changed, then ask the user
  whether to continue, stop, or try something else.

## Without ground truth

The optimisers above only work from a Score, and a Score needs a ground-truth Dataset. When the prompt
has none, do not silently rewrite it:
- Tell the user, once, that these optimisers exist and what they need, then let them choose how to go on.
- A small labelled set is enough to start: a Sampler draws 20-50 rows from the input Dataset, and the
  user fills in the expected outputs, either in the Dataset window (it can add columns and edit cells) or
  in a spreadsheet exported from it and imported back. Rows that cover the main kinds of failure matter
  more than volume.
- If the user already has labelled data, import it and build the Score on it.
- You may draft expected outputs to speed up labelling, but say plainly that a person must check them
  before they serve as ground truth: scoring a prompt against answers a model wrote grades the model
  against itself.
- A hand-written revision is still possible when the user wants one now. Say it is unverified, and
  suggest scoring it once ground truth exists.
