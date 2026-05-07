import {
  buildRunNodeSpec,
  getDatasetHeadersFromSnapshot,
  getPromptInputFieldsFromSnapshot,
  summarizeRunNodeSpec,
} from '../run_node_shared.js';
import { designRunNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Run';
}

export const designRunNodeSkill = Object.freeze({
  meta: designRunNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing run node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.runNode && typeof result.runNode === 'object' ? result.runNode : result;
    const summary = summarizeRunNodeSpec(spec);
    return `Prepared run draft ${summary.name} (${summary.mappingCount} mapped inputs)`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    const promptNodeId = args?.prompt_node_id || args?.promptNodeId;
    const workingSetId = args?.working_set_id || args?.workingSetId;
    const promptInputFields = getPromptInputFieldsFromSnapshot(runtime?.workflowSnapshot, promptNodeId);
    const datasetHeaders = getDatasetHeadersFromSnapshot(runtime?.workflowSnapshot, workingSetId);
    const runNode = buildRunNodeSpec(args, { promptInputFields, datasetHeaders });
    return {
      drafted: true,
      runNode,
      summary: summarizeRunNodeSpec(runNode),
    };
  },
});
