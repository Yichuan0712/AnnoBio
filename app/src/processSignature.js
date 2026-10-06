/**
 * The parameter list of a Process's `def process(df, df_<name>, ...)`. `df` is its primary Input
 * dataset and every other Input dataset is the parameter named after its alias, so the Input datasets
 * picker and the code declare the same thing. Only `df_` parameters are managed; anything else the
 * code declares (`limit=10`, `**inputs`) is kept as written.
 */

/** Signatures longer than this go one parameter per line. */
const MAX_SIGNATURE_LINE = 88;

const isAlias = (name) => /^df_[A-Za-z0-9_]+$/.test(name);

/** The index of `quote` closing the string opened at `start`, or the end of the code. */
function stringEnd(code, start) {
  const triple = code.slice(start, start + 3);
  const quote = triple === "'''" || triple === '"""' ? triple : code[start];
  for (let index = start + quote.length; index < code.length; index += 1) {
    if (code[index] === '\\') index += 1;
    else if (code.startsWith(quote, index)) return index + quote.length;
  }
  return code.length;
}

/**
 * @param {string} code
 * @returns {{ open: number, close: number, params: Array<{ name: string, text: string }> } | null}
 *   `open`..`close` is the text between the parentheses; `name` is '' for a bare `*` or `/`
 */
export function parseProcessSignature(code) {
  const source = String(code || '');
  const match = /^def[ \t]+process[ \t]*\(/m.exec(source);
  if (!match) return null;
  const open = match.index + match[0].length;
  const params = [];
  let depth = 0;
  let segment = '';
  const pushSegment = () => {
    const text = segment.trim();
    if (text) params.push({ name: /^\**\s*([A-Za-z_]\w*)/.exec(text)?.[1] || '', text });
    segment = '';
  };
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      segment += '\n';
    } else if (char === '"' || char === "'") {
      const end = stringEnd(source, index);
      segment += source.slice(index, end);
      index = end - 1;
    } else if ('([{'.includes(char)) {
      depth += 1;
      segment += char;
    } else if (')]}'.includes(char)) {
      if (depth === 0) {
        pushSegment();
        return { open, close: index, params };
      }
      depth -= 1;
      segment += char;
    } else if (char === ',' && depth === 0) {
      pushSegment();
    } else {
      segment += char;
    }
  }
  return null;
}

/** The code without its process() parameter list: what it uses, as opposed to what it declares. */
export function codeOutsideSignature(code) {
  const source = String(code || '');
  const signature = parseProcessSignature(source);
  return signature ? source.slice(0, signature.open) + source.slice(signature.close) : source;
}

/**
 * `code` with exactly `aliases` as its `df_` parameters, right after `df`. Parameters it already has
 * keep their place and text (an annotation, a default); new ones follow them. Code without a
 * process() signature, or whose `df_` parameters already match, is returned unchanged.
 * @param {string} code
 * @param {string[]} aliases
 */
export function withProcessParameters(code, aliases) {
  const source = String(code || '');
  const signature = parseProcessSignature(source);
  if (!signature) return source;
  const [first, ...rest] = signature.params;
  const current = rest.filter((param) => isAlias(param.name));
  const wanted = [...new Set(aliases)];
  if (current.map((param) => param.name).join(',') === wanted.join(',')) return source;
  const kept = current.filter((param) => wanted.includes(param.name));
  const added = wanted.filter((alias) => !kept.some((param) => param.name === alias));
  const others = rest.filter((param) => !isAlias(param.name));
  const texts = [first?.text || 'df', ...kept.map((param) => param.text), ...added, ...others.map((param) => param.text)];
  const lineStart = source.lastIndexOf('\n', signature.open - 1) + 1;
  const lineEnd = source.indexOf('\n', signature.close);
  const after = source.slice(signature.close, lineEnd < 0 ? source.length : lineEnd);
  const oneLine = texts.join(', ');
  const fits = !texts.some((text) => text.includes('\n'))
    && source.slice(lineStart, signature.open).length + oneLine.length + after.length <= MAX_SIGNATURE_LINE;
  const list = fits ? oneLine : `\n${texts.map((text) => `    ${text},`).join('\n')}\n`;
  return source.slice(0, signature.open) + list + source.slice(signature.close);
}
