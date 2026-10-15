/** Shared state labels, with task-specific verbs for the three execution buttons. */
const EXECUTION_LABELS = {
  default: { start: 'Run', again: 'Run again', resume: 'Resume', retry: 'Retry' },
  generation: { start: 'Generate', again: 'Generate again', resume: 'Resume generation', retry: 'Retry generation' },
  processing: { start: 'Run code', again: 'Run code again', resume: 'Resume processing', retry: 'Retry processing' },
  matching: { start: 'Run matching code', again: 'Run matching code again', resume: 'Resume matching', retry: 'Retry matching' },
};

export function executionIdleLabel({ completed = false, interrupted = false, hasPartial = false, failed = false, task = 'default' } = {}) {
  const labels = EXECUTION_LABELS[task] || EXECUTION_LABELS.default;
  if (completed) return labels.again;
  if (interrupted || hasPartial) return labels.resume;
  if (failed) return labels.retry;
  return labels.start;
}

export function reviewNeedsResume({ result = null, interrupted = false, streaming = false } = {}) {
  if (streaming) return false;
  if (result?.streamComplete === true) return false;
  return interrupted || result?.streamComplete === false;
}
