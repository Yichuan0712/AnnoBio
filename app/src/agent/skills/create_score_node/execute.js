import {
  buildScoreNodeSpec,
  getGroundTruthHeadersFromSnapshot,
  getRunInputHeadersFromSnapshot,
  summarizeScoreNodeSpec,
} from '../score_node_shared.js';
import { createScoreNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Score';
}

export const createScoreNodeSkill = Object.freeze({
  meta: createScoreNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating score node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'Score';
    const nodeId = String(result?.nodeId || '').trim();
    return nodeId ? `Created score node ${name}` : `Prepared score node ${name}`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.addScoreNode !== 'function') {
      throw new Error('Score node creation runtime is unavailable.');
    }
    const runNodeId = args?.run_node_id || args?.runNodeId;
    const groundTruthNodeId = args?.ground_truth_node_id || args?.groundTruthNodeId || args?.score_ground_truth_id || args?.scoreGroundTruthId;
    const runInputHeaders = getRunInputHeadersFromSnapshot(runtime?.workflowSnapshot, runNodeId);
    const groundTruthHeaders = getGroundTruthHeadersFromSnapshot(runtime?.workflowSnapshot, groundTruthNodeId);
    const scoreNode = buildScoreNodeSpec(args, { runInputHeaders, groundTruthHeaders });
    const created = runtime.addScoreNode(scoreNode);
    return {
      ...created,
      scoreNode,
      summary: summarizeScoreNodeSpec(scoreNode),
    };
  },
});
