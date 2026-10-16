/** Asset cells can appear in input snapshots, output tables, or a Generate's saved input rows. */
export function collectHistoryAssetIds(value) {
  const ids = new Set();
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    if ((item.kind === 'images' || item.kind === 'pdf') && Array.isArray(item.assetIds)) {
      item.assetIds.forEach((id) => { if (typeof id === 'string') ids.add(id); });
    }
    if (Array.isArray(item)) item.forEach(visit);
    else Object.values(item).forEach(visit);
  };
  visit(value);
  return [...ids].sort();
}
