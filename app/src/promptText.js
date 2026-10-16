/**
 * A Prompt is one block of text. `{name}` marks an input the Generate fills from a dataset column, and
 * `{{` / `}}` write literal braces, so `{{text}}` is plain text rather than an input.
 */

/** Each `{input}` placeholder in `text`, in order: [{ key, start, end }]. */
export function promptPlaceholders(text) {
  const content = String(text || '');
  const found = [];
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = m.index > 0 ? content[m.index - 1] : '';
    const after = content[m.index + m[0].length] || '';
    if (before === '{' || after === '}') continue;
    const key = m[1].trim();
    if (key) found.push({ key, start: m.index, end: m.index + m[0].length });
  }
  return found;
}

/** The input names a prompt's text uses, each once, in order of first use. */
export function extractInputFields(text) {
  return [...new Set(promptPlaceholders(text).map((p) => p.key))];
}
