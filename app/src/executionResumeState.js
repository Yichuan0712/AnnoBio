/** Shared labels for canvas nodes whose work can be restarted after interruption. */
export function executionIdleLabel({ completed = false, interrupted = false, hasPartial = false, failed = false } = {}) {
  if (completed) return 'Run again';
  if (interrupted || hasPartial) return 'Resume';
  if (failed) return 'Retry';
  return 'Run';
}

export function reviewNeedsResume({ result = null, interrupted = false, streaming = false } = {}) {
  if (streaming) return false;
  if (result?.streamComplete === true) return false;
  return interrupted || result?.streamComplete === false;
}
