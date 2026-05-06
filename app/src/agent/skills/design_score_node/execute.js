import {
  buildScoreNodeSpec,
  getGroundTruthHeadersFromSnapshot,
  getRunInputHeadersFromSnapshot,
  summarizeScoreNodeSpec,
} from '../score_node_shared.js';
import { designScoreNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Score';
}

export const designScoreNodeSkill = Object.freeze({
  meta: designScoreNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing score node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.scoreNode && typeof result.scoreNode === 'object' ? result.scoreNode : result;
    const summary = summarizeScoreNodeSpec(spec);
    return `Prepared score draft ${summary.name} (${summary.ruleCount} rules)`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    const runNodeId = args?.run_node_id || args?.runNodeId;
    const groundTruthNodeId = args?.ground_truth_node_id || args?.groundTruthNodeId || args?.score_ground_truth_id || args?.scoreGroundTruthId;
    const runInputHeaders = getRunInputHeadersFromSnapshot(runtime?.workflowSnapshot, runNodeId);
    const groundTruthHeaders = getGroundTruthHeadersFromSnapshot(runtime?.workflowSnapshot, groundTruthNodeId);
    const scoreNode = buildScoreNodeSpec(args, { runInputHeaders, groundTruthHeaders });
    return {
      drafted: true,
      scoreNode,
      summary: summarizeScoreNodeSpec(scoreNode),
    };
  },
});
