import {
  buildRunNodeSpec,
  getDatasetHeadersFromSnapshot,
  getPromptInputFieldsFromSnapshot,
  summarizeRunNodeSpec,
} from '../run_node_shared.js';
import { createRunNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Run';
}

export const createRunNodeSkill = Object.freeze({
  meta: createRunNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating run node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Run';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created run node ${name}` : `Prepared run node ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addRunNode !== 'function') {
      throw new Error('Run node creation runtime is unavailable.');
    }
    const promptNodeId = args?.prompt_node_id || args?.promptNodeId;
    const workingSetId = args?.working_set_id || args?.workingSetId;
    const promptInputFields = getPromptInputFieldsFromSnapshot(runtime?.workflowSnapshot, promptNodeId);
    const datasetHeaders = getDatasetHeadersFromSnapshot(runtime?.workflowSnapshot, workingSetId);
    const runNode = buildRunNodeSpec(args, { promptInputFields, datasetHeaders });
    const created = runtime.addRunNode(runNode);
    return {
      ...created,
      runNode,
      summary: summarizeRunNodeSpec(runNode),
    };
  },
});
