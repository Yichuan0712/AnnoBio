/**
 * Locate prompt spans and rebuild section text when suggestions are applied (Review / Finetune / Verify).
 */

/**
 * Find the segment in content that matches oldSentence, so we can replace it even if whitespace differs.
 * @returns {string|null}
 */
export function findSegmentInContent(content, oldSentence) {
  if (content == null || content === '' || oldSentence == null) return null;
  const trimmed = String(oldSentence).trim();
  if (trimmed === '') return null;
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
 * `new_sentence` to use when applying a suggestion (respects finetune before/after toggle in Review detail).
 * @param {Record<string, unknown>} s
 * @returns {string}
 */
export function effectiveNewSentenceForApply(s) {
  if (!s || typeof s !== 'object') return '';
  const after = String(s.new_sentence ?? '').trim();
  if (s.review_finetune_completed !== true) return after;
  if (s.review_finetune_use_before !== true) return after;
  const meta = s.review_finetune_meta;
  const before =
    meta && typeof meta === 'object' && typeof meta.newSentenceBeforeFinetune === 'string'
      ? String(meta.newSentenceBeforeFinetune).trim()
      : '';
  return before !== '' ? before : after;
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
    const secIdx = Math.max(0, Math.min(s.section_index ?? 0, sections.length - 1));
    const useSentenceEdit = s.old_sentence != null && s.new_sentence != null;
    const oldSentence = (s.old_sentence || '').trim();
    const newSentence = effectiveNewSentenceForApply(s);
    const legacyNewContent = (s.new_content || '').trim();
    const content = sections[secIdx] ? (sections[secIdx].content || '') : '';
    if (useSentenceEdit) {
      const seg = getLocatableSegment(content, oldSentence);
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
