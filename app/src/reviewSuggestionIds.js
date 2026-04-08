/**
 * Per–review-result numeric suggestion_id (1, 2, 3, …): stable while the item exists; not reused after delete.
 * Root field review_suggestion_seq_next = next id to assign (starts at 1; after items 1..n have ids, equals n+1).
 */

const LIST_KEYS = ['design_suggestions', 'data_refinement', 'suggestions'];

export function parseNumericSuggestionId(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function collectMaxNumericId(data) {
  if (!data || typeof data !== 'object') return 0;
  let max = 0;
  for (const key of LIST_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      const n = parseNumericSuggestionId(x?.suggestion_id);
      if (n != null) max = Math.max(max, n);
    }
  }
  return max;
}

/** Keep seq cursor strictly above every existing id. */
export function syncReviewSuggestionSeqNext(data) {
  if (!data || typeof data !== 'object') return;
  const max = collectMaxNumericId(data);
  let next = Number(data.review_suggestion_seq_next);
  if (!Number.isFinite(next) || next < 1) next = max + 1;
  if (next <= max) data.review_suggestion_seq_next = max + 1;
  else data.review_suggestion_seq_next = next;
}

export function allocNextReviewSuggestionId(data) {
  if (!data || typeof data !== 'object') return 1;
  syncReviewSuggestionSeqNext(data);
  const id = Number(data.review_suggestion_seq_next);
  data.review_suggestion_seq_next = id + 1;
  return id;
}

function hasMissingSuggestionId(data) {
  for (const key of LIST_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      if (parseNumericSuggestionId(x.suggestion_id) == null) return true;
    }
  }
  return false;
}

/** Non-empty id that is not a positive integer (e.g. legacy UUID). */
function hasInvalidNonEmptyId(data) {
  for (const key of LIST_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const id = x.suggestion_id;
      if (id == null || id === '') continue;
      if (parseNumericSuggestionId(id) == null) return true;
    }
  }
  return false;
}

/**
 * Reassign suggestion_id to 1..N in UI order: design (no Accept) → data refinement → edit suggestions.
 * Call when a review run finishes so IDs match top-to-bottom order (stream events often append edits before data).
 */
export function normalizeSuggestionIdsToDisplayOrder(data) {
  if (!data || typeof data !== 'object') return false;
  let n = 1;
  let mutated = false;
  for (const key of LIST_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      if (x.suggestion_id !== n) mutated = true;
      x.suggestion_id = n;
      n += 1;
    }
  }
  data.review_suggestion_seq_next = n;
  return mutated;
}

function fillMissingSuggestionIds(data) {
  let mutated = false;
  syncReviewSuggestionSeqNext(data);
  let next = Number(data.review_suggestion_seq_next);
  if (!Number.isFinite(next) || next < 1) next = collectMaxNumericId(data) + 1 || 1;
  for (const key of LIST_KEYS) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      if (parseNumericSuggestionId(x.suggestion_id) == null) {
        x.suggestion_id = next;
        next += 1;
        mutated = true;
      }
    }
  }
  data.review_suggestion_seq_next = next;
  return mutated;
}

/**
 * @param {object} obj
 * @param {object} [dataRoot] review result root (for alloc); if omitted and id missing, uses 1 (avoid in production paths)
 */
export function ensureSuggestionObjectId(obj, dataRoot) {
  if (!obj || typeof obj !== 'object') return obj;
  const n = parseNumericSuggestionId(obj.suggestion_id);
  if (n != null) return { ...obj, suggestion_id: n };
  if (!dataRoot || typeof dataRoot !== 'object') {
    return { ...obj, suggestion_id: 1 };
  }
  return { ...obj, suggestion_id: allocNextReviewSuggestionId(dataRoot) };
}

/**
 * Mutates data in place.
 * @returns {boolean} true if anything changed
 */
export function ensureReviewResultIds(data) {
  if (!data || typeof data !== 'object') return false;
  if (hasInvalidNonEmptyId(data)) {
    return normalizeSuggestionIdsToDisplayOrder(data);
  }
  if (hasMissingSuggestionId(data)) {
    return fillMissingSuggestionIds(data);
  }
  const max = collectMaxNumericId(data);
  let next = Number(data.review_suggestion_seq_next);
  let mutated = false;
  if (!Number.isFinite(next) || next < 1 || next <= max) {
    data.review_suggestion_seq_next = max + 1;
    mutated = true;
  }
  return mutated;
}

/** Badge / assistant: show plain number. */
export function formatSuggestionIdDisplay(suggestionId) {
  const n = parseNumericSuggestionId(suggestionId);
  return n != null ? String(n) : '—';
}
