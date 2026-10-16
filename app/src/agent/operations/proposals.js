/**
 * propose_changes end to end: previewing a proposal for the confirmation card, and applying it once
 * the user approves. Both plan against the live canvas (it may have changed in between), so applying
 * re-validates everything; imports are fetched only at apply time.
 */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { planChangeSet } from './changeSet.js';

/** Keep the full canvas API: History operations need more than table-editing methods. */
export function createProposalRuntime(workspace) {
  return {
    previewProposal: (proposal) => previewProposal(proposal, workspace),
    applyProposal: (proposal, options) => applyProposal(proposal, workspace, options),
  };
}

const IMPORT_POLL_MS = 1200;
const IMPORT_MAX_WAIT_MS = 5 * 60 * 1000;

let sourcesPromise = null;

async function evaluationPromptsFor(operations, workspace) {
  if (!workspace.getEvaluationPayload) return null;
  const prompts = new Map();
  for (const op of operations || []) {
    if (op?.op !== 'apply_review') continue;
    const review = workspace.getCanvasState().nodes.find(node => node.nodeId === String(op.review || '').trim());
    if (!review?.evaluateRecordId || prompts.has(review.evaluateRecordId)) continue;
    const payload = await workspace.getEvaluationPayload(review.evaluateNodeId, { recordId: review.evaluateRecordId });
    if (!payload.prompt_snapshot) throw new Error('The original Prompt snapshot is unavailable.');
    prompts.set(review.evaluateRecordId, payload.prompt_snapshot);
  }
  return prompts;
}

/** Importable sources and their fields, from GET /api/agent/sources (cached per session). */
export function loadSources() {
  if (!sourcesPromise) {
    sourcesPromise = fetch(`${BACKEND_API_BASE}/api/agent/sources`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Could not load import sources.'))))
      .catch((error) => {
        sourcesPromise = null;
        throw error;
      });
  }
  return sourcesPromise;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Rows for one import, through the same background job the Add Dataset dialog uses. */
async function fetchSourceRows(source, ids, fields, signal) {
  const start = await fetch(`${BACKEND_API_BASE}/api/${source}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, fields }),
    signal,
  });
  const started = await start.json().catch(() => ({}));
  if (!start.ok || !started.job_id) throw new Error(started.detail || `Could not start the ${source} import.`);
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > IMPORT_MAX_WAIT_MS) throw new Error(`The ${source} import timed out.`);
    const res = await fetch(`${BACKEND_API_BASE}/api/${source}/import/result/${started.job_id}`, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.detail || `The ${source} import failed.`);
    if (data.status === 'running') {
      await sleep(IMPORT_POLL_MS);
      continue;
    }
    if (data.error) throw new Error(String(data.error));
    if (!Array.isArray(data.rows) || data.rows.length === 0) throw new Error(`The ${source} import found none of the requested records.`);
    return { headers: data.headers || [], rows: data.rows, notFound: data.not_found || [] };
  }
}

/**
 * @param {{operations: object[]}} proposal the propose_changes arguments
 * @param {{getCanvasState: Function, extractInputFields: Function}} workspace
 * @returns {Promise<{ok: true, items: object[], warnings: string[]} | {ok: false, error: string}>}
 */
export async function previewProposal(proposal, workspace) {
  try {
    const historyOperations = (proposal?.operations || []).filter((op) => ['select_history', 'delete_history'].includes(op?.op));
    if (historyOperations.length) {
      const op = historyOperations[0];
      if (proposal.operations.length !== 1 || !op.record_id) throw new Error(`${op.op} must be the only operation and needs record_id.`);
      if (op.op === 'delete_history') {
        const plan = await workspace.previewHistoryDeletion(op.record_id);
        return { ok: true, items: [{ kind: 'remove', type: 'history', title: 'Delete saved history',
          nodeIds: [...new Set(plan.records.map((record) => record.nodeId))],
          lines: [`Delete ${plan.records.length} history record${plan.records.length === 1 ? '' : 's'}, including dependent results.`, 'This cannot be undone.'], diffs: [] }], warnings: [] };
      }
      const plan = await workspace.previewHistorySelection(op.record_id);
      return { ok: true, items: [{ kind: 'update', type: 'history', title: 'Select saved node history',
        nodeIds: plan.changedNodeIds, lines: [`Restore inputs on ${plan.changedNodeIds.length} nodes.`, `Affected pipeline nodes: ${plan.affectedNodeIds.length}.`], diffs: [] }], warnings: [] };
    }
    const sources = await loadSources();
    const contentLocks = await workspace.getContentLocks?.();
    const evaluationPrompts = await evaluationPromptsFor(proposal?.operations, workspace);
    const plan = planChangeSet(workspace.getCanvasState(), proposal?.operations, {
      extractInputFields: workspace.extractInputFields,
      sources,
      contentLocks,
      evaluationPrompts,
    });
    return {
      ok: true,
      items: plan.items.map(({ kind, type, title, lines, diffs, nodeIds }) => ({ kind, type, title, lines, diffs, nodeIds })),
      warnings: plan.warnings,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fetch any imports, re-plan against the current canvas and load the result as one undo step.
 * @param {object} workspace as for previewProposal, plus applyCanvasState(state, {highlightNodeIds})
 * @returns {Promise<object>} the tool result the Agent sees
 */
export async function applyProposal(proposal, workspace, { signal, onStatus } = {}) {
  const operations = Array.isArray(proposal?.operations) ? proposal.operations : [];
  if (operations.some((op) => op?.op === 'select_history')) {
    if (operations.length !== 1 || !operations[0].record_id) throw new Error('select_history must be the only operation and needs record_id.');
    const plan = await workspace.applyHistorySelection(operations[0].record_id);
    return { status: 'applied', changes: [`Selected history record ${operations[0].record_id}`], affectedNodeIds: plan.affectedNodeIds };
  }
  if (operations.some((op) => op?.op === 'delete_history')) {
    if (operations.length !== 1 || !operations[0].record_id) throw new Error('delete_history must be the only operation and needs record_id.');
    const plan = await workspace.applyHistoryDeletion(operations[0].record_id);
    return { status: 'applied', changes: [`Deleted ${plan.records.length} history records`], affectedNodeIds: [...new Set(plan.records.map((record) => record.nodeId))] };
  }
  const sources = await loadSources();
  const imported = new Map();
  for (const [index, op] of operations.entries()) {
    if (op?.op !== 'import_dataset') continue;
    onStatus?.(`Importing from ${sources[op.source]?.label || op.source}...`);
    imported.set(index, await fetchSourceRows(op.source, op.ids, op.fields, signal));
  }
  const contentLocks = await workspace.getContentLocks?.();
  const evaluationPrompts = await evaluationPromptsFor(operations, workspace);
  const plan = planChangeSet(workspace.getCanvasState(), operations, {
    extractInputFields: workspace.extractInputFields,
    sources,
    imported,
    contentLocks,
    evaluationPrompts,
  });
  workspace.applyCanvasState(plan.state, { highlightNodeIds: plan.nodeIds });
  const byId = new Map(plan.state.nodes.map((n) => [n.nodeId, n]));
  return {
    status: 'applied',
    created: Object.fromEntries(Object.entries(plan.refs).map(([ref, id]) => [ref, { id, type: byId.get(id)?.type }])),
    changes: plan.items.map((item) => item.title),
    warnings: plan.warnings.length ? plan.warnings : undefined,
  };
}
