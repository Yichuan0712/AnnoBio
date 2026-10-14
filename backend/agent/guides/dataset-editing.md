# Dataset editing and sampling

Dataset columns are Text, Image or PDF. Image/PDF cells may hold several files. `read_rows` returns
their existing asset cells (`kind`, `assetIds`, `names`) and a parallel `rowIds` list for Dataset rows.
Reuse those cells when proposing edits; do not turn them into strings or invent file IDs.

## Editing a table

- `add_dataset` accepts column names or `{name, type}` definitions. Image/PDF cells reuse uploaded
  files from the current workspace; null makes an empty cell. New local files must be selected and
  uploaded by the user in the Dataset view.
- `update` accepts `columns` and `rows`, including existing image/PDF cells. Omitted column types
  retain the type of that column. Include the matching `row_ids` from `read_rows` when deleting or
  reordering rows, with null for newly added rows. Read all rows needed before replacing the table:
  a preview or one page is not the complete Dataset.
- `move_image` moves one image between image cells of the same Dataset, like dragging it in the
  table. It appends the image to the target and removes it from the source. Rows and the image's
  position within its cell are 1-based; columns use their exact names.
- `duplicate_dataset` copies the full table, including image/PDF cells, without reconstructing it
  from a preview. With `as_version: true`, it links a new version and preserves row identities.
  An ordinary duplicate is standalone. Copies and versions are editable until used to produce results.

The Dataset view puts row/column editing next to the table. Image and PDF import open within that
view. Import offers **Fill empty cells** and **Match by filename**; **Choose images / Choose PDFs**
selects the files, and thumbnails preview selected images before
import. The user must choose local files. The Agent can arrange or reuse files already in the workspace.
Export is in the bottom-right action group, before Create Sample and Create Process.

## Sample nodes

`add_sampler` creates a Sample and, by default, its first output Dataset. Set `create_dataset: false`
to create only the configurable Sample node. The UI defaults to random without replacement, 100%.
`sample_dataset` creates another Dataset from an existing Sample's saved settings.

- Random without replacement consumes distinct source-row identities across all its real output
  Datasets. Each draw requests the same row count (a percentage is calculated from the full source).
  Only full draws fit: 8 rows with 2 per draw allow 4 draws. The progress bar appears only for this mode.
- With replacement is repeatable and can choose a row multiple times.
- Specified rows are repeatable, preserve their requested order and duplicates, and normalize reversed
  ranges (5-3 means 3, 4, 5). It has no finite progress bar.
- `inspect_node` reports saved settings, `settingsLocked`, output Datasets, `canCreateSample`, and
  finite `progress` with completed, total, remaining draws and remaining rows. The summary also
  distinguishes modes and shows the remaining quota.
- Settings can be updated with `sampling`, `size`, `size_unit` and `rows` until the first real output
  exists. After that, create a new Sample to use different settings. Renaming is still allowed.
- An output Dataset locks its original source Dataset's content for every sampling mode. A Dataset
  version or duplicate does not count as another draw. Removing a real output restores that draw's
  rows to the pool, as on the canvas.

## Content locks and deletion

`inspect_node.contentLock` reports whether Prompt/Dataset content is locked and which nodes use it.
Saved Run/Process/Score results and Sample outputs can lock source content. Names and descriptions
remain editable. Use a Prompt version or Dataset duplicate/version for content changes.

Deletion follows canvas rules: disconnect downstream readers before removing their source, or include
all dependent nodes the user asked to remove in the same proposal. Never silently remove readers just
to make a deletion succeed.
