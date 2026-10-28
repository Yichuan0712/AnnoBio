/** Only call on text the user typed, never on model output or file contents. */
export function findPathCandidates(text) {
  const source = String(text || '').replace(/\b(?:https?|file):\/\/[^\s"'`<>]+/gi, (url) => ' '.repeat(url.length));
  const groups = [];
  // Quoted paths have exact boundaries. Unquoted paths stop at prose punctuation or another path.
  const expression = /(["'`])([^\r\n]*?)\1|(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~\/|(?<![A-Za-z0-9_:/\\])\/(?!\/))[^\r\n，。；;！!？?<>"'`]*/g;
  for (const match of source.matchAll(expression)) {
    if (groups.length >= 20) break;
    const quoted = Boolean(match[1]);
    let value = (quoted ? match[2] : match[0]).trim();
    if (!/^(?:[A-Za-z]:[\\/]|\\\\|~\/|\/)/.test(value)) continue;
    const prefix = source.slice(0, match.index).split(/[\s"'`<>]/).pop();
    if (!quoted && /^[A-Za-z]:/.test(value) && /[A-Za-z0-9_]$/.test(prefix)) continue;
    if (!quoted && /^(?:https?|file):\/\//i.test(prefix)) continue;
    if (quoted) { groups.push({ candidates: [value], exact: true }); continue; }
    const next = /\s+(?=[A-Za-z]:[\\/]|\\\\|~\/|\/)/.exec(value);
    if (next) {
      // Re-scan the rest separately, including paths in the same sentence.
      const rest = value.slice(next.index).trim();
      value = value.slice(0, next.index);
      groups.push(...findPathCandidates(value), ...findPathCandidates(rest));
      continue;
    }
    value = value.replace(/[\s。，,.;:!?)）]+$/, '');
    const candidates = [value];
    // Only remove a clearly marked prose suffix in the FINAL component. Arbitrarily dropping
    // words can turn a nonexistent "D:\\My Data" into an unrelated existing "D:\\My".
    const lastSeparator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    for (const prose of value.matchAll(/\s+(?=(?:下面|下的|里的|中的|里面|的|和|以及|看看|中|里|下)|(?:and|please|for|contains|with|then|read)\b)/gi)) {
      if (prose.index > lastSeparator) candidates.push(value.slice(0, prose.index));
      if (candidates.length >= 12) break;
    }
    groups.push({ candidates, exact: false });
  }
  return groups.slice(0, 20);
}
