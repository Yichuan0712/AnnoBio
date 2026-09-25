# Prompt design

## Structure

A Prompt node has named sections (for example Role, Task, Rules, Examples, Input). Section text can
contain `{variable}` placeholders; every distinct placeholder becomes an input the Run must map to a
Dataset column. Text in doubled braces, such as `{{example}}`, is not treated as a variable.

Each input has a type: text, image or pdf. An image or pdf input sends the files in that cell to the
model, so the Run's model must support that modality (in the OpenRouter catalog: vision for images,
file input for pdf).

## Output schema

The output format declares the fields the model must return, each with a key, a type (string, number,
list of strings or list of numbers), a description and optional examples. The return shape is either:
- single: one object per input row;
- table: a list of objects per input row, for when one input yields several annotations (for example
  every binding site mentioned in an abstract).

The Run parses the model's structured output against this schema; rows that fail to parse are recorded
as errors on that row.

## Writing guidance

- State the task, the unit of annotation and what to do when the evidence is absent (return an empty
  string or a sentinel such as "not reported") explicitly. Most scoring failures come from unstated
  edge cases.
- Put controlled vocabularies and formatting rules in the field descriptions, where the model sees them
  next to the field.
- Keep one decision per field. Split compound fields (for example gene and mutation) so they can be
  scored separately.
- Add a few short, realistic examples for hard cases; avoid examples that are also in the evaluation
  set.

## Versions

Editing a prompt that already has results is best done as a new version, linked by a `prompt-to-prompt`
connection, so earlier Runs and Scores stay comparable. Reviews create new versions this way.

## Runs

A Run needs: the Prompt, one input Dataset, a mapping from every input variable to a column, and a
model credential (or the default Run credential from Settings). Runs process rows concurrently and can
be stopped and resumed. Save the results to the workspace to use them as a Dataset downstream.
