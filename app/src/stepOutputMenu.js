/**
 * The right-click menu items that start a new step on a Run's or Process's output (docs/design/
 * DATA_FLOW_DESIGN.md §5.2). Pure; works on canvas state as getCanvasState() saves it.
 */
import { effectiveProcessOutputs, showsProcessOutputs } from './processOutputPorts.js';

const RESULT = 'result';
const nodeIdOf = (node) => String(node?.nodeId || node?.id || '').trim();

/**
 * A Run offers its results; a Process each output branch it is known to return. With `port`, only
 * that branch's items, as clicking its label on the node shows them. Items are offered before the
 * step has a result, so a pipeline can be built first and run afterwards.
 * @param {object} state canvas state
 * @param {string} nodeId a Run or Process
 * @param {{ port?: string }} [options]
 * @returns {Array<{ action: 'run-prompt-on-output' | 'process-output', label: string,
 *   source: { nodeId: string, port: string, kind: 'run' | 'process' } }>}
 */
export function stepOutputMenuItems(state, nodeId, { port } = {}) {
  const node = (state?.nodes || []).find((item) => nodeIdOf(item) === String(nodeId || '').trim());
  if (node?.type !== 'run' && node?.type !== 'process') return [];
  let ports = [RESULT];
  let named = false;
  if (node.type === 'process') {
    const outputs = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
    ports = outputs.ports;
    named = showsProcessOutputs(outputs);
  }
  if (port !== undefined) ports = ports.filter((item) => item === port);
  const sources = ports.map((item) => ({ nodeId: nodeIdOf(node), port: item, kind: node.type }));
  return [
    ...sources.map((source) => ({
      action: 'run-prompt-on-output',
      label: named ? `Run a prompt on '${source.port}'` : 'Run a prompt on results',
      source,
    })),
    ...sources.map((source) => ({
      action: 'process-output',
      label: named ? `Process '${source.port}' with code` : 'Process results with code',
      source,
    })),
  ];
}
