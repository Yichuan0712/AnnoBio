/**
 * Locate prompt spans and rebuild the prompt text when Optimize suggestions are applied.
 */

/**
 * Find the segment in content that matches oldSentence, so we can replace it even if whitespace differs.
 * @returns {string|null}
 */
export function findSegmentInContent(content, oldSentence) {
  if (content == null || content === '' || oldSentence == null) return null;
  const raw = String(oldSentence);
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (content.includes(raw)) return raw;
  if (content.includes(trimmed)) return trimmed;
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    const regex = new RegExp(pattern);
    const m = content.match(regex);
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fallback: find the segment in content that best matches oldSentence (e.g. by sentence boundaries).
 * @returns {string|null}
 */
export function findBestMatchingSegment(content, oldSentence) {
  if (content == null || content === '' || oldSentence == null) return null;
  const trimmed = String(oldSentence).trim();
  if (trimmed === '') return null;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const normOld = norm(trimmed);
  const parts = content.split(/(?<=[.!?\n])\s*|\n/);
  let best = null;
  let bestScore = 0;
  for (const part of parts) {
    const seg = part.trim();
    if (seg.length < 2) continue;
    const normSeg = norm(seg);
    if (normSeg === normOld) return seg;
    const segInOld = normOld.includes(normSeg);
    const oldInSeg = normSeg.includes(normOld);
    if (segInOld || oldInSeg) {
      const score = segInOld ? normSeg.length : normOld.length;
      if (score > bestScore) {
        bestScore = score;
        best = seg;
      }
    }
  }
  if (best) return best;
  const words = normOld.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  for (const part of parts) {
    const seg = part.trim();
    if (seg.length < 2) continue;
    let match = 0;
    for (const w of words) {
      if (seg.includes(w) || norm(seg).includes(w)) match += 1;
    }
    const score = match / words.length;
    if (score >= 0.6 && score > bestScore) {
      bestScore = score;
      best = seg;
    }
  }
  return best;
}

/** @returns {string|null} */
export function getLocatableSegment(content, oldSentence) {
  return findSegmentInContent(content, oldSentence) || findBestMatchingSegment(content, oldSentence);
}

/**
 * The paragraph (text between blank lines) holding `sentence`, as read-only context for an edit to
 * it; the whole text when the sentence isn't found there.
 * @returns {string}
 */
export function paragraphAround(text, sentence) {
  const content = String(text || '');
  const segment = findSegmentInContent(content, sentence);
  if (!segment) return content;
  const at = content.indexOf(segment);
  const blankBefore = content.lastIndexOf('\n\n', at);
  const blankAfter = content.indexOf('\n\n', at + segment.length);
  return content.slice(blankBefore < 0 ? 0 : blankBefore + 2, blankAfter < 0 ? content.length : blankAfter).trim();
}

/**
 * `new_sentence` to use when applying a suggestion.
 * @param {Record<string, unknown>} s
 * @returns {string}
 */
export function effectiveNewSentenceForApply(s) {
  if (!s || typeof s !== 'object') return '';
  return String(s.new_sentence ?? '').trim();
}

/**
 * The prompt text with every suggestion that has applied === true applied, in order. A suggestion
 * whose old sentence can't be found exactly (whitespace aside) in the text so far is skipped.
 * @param {string} originalText
 * @param {Array<Record<string, unknown>>} suggestions
 * @returns {string|null}
 */
export function rebuildWorkingFromApplied(originalText, suggestions) {
  if (typeof originalText !== 'string' || !Array.isArray(suggestions)) return null;
  let text = originalText;
  for (const s of suggestions) {
    if (s?.applied !== true || s.old_sentence == null || s.new_sentence == null) continue;
    const segment = findSegmentInContent(text, String(s.old_sentence));
    if (segment) text = text.replace(segment, effectiveNewSentenceForApply(s));
  }
  return text;
}

/** Stored 0-based comparison `row_index` for targeted Score rows (API / persistence; prompts use 1-based Score #). */
export function suggestionTargetScoreRowIndices(sug) {
  if (!sug || typeof sug !== 'object') return [];
  const raw = sug.target_score_row_indices ?? sug.target_input_row_indices ?? sug.row_indices;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => Number(x)).filter((x) => !Number.isNaN(x) && x >= 0))].sort((a, b) => a - b);
}

/** @deprecated Use `suggestionTargetScoreRowIndices` (legacy name). */
export const suggestionTargetInputRowIndices = suggestionTargetScoreRowIndices;
