/**
 * The one place that reads and writes where a Run or Process gets its data (docs/design/
 * DATA_FLOW_DESIGN.md §3.3). Works on plain canvas state ({ nodes, connections }), as saved by
 * getCanvasState(); workflowCanvas.js adapts it to the live DOM.
 *
 * A source is { nodeId, port }. For now every source is a Dataset and its port is 'result'.
 */

export const RESULT_PORT = 'result';

const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();
const findNode = (state, id) => (state?.nodes || []).find((node) => nodeIdOf(node) === String(id || '').trim());

/** A stable string for a source, for option values and lookups. */
export function sourceKey(source) {
  return source?.nodeId ? String(source.nodeId) : '';
}

/** @returns {{ nodeId: string, port: string } | null} the source a Run reads */
export function runInputSource(state, runId) {
  const id = String(findNode(state, runId)?.runWorkingSetId || '').trim();
  return id ? { nodeId: id, port: RESULT_PORT } : null;
}

/** Points a Run at `source`, or clears its input when `source` is null. Changes `state` in place. */
export function setRunInputSource(state, runId, source) {
  const run = findNode(state, runId);
  if (!run) return;
  if (source?.nodeId) run.runWorkingSetId = String(source.nodeId);
  else delete run.runWorkingSetId;
}

/** The table a Run reads: its input Dataset's content, or null when it has none. */
export function runInputTable(state, runId) {
  const source = runInputSource(state, runId);
  const dataset = source ? findNode(state, source.nodeId) : null;
  return dataset?.datasetContent || dataset?.subsetContent || null;
}

/** One { fromId, fromPort, toId } per Run that has an input, for drawing and Pipeline detection. */
export function runInputEdges(state) {
  return (state?.nodes || []).filter((node) => node?.type === 'run').flatMap((run) => {
    const source = runInputSource(state, nodeIdOf(run));
    return source ? [{ fromId: source.nodeId, fromPort: source.port, toId: nodeIdOf(run) }] : [];
  });
}
