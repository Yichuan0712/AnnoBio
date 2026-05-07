import {
  buildReviewNodeContext,
  buildReviewNodeSpec,
  summarizeReviewNodeSpec,
} from '../review_node_shared.js';
import { designReviewNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Review';
}

export const designReviewNodeSkill = Object.freeze({
  meta: designReviewNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Designing review node ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const spec = result?.reviewNode && typeof result.reviewNode === 'object' ? result.reviewNode : result;
    const summary = summarizeReviewNodeSpec(spec);
    return `Prepared review draft ${summary.name} (${summary.scoreRuleCount} rules, ${summary.runResultsCount} run results)`;
  },
  execute({ args = {}, runtime = {} } = {}) {
    const scoreNodeId = args?.score_node_id || args?.scoreNodeId;
    const context = buildReviewNodeContext(runtime?.workflowSnapshot, scoreNodeId);
    const reviewNode = buildReviewNodeSpec(args, {
      ...context,
      resolvedReviewCredentialId: context.reviewCredentialId,
    });
    return {
      drafted: true,
      reviewNode,
      summary: summarizeReviewNodeSpec(reviewNode),
    };
  },
});
