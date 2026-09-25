const MAX_LCS_CELLS = 250000;

/**
 * Line diff of two texts as [{type: 'same' | 'added' | 'removed', text}], via longest common
 * subsequence. Past MAX_LCS_CELLS (very long texts) it falls back to "all removed, all added".
 */
export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (!before) return b.map((text) => ({ type: 'added', text }));
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map((text) => ({ type: 'removed', text })), ...b.map((text) => ({ type: 'added', text }))];
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i += 1;
    } else {
      out.push({ type: 'added', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++] });
  while (j < b.length) out.push({ type: 'added', text: b[j++] });
  return out;
}
