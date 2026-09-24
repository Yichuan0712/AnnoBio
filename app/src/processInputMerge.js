/**
 * Build the one dataframe supplied to a Process from all of its Dataset inputs.
 *
 * A Process has one stable Python contract, `process(df)`. Multiple Dataset inputs
 * are therefore merged by row: columns are the ordered union of input columns and
 * every input row is aligned to that union. This preserves the familiar dataframe
 * API while making a Process an explicit merge point in the canvas.
 */
export function mergeProcessInputContents(contents = []) {
  const validContents = (Array.isArray(contents) ? contents : []).filter((content) => (
    content && Array.isArray(content.headers) && Array.isArray(content.rows)
  ));
  const headers = [];
  for (const content of validContents) {
    for (const header of content.headers) {
      const name = String(header ?? '');
      if (name && !headers.includes(name)) headers.push(name);
    }
  }

  const rows = [];
  for (const content of validContents) {
    const indexes = new Map(content.headers.map((header, index) => [String(header ?? ''), index]));
    for (const sourceRow of content.rows) {
      rows.push(headers.map((header) => {
        const index = indexes.get(header);
        const value = index == null ? '' : sourceRow[index];
        return value && typeof value === 'object' ? structuredClone(value) : value;
      }));
    }
  }
  return { headers, rows };
}
