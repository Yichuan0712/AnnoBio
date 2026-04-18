/**
 * Locate prompt spans and rebuild section text when suggestions are applied (Review).
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
 * 0-based section index where `oldSentence` is uniquely locatable, or -1 if none / ambiguous.
 * @param {Array<{ content?: string }>} sections
 * @param {string} oldSentence
 * @returns {number}
 */
export function findSectionIndexForOldSentence(sections, oldSentence) {
  if (!Array.isArray(sections) || oldSentence == null) return -1;
  const raw = String(oldSentence);
  const trimmed = raw.trim();
  if (!trimmed) return -1;
  /** Strict: includes + whitespace-flex regex only (no fuzzy sentence match — avoids false multi-section hits). */
  const segmentHit = (content) => !!findSegmentInContent(content, raw);
  const hits = [];
  for (let i = 0; i < sections.length; i++) {
    const content = sections[i] && sections[i].content != null ? String(sections[i].content) : '';
    if (segmentHit(content)) hits.push(i);
  }
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const literalHits = [];
    for (let i = 0; i < sections.length; i++) {
      const content = sections[i] && sections[i].content != null ? String(sections[i].content) : '';
      if (content.includes(raw) || content.includes(trimmed)) literalHits.push(i);
    }
    if (literalHits.length === 1) return literalHits[0];
  }
  return -1;
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
 * Rebuild working sections from originals by applying all suggestions that have applied === true.
 * @param {Array<{ name?: string, content?: string }>} originals
 * @param {Array<Record<string, unknown>>} suggestions
 * @returns {Array<{ name: string, content: string }>|null}
 */
export function rebuildWorkingFromApplied(originals, suggestions) {
  if (!Array.isArray(originals) || !Array.isArray(suggestions)) return null;
  const sections = originals.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (s.applied !== true) continue;
    const useSentenceEdit = s.old_sentence != null && s.new_sentence != null;
    const rawOld = s.old_sentence != null ? String(s.old_sentence) : '';
    const oldSentence = rawOld.trim();
    const newSentence = effectiveNewSentenceForApply(s);
    const legacyNewContent = (s.new_content || '').trim();
    let secIdx = 0;
    if (useSentenceEdit) {
      if (!oldSentence) continue;
      secIdx = findSectionIndexForOldSentence(sections, rawOld);
      if (secIdx < 0) continue;
    }
    const content = sections[secIdx] ? (sections[secIdx].content || '') : '';
    if (useSentenceEdit) {
      const seg = getLocatableSegment(content, rawOld) || getLocatableSegment(content, oldSentence);
      const toReplace = seg || oldSentence;
      if (content.includes(toReplace)) {
        sections[secIdx].content = content.replace(toReplace, newSentence);
      } else {
        const segNew = getLocatableSegment(content, newSentence);
        if (segNew) sections[secIdx].content = content.replace(segNew, oldSentence);
        else sections[secIdx].content = content.replace(newSentence, oldSentence);
      }
    } else {
      sections[secIdx].content = legacyNewContent;
    }
  }
  return sections;
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
