import { inspectNodeMeta } from './meta.js';

function resolveNodeTitle(workflowSnapshot, nodeId) {
  const normalizedNodeId = String(nodeId || '').trim();
  if (!normalizedNodeId) return '';
  const nodes = Array.isArray(workflowSnapshot?.nodes) ? workflowSnapshot.nodes : [];
  const match = nodes.find((node) => String(node?.id || '').trim() === normalizedNodeId);
  return String(match?.title || '').trim();
}

function parsePositiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const normalized = Math.floor(n);
  return normalized >= 1 ? normalized : null;
}

function buildWindowLabel(args = {}) {
  const startRow = parsePositiveInteger(args?.start_row);
  const maxRows = parsePositiveInteger(args?.max_rows);
  if (!startRow && !maxRows) return '';
  if (startRow && maxRows) {
    return ` rows ${startRow}-${startRow + maxRows - 1}`;
  }
  if (startRow) return ` from row ${startRow}`;
  return ` (${maxRows} rows)`;
}

export const inspectNodeSkill = Object.freeze({
  meta: inspectNodeMeta,
  getProgressLabel({ args = {}, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    const nodeLabel = resolveNodeTitle(runtime?.workflowSnapshot, nodeId) || nodeId || 'node';
    return `Inspecting node ${nodeLabel}${buildWindowLabel(args)}...`;
  },
  summarizeResult({ args = {}, result = null, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    const nodeLabel = resolveNodeTitle(runtime?.workflowSnapshot, nodeId) || String(result?.title || '').trim() || nodeId || 'node';
    const found = result?.found !== false;
    return found
      ? `Inspected ${nodeLabel}${buildWindowLabel(args)}`
      : `Node ${nodeLabel} was not found`;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    const nodeId = String(args?.node_id || '').trim();
    if (!nodeId || typeof runtime.inspectNode !== 'function') return null;
    const startRow = parsePositiveInteger(args?.start_row);
    const maxRows = parsePositiveInteger(args?.max_rows);
    const inspectOptions = {};
    if (startRow) inspectOptions.startRow = startRow;
    if (maxRows) inspectOptions.maxRows = maxRows;
    const raw = runtime.inspectNode(nodeId, inspectOptions);
    const result = await Promise.resolve(raw);
    return result && typeof result === 'object' ? result : null;
  },
});
