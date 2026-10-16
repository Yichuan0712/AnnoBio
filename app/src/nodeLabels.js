/** Product names only. Persisted node types, names and API fields keep their original values. */
export const GENERATE_LABEL = 'Generate';

export function isDefaultGenerateName(name) {
  const value = String(name ?? '').trim();
  return !value || value === 'Run' || value === GENERATE_LABEL;
}

/** The exact legacy default is an alias; never replace substrings in user-authored names. */
export function generateDisplayName(name) {
  const value = String(name ?? '').trim();
  return !value || value === 'Run' ? GENERATE_LABEL : value;
}

export function nodeTypeLabel(type) {
  return {
    run: GENERATE_LABEL, process: 'Process', prompt: 'Prompt', dataset: 'Dataset',
    sampler: 'Sample', score: 'Evaluate', promptReview: 'Optimize',
  }[type] || String(type || 'Node');
}
