function errorText(error, fallback = 'Execution failed.') {
  const value = error instanceof Error ? error.message : error;
  return String(value || fallback).trim() || fallback;
}

/** Replace a Results area with a persistent execution error. */
export function showExecutionError(container, {
  title = 'Execution failed',
  error,
  wrapInResultsCard = false,
} = {}) {
  if (!container) return;
  const detail = errorText(error);
  container.replaceChildren();

  const panel = document.createElement('section');
  panel.className = 'execution-error-panel';
  panel.setAttribute('role', 'alert');
  panel.setAttribute('aria-live', 'polite');

  const header = document.createElement('div');
  header.className = 'execution-error-panel__header';
  const heading = document.createElement('strong');
  heading.className = 'execution-error-panel__title';
  heading.textContent = title;
  header.appendChild(heading);

  const body = document.createElement('pre');
  body.className = 'execution-error-panel__detail';
  body.textContent = detail;
  panel.append(header, body);

  if (wrapInResultsCard) {
    const card = document.createElement('div');
    card.className = 'run-detail-results-card execution-error-panel__card';
    card.appendChild(panel);
    container.appendChild(card);
  } else {
    container.appendChild(panel);
  }
}
