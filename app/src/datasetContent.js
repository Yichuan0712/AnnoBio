export function isImageCell(value) {
  return !!value && typeof value === 'object' && value.kind === 'images' && Array.isArray(value.assetIds);
}

export function imageCell(assetIds = [], names = []) {
  return { kind: 'images', assetIds: assetIds.slice(), names: names.slice() };
}

export function moveImageAsset(source, target, index) {
  if (!isImageCell(source) || !Number.isInteger(index) || index < 0 || index >= source.assetIds.length) return null;
  const destination = isImageCell(target) ? target : imageCell();
  return {
    source: imageCell(
      source.assetIds.filter((_, itemIndex) => itemIndex !== index),
      (source.names || []).filter((_, itemIndex) => itemIndex !== index),
    ),
    target: imageCell(
      [...destination.assetIds, source.assetIds[index]],
      [...(destination.names || []), source.names?.[index] || ''],
    ),
  };
}

export function isPdfCell(value) {
  return !!value && typeof value === 'object' && value.kind === 'pdf' && Array.isArray(value.assetIds);
}

export function pdfCell(assetIds = [], names = []) {
  return { kind: 'pdf', assetIds: assetIds.slice(), names: names.slice() };
}

export function isAssetCell(value) {
  return isImageCell(value) || isPdfCell(value);
}

export function cloneCell(value) {
  if (isImageCell(value)) return imageCell(value.assetIds, value.names || []);
  if (isPdfCell(value)) return pdfCell(value.assetIds, value.names || []);
  return String(value ?? '');
}

export function displayCell(value) {
  return isAssetCell(value) ? (value.names?.length ? value.names : value.assetIds).join(', ') : String(value ?? '');
}

/** A column's type is 'image'/'pdf' once any cell in it is that kind of asset cell (declared via
 * columnTypes, or inferred from existing rows so old saves without columnTypes still work). */
function inferColumnType(declaredType, rows, colIndex) {
  if (declaredType === 'image' || rows.some((row) => isImageCell(row[colIndex]))) return 'image';
  if (declaredType === 'pdf' || rows.some((row) => isPdfCell(row[colIndex]))) return 'pdf';
  return 'text';
}

export function normalizeDatasetContent(content = {}) {
  const headers = (content.headers || []).map(String);
  const rawRows = content.rows || [];
  const columnTypes = headers.map((_, i) => inferColumnType(content.columnTypes?.[i], rawRows, i));
  const rows = rawRows.map((row) => headers.map((_, i) => {
    if (columnTypes[i] === 'image') return isImageCell(row[i]) ? cloneCell(row[i]) : imageCell();
    if (columnTypes[i] === 'pdf') return isPdfCell(row[i]) ? cloneCell(row[i]) : pdfCell();
    return cloneCell(row[i]);
  }));
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
