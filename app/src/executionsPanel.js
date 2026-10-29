/**
 * The Run tab of the bottom panel (formerly Executions): every Generate to here of the project, newest first
 * (executionRecords.js). A running one can be stopped; a stopped or failed one resumed, which plans
 * its target again. A step shows its node on the canvas.
 */
import './executionsPanel.css';
import { executionSummary } from './executionRecords.js';
import { iconProcess, iconRun } from './icons.js';

const STATUS_LABELS = { running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' };
const STEP_LABELS = {
  reused: 'Used existing result', pending: 'Waiting', running: 'Running', completed: 'Ran',
  failed: 'Failed', stopped: 'Stopped', 'not-started': 'Not started', interrupted: 'Interrupted',
};
const KIND_LABELS = { run: 'Generate', process: 'Process' };

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stepHtml(step) {
  const errors = step.errorRows ? ` · ${step.errorRows} row${step.errorRows === 1 ? '' : 's'} with errors` : '';
  return `<li>
    <button type="button" class="executions__step" data-action="show" data-node-id="${escapeHtml(step.nodeId)}" title="Show on the canvas">
      <span class="pipeline-step-icon pipeline-step-icon--${step.kind === 'run' ? 'run' : 'process'}" role="img" aria-label="${escapeHtml(KIND_LABELS[step.kind] || step.kind)}" title="${escapeHtml(KIND_LABELS[step.kind] || step.kind)}">${(step.kind === 'run' ? iconRun : iconProcess)(16).outerHTML}</span>
      <span class="executions__step-name">${escapeHtml(step.name)}</span>
      <span class="executions__step-status executions__step-status--${escapeHtml(step.status)}">${escapeHtml(STEP_LABELS[step.status] || step.status)}${errors}</span>
    </button>
    ${step.message ? `<p class="executions__message${step.status === 'failed' ? '' : ' executions__message--note'}">${escapeHtml(step.message)}</p>` : ''}
  </li>`;
}

function recordHtml(record, { open, active }) {
  const when = new Date(record.createdAt).toLocaleString();
  const action = record.status === 'running' && active
    ? `<button type="button" class="btn btn-secondary executions__action" data-action="stop" data-record-id="${escapeHtml(record.id)}">Stop</button>`
    : record.status === 'failed' || record.status === 'stopped'
      ? `<button type="button" class="btn btn-secondary executions__action" data-action="resume" data-record-id="${escapeHtml(record.id)}" title="Plan this target again: finished steps are reused, a stopped Run continues">Resume</button>`
      : '';
  return `<li class="executions__record${open ? ' is-open' : ''}">
    <div class="executions__head">
      <button type="button" class="executions__toggle" data-action="toggle" data-record-id="${escapeHtml(record.id)}" aria-expanded="${open}">
        <span class="executions__chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
        <span class="executions__title">${record.mode === 'restart' ? 'Restart pipeline to' : record.scope === 'this' ? (record.mode === 'resume-node' ? 'Resume' : 'Run only') : 'Resume pipeline to'} "${escapeHtml(record.targetName || 'step')}"</span>
        <span class="executions__status executions__status--${escapeHtml(record.status)}">${escapeHtml(STATUS_LABELS[record.status] || record.status)}</span>
        <span class="executions__summary">${escapeHtml(executionSummary(record))}</span>
        <span class="executions__time">${escapeHtml(when)}${record.source === 'agent' ? ' · by the Agent' : ''}</span>
      </button>
      ${action}
    </div>
    ${open ? `<div class="executions__body">
      ${record.error ? `<p class="executions__message${record.status === 'failed' ? '' : ' executions__message--note'}">${escapeHtml(record.error)}</p>` : ''}
      ${record.inputs?.length ? `<p class="executions__inputs">Reads: ${escapeHtml(record.inputs.map((input) => `${input.name}${input.rows == null ? '' : ` (${input.rows.toLocaleString('en-US')} row${input.rows === 1 ? '' : 's'})`}`).join(', '))}</p>` : ''}
      <ol class="executions__steps">${record.steps.map(stepHtml).join('')}</ol>
    </div>` : ''}
  </li>`;
}

/**
 * @param {HTMLElement} container the tab's host
 * @param {{ getRecords: () => object[], isActive: (recordId: string) => boolean,
 *   onStop: (recordId: string) => void, onResume: (record: object) => void, revealNode: (nodeId: string) => void }} options
 */
export function mountExecutionsPanel(container, { getRecords, isActive, onStop, onResume, revealNode }) {
  const view = document.createElement('div');
  view.className = 'workspace-dock executions';
  container.appendChild(view);
  const opened = new Set();
  let previousHtml = '';

  function refresh() {
    const records = getRecords().slice().reverse();
    // The newest running one starts open, so its progress shows without a click.
    const running = records.find((record) => record.status === 'running');
    if (running && !opened.has(`seen:${running.id}`)) {
      opened.add(running.id);
      opened.add(`seen:${running.id}`);
    }
    const html = records.length
      ? `<ol class="executions__list">${records.map((record) => recordHtml(record, { open: opened.has(record.id), active: isActive(record.id) })).join('')}</ol>`
      : '<p class="executions__empty">No runs yet. Right-click a Generate or Process node to run only that node, resume its pipeline to that point, or restart its pipeline from the beginning.</p>';
    if (html === previousHtml) return;
    previousHtml = html;
    view.innerHTML = html;
  }

  view.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !view.contains(button)) return;
    const { action, recordId, nodeId } = button.dataset;
    if (action === 'toggle') {
      if (opened.has(recordId)) opened.delete(recordId);
      else opened.add(recordId);
      refresh();
    } else if (action === 'show') revealNode(nodeId);
    else if (action === 'stop') {
      button.disabled = true;
      button.textContent = 'Stopping…';
      onStop(recordId);
    } else if (action === 'resume') {
      const record = getRecords().find((item) => item.id === recordId);
      if (record) onResume(record);
    }
  });

  refresh();
  return { refresh };
}
