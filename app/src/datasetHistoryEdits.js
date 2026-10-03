/**
 * Manual edits to a Dataset that shows a Run/Process History result. Each edit is stored on the
 * Dataset under the upstream record (and output branch) it was made on, so the Dataset keeps
 * following History: that record shows the edited table, other records show their own output,
 * and the upstream History lists which of its records were edited manually.
 */

const editKey = (sourceRecordId, branch) => `${sourceRecordId}:${branch}`;

/** Parses the stored map (a JSON string on a live node, an object in canvas state). */
export function readHistoryEdits(value) {
  if (!value) return {};
  let edits = value;
  if (typeof value === 'string') {
    try { edits = JSON.parse(value); } catch (_) { return {}; }
  }
  return edits && typeof edits === 'object' && !Array.isArray(edits) ? edits : {};
}

/** @returns {object|null} the hand-edited table for this upstream record and branch, if any */
export function historyEditFor(historyEdits, sourceRecordId, branch) {
  if (!sourceRecordId) return null;
  return readHistoryEdits(historyEdits)[editKey(sourceRecordId, branch)] || null;
}

/** Returns a new map with the edit set, or removed when `content` is null. */
export function withHistoryEdit(historyEdits, sourceRecordId, branch, content) {
  const next = { ...readHistoryEdits(historyEdits) };
  if (content) next[editKey(sourceRecordId, branch)] = content;
  else delete next[editKey(sourceRecordId, branch)];
  return next;
}

/** Upstream record IDs that have a manual edit on this Dataset. */
export function editedSourceRecordIds(historyEdits) {
  return new Set(Object.keys(readHistoryEdits(historyEdits)).map((key) => key.slice(0, key.indexOf(':'))));
}
