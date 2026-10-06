/** Build readable, collision-safe Python names for a Process and its canvas Datasets. */
function baseName(value) {
  const normalized = String(value || 'dataset').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const name = normalized.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return name || 'dataset';
}

export function buildProcessDatasetBindings(datasets, primaryDatasetId) {
  const used = new Set();
  return (datasets || []).map((dataset) => {
    const primary = dataset.nodeId === primaryDatasetId;
    if (primary) return { ...dataset, alias: 'df', primary: true };
    const root = `df_${baseName(dataset.name)}`;
    let alias = root;
    let suffix = 2;
    while (used.has(alias)) alias = `${root}_${suffix++}`;
    used.add(alias);
    return { ...dataset, alias, primary: false };
  });
}

/** Python aliases always start with `df_`; the Dataset-derived part may start with a digit. */
export function referencedDatasetAliasNames(code) {
  return new Set(String(code || '').match(/\bdf_[A-Za-z0-9_]+\b/g) || []);
}

export function referencedDatasetAliases(code, bindings, savedAliases = {}) {
  const aliases = referencedDatasetAliasNames(code);
  const available = new Set((bindings || []).map((binding) => binding.nodeId));
  const explicit = new Map();
  for (const [nodeId, alias] of Object.entries(savedAliases || {})) {
    if (!available.has(nodeId) || !aliases.has(alias)) continue;
    if (!explicit.has(alias)) explicit.set(alias, new Set());
    explicit.get(alias).add(nodeId);
  }
  const result = new Set();
  for (const alias of aliases) {
    const exact = explicit.get(alias);
    if (exact?.size) exact.forEach((nodeId) => result.add(nodeId));
    else (bindings || []).filter((binding) => binding.alias === alias).forEach((binding) => result.add(binding.nodeId));
  }
  return result;
}
