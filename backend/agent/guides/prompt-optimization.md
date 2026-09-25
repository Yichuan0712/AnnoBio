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

## Review methods

A Score chooses its review method (Settings holds the default):
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
