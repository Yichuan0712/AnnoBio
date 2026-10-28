/**
 * propose_changes end to end: previewing a proposal for the confirmation card, and applying it once
 * the user approves. Both plan against the live canvas (it may have changed in between), so applying
 * re-validates everything; imports are fetched, and attached image/PDF files copied into the project,
 * only at apply time.
 */
import { BACKEND_API_BASE } from '../../backendConfig.js';
import { testedModels } from '../../modelPicker.js';
import { planChangeSet } from './changeSet.js';
import { sourceJob, sourceOptions, sourcesForImports } from './sourceImports.js';

/** Keep the full canvas API: History operations need more than table-editing methods. */
export function createProposalRuntime(workspace) {
  return {
    previewProposal: (proposal) => previewProposal(proposal, workspace),
    applyProposal: (proposal, options) => applyProposal(proposal, workspace, options),
  };
}

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

/** What Save to workspace saves for each Evaluate an operation saves, by Evaluate id. */
async function scoreTablesFor(operations, workspace) {
  const tables = new Map();
  for (const op of operations || []) {
    const id = String(op?.score || '').trim();
    if (op?.op !== 'save_score_results' || !id || tables.has(id) || !workspace.getScoreSaveTable) continue;
    const table = await workspace.getScoreSaveTable(id);
    if (table) tables.set(id, table);
  }
  return tables;
}

/**
 * For each import_attachment (by operation index): the chat attachments it names and what was read from
 * them, for changeSet.js's import_attachment. A table is read each time (the file may have changed since
 * the proposal); `store` copies image and PDF files into the project, which only applying does.
 */
async function attachmentsFor(operations, workspace, { store = false, onStatus, importSnapshots = {} } = {}) {
  const entries = new Map();
  for (const [index, op] of (operations || []).entries()) {
    if (op?.op !== 'import_attachment' || !workspace.findAttachment) continue;
    if (op.folder) {
      if (!workspace.resolveFolderImport) throw new Error('Local folder imports are available only in the desktop app.');
      if (store && !importSnapshots[index]) throw new Error('The folder import needs a fresh preview.');
      entries.set(index, await workspace.resolveFolderImport(op, { token: importSnapshots[index], store }));
      continue;
    }
    const ids = (Array.isArray(op.attachments) ? op.attachments : [op.attachments]).map((id) => String(id || '').trim()).filter(Boolean);
    const attachments = ids.map((id) => workspace.findAttachment(id)).filter(Boolean);
    if (workspace.resolvePathImports && attachments.some((item) => item.grantId)) {
      if (store && !importSnapshots[index]) throw new Error('The local file import needs a fresh preview.');
      entries.set(index, await workspace.resolvePathImports(op, { token: importSnapshots[index], store }));
      continue;
    }
    const kinds = new Set(attachments.map((a) => a.kind));
    const entry = { attachments };
    await workspace.validateAttachments?.(attachments);
    if (attachments.length === 1 && kinds.has('table')) {
      entry.table = await workspace.readAttachmentTable(attachments[0], op.sheet);
    } else if (store && attachments.length && attachments.length === ids.length && kinds.size === 1 && (kinds.has('image') || kinds.has('pdf'))) {
      onStatus?.(`Copying ${attachments.length} attached file${attachments.length === 1 ? '' : 's'} into the project...`);
      entry.assets = await workspace.storeAttachmentFiles(attachments);
    }
    entries.set(index, entry);
  }
  return entries;
}

/** The models the Create Generate and Optimize prompt pickers offer, by credential id. */
const pickableModels = (workspace) => new Map(testedModels([...(workspace.credentialsById?.values() || [])]).map((c) => [c.id, c]));

