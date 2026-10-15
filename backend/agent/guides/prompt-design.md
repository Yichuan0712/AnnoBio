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

New Prompts default to Multiple rows (`table`), matching the creation window. A schema edit that
only changes fields keeps the existing return shape.

The Run parses the model's structured output against this schema; rows that fail to parse are recorded
as errors on that row.

Each field also has **Allow None** (`allow_none` in proposals). It allows a null value when evidence
is absent, while keeping the declared field type for non-null values. Numeric examples are numbers;
examples of list fields are arrays of strings or numbers, not comma-separated text. Preserve this
setting and the examples when copying or revising a schema. Section and field names are unique,
ignoring case, and every section needs both a name and content.

The creation window expands in three steps: name and description, Prompt sections, then Output schema.
Section/field editors open inside that window. Existing Prompt details use **Edit sections** and
**Edit schema** beside their headings; **Output rows** uses the **One row / Multiple rows** pills.
**Export** is the first button in the bottom-right group, before **Create Run**.

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
connection, so earlier Runs and Evaluate nodes stay comparable. Optimize nodes create new versions this way.

## Runs

A Run needs: the Prompt, one input (a Dataset or another step's output), and a mapping from every
input variable to a column. It uses the default Run model from Settings → Run defaults. Runs
process rows concurrently and can be stopped and resumed. The next step reads a Run's results
directly; save them to the workspace only to freeze or hand-edit them as a Dataset.
