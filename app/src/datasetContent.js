export function isImageCell(value) {
  return !!value && typeof value === 'object' && value.kind === 'images' && Array.isArray(value.assetIds);
}

export function imageCell(assetIds = [], names = []) {
  return { kind: 'images', assetIds: assetIds.slice(), names: names.slice() };
}

export function cloneCell(value) {
  return isImageCell(value) ? imageCell(value.assetIds, value.names || []) : String(value ?? '');
}

export function displayCell(value) {
  return isImageCell(value) ? (value.names?.length ? value.names : value.assetIds).join(', ') : String(value ?? '');
}

export function normalizeDatasetContent(content = {}) {
  const headers = (content.headers || []).map(String);
  const columnTypes = headers.map((_, i) => content.columnTypes?.[i] === 'image'
    || (content.rows || []).some((row) => isImageCell(row[i])) ? 'image' : 'text');
  const rows = (content.rows || []).map((row) => headers.map((_, i) =>
    columnTypes[i] === 'image' ? (isImageCell(row[i]) ? cloneCell(row[i]) : imageCell()) : cloneCell(row[i])));
  const seen = new Set();
  const rowIds = rows.map((_, i) => {
    const id = content.rowIds?.[i];
    const next = typeof id === 'string' && id && !seen.has(id) ? id : globalThis.crypto.randomUUID();
    seen.add(next);
    return next;
  });
  return { schemaVersion: 2, headers, columnTypes, rowIds, rows };
}

export const cloneDatasetContent = normalizeDatasetContent;

// Normalizing at the storage boundary protects all canvas/Agent mutation paths.
export class DatasetContentMap extends Map {
  set(key, value) {
    return super.set(key, normalizeDatasetContent(value));
  }
}

export function inputValues(headers, row, mapping) {
  return Object.fromEntries(Object.entries(mapping || {}).map(([name, column]) =>
    [name, cloneCell(row[headers.indexOf(column)])]));
}

export function readInputTypes(node) {
  try { return JSON.parse(node?.dataset?.promptInputTypes || '{}'); } catch { return {}; }
}