/** Importable sources and their fields, from GET /api/agent/sources (cached per session). */
export function loadSources({ refresh = false } = {}) {
  if (refresh) sourcesPromise = null;
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

/** Rows for one import, through the same background job the Add Dataset dialog uses. */
async function fetchSourceRows(source, ids, fields, options, { signal, onStatus } = {}) {
  const data = await sourceJob(source, `/api/${source}/import`, { ids: ids || [], fields, options }, { signal, onStatus });
  if (!Array.isArray(data.rows) || !data.rows.length) throw new Error(`The ${source} import returned no rows matching the requested records and filters.`);
  return { headers: data.headers || [], rows: data.rows, notFound: data.not_found || [], truncated: data.truncated === true };
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
    const sources = await sourcesForImports(await loadSources({ refresh: true }), proposal?.operations);
    const contentLocks = await workspace.getContentLocks?.();
    const evaluationPrompts = await evaluationPromptsFor(proposal?.operations, workspace);
    const scoreTables = await scoreTablesFor(proposal?.operations, workspace);
    const attachments = await attachmentsFor(proposal?.operations, workspace);
    const plan = planChangeSet(workspace.getCanvasState(), proposal?.operations, {
      extractInputFields: workspace.extractInputFields,
      sources,
      contentLocks,
      evaluationPrompts,
      models: pickableModels(workspace),
      scoreTables,
      attachments,
    });
    return {
      ok: true,
      items: plan.items.map(({ kind, type, title, lines, diffs, nodeIds }) => ({ kind, type, title, lines, diffs, nodeIds })),
      warnings: plan.warnings,
      importSnapshots: Object.fromEntries([...attachments].filter(([, entry]) => entry.snapshotToken).map(([index, entry]) => [index, entry.snapshotToken])),
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
export async function applyProposal(proposal, workspace, { signal, onStatus, importSnapshots } = {}) {
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
  const sources = await sourcesForImports(await loadSources({ refresh: true }), operations, { signal });
  // Validate source choices and filters again before any approved transfer starts.
  const sourceOperations = operations.filter((op) => ['download_dataset', 'import_dataset'].includes(op?.op));
  if (sourceOperations.length) planChangeSet(workspace.getCanvasState(), sourceOperations, { sources, extractInputFields: workspace.extractInputFields });
  const imported = new Map();
  for (const [index, op] of operations.entries()) {
    if (op?.op === 'download_dataset') {
      onStatus?.(`Downloading ${op.dataset}...`);
      await sourceJob(op.source, `/api/reference/import/sources/${op.source}/download`, { dataset: op.dataset }, { signal, onStatus, download: true });
      continue;
    }
    if (op?.op !== 'import_dataset') continue;
    onStatus?.(`Importing from ${sources[op.source]?.label || op.source}...`);
    const info = sources[`${op.source}:${op.options?.dataset}`] || sources[op.source];
    imported.set(index, await fetchSourceRows(op.source, op.ids, op.fields, sourceOptions(info, op.options), { signal, onStatus }));
  }
  const contentLocks = await workspace.getContentLocks?.();
  const evaluationPrompts = await evaluationPromptsFor(operations, workspace);
  const scoreTables = await scoreTablesFor(operations, workspace);
  const attachments = await attachmentsFor(operations, workspace, { store: true, onStatus, importSnapshots });
  const plan = planChangeSet(workspace.getCanvasState(), operations, {
    extractInputFields: workspace.extractInputFields,
    sources,
    imported,
    contentLocks,
    evaluationPrompts,
    models: pickableModels(workspace),
    scoreTables,
    attachments,
  });
  if (operations.some((op) => op.op !== 'download_dataset')) workspace.applyCanvasState(plan.state, { highlightNodeIds: plan.nodeIds });
  const byId = new Map(plan.state.nodes.map((n) => [n.nodeId, n]));
  return {
    status: 'applied',
    created: Object.fromEntries(Object.entries(plan.refs).map(([ref, id]) => [ref, { id, type: byId.get(id)?.type }])),
    changes: plan.items.map((item) => item.title),
    warnings: plan.warnings.length ? plan.warnings : undefined,
  };
}
