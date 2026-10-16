/** Names follow the pipeline's entry steps and branch-kind choices, never its display number. */
export function pipelineNameKey(pipeline, scopes = []) {
  const steps = pipeline.steps || [];
  const downstream = new Set(steps.filter(step => step.kind === 'dataset' && step.producerStepId)
    .flatMap(step => step.consumerStepIds || []));
  const executable = steps.filter(step => step.kind !== 'dataset');
  const roots = executable.filter(step => !downstream.has(step.id)).map(step => step.id);
  return JSON.stringify({ roots: (roots.length ? roots : executable.map(step => step.id)).slice(0, 1), scopes: scopes.slice().sort() });
}

export function normalizePipelineNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, name]) => typeof name === 'string' && name.trim())
    .map(([key, name]) => [key, name.trim()]));
}

export function pipelineDisplayName(pipeline, index) {
  return String(pipeline?.name || '').trim() || `Pipeline ${index + 1}`;
}
