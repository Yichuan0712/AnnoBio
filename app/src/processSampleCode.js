/**
 * The sample code a new Process starts with. It names the columns of the Process's `df`, so while it
 * is left untouched it follows `df` when another input becomes `df` (the Process window and a
 * connection dragged onto the `df` port, nodePorts.js).
 */
import { withProcessParameters } from './processSignature.js';

const MAX_COMMENT_LINE_CHARS = 70;

function wrapCommentList(prefix, continuationPrefix, items) {
  const lines = [];
  let current = prefix;
  items.forEach((item, index) => {
    const piece = (index === 0 ? '' : ', ') + item;
    if (current !== prefix && current.length + piece.length > MAX_COMMENT_LINE_CHARS) {
      lines.push(current);
      current = continuationPrefix + item;
    } else current += piece;
  });
  lines.push(current);
  return lines.join('\n');
}

const INPUTS_COMMENT = `    # Each other input is a parameter after df, named df_<name>; connect
    # one by dragging an output onto this node's + port on the canvas.`;
/** How the sample described other inputs before they were connected on the canvas (NODE_PORTS_PLAN.md step 6). */
const PICKER_INPUTS_COMMENT = `    # Each other Input dataset you check is a parameter after df, named
    # df_<name> as shown under Input datasets.`;

/** Sample code naming the primary Dataset's real columns. Comments must not spell a real df_<name>
 * alias: referencedDatasetAliases scans comments too, so that would add a canvas dependency. */
export function buildDefaultProcessCode(headers) {
  return sampleCode(headers, INPUTS_COMMENT);
}

function sampleCode(headers, inputsComment) {
  const columns = (Array.isArray(headers) ? headers : []).map((header) => String(header ?? '')).filter(Boolean);
  const col = JSON.stringify(columns[0] || 'column');
  const columnLines = columns.length
    ? wrapCommentList('    # Columns: ', '    #   ', columns)
    : '    # Columns: (none yet)';
  return `import pandas as pd


def process(df):
    # df is this Process's input Dataset as a pandas DataFrame.
${columnLines}
${inputsComment}
    #
    # Return one of:
    #   1. One DataFrame -> one output Dataset
    #        return df[df[${col}].notna()]
    #   2. A dict of DataFrames -> one output Dataset per key (named branches)
    #        mask = df[${col}].astype(str).str.len() > 0
    #        return {"kept": df[mask], "empty": df[~mask]}
    #
    # Common steps:
    #   df[${col}] = df[${col}].astype(str).str.strip()  # clean a column
    #   df = df.drop_duplicates(subset=[${col}])  # remove duplicates
    #   df = df.merge(df_<name>, on=${col}, how="left")  # join another Dataset
    return df
`;
}

/**
 * Whether `code` is still the sample for a `df` with `headers`, whatever inputs were added after df.
 * Saved code is trimmed (processCode.js resolveDataframeProcessCode), so the ends do not count.
 */
export function isUntouchedSampleCode(code, headers) {
  const bare = withProcessParameters(String(code || ''), []).trim();
  return [INPUTS_COMMENT, PICKER_INPUTS_COMMENT].some((comment) => bare === sampleCode(headers, comment).trim());
}
