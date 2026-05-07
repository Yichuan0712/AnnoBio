import {
  buildReviewNodeContext,
  buildReviewNodeSpec,
  summarizeReviewNodeSpec,
} from '../review_node_shared.js';
import { createAndRunReviewNodeMeta } from './meta.js';

function safeNameFromArgs(args = {}) {
  const name = String(args?.name || '').trim();
  return name || 'Review';
}

export const createAndRunReviewNodeSkill = Object.freeze({
  meta: createAndRunReviewNodeMeta,
  getProgressLabel({ args = {} } = {}) {
    return `Creating and starting review ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const reviewNodeId = String(result?.reviewNodeId || result?.nodeId || '').trim();
    if (result?.alreadyRunning) return `Review ${reviewNodeId || 'node'} is already running`;
    if (result?.completed) return `Review ${reviewNodeId || 'node'} completed`;
    if (result?.started) return `Started review ${reviewNodeId || 'node'}`;
    const name = String(result?.name || result?.requestedName || '').trim() || 'Review';
    return `Prepared review ${name}`;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.createAndRunReviewNode !== 'function') {
      throw new Error('Review create-and-run runtime is unavailable.');
    }
    const scoreNodeId = args?.score_node_id || args?.scoreNodeId;
    const context = buildReviewNodeContext(runtime?.workflowSnapshot, scoreNodeId);
    const reviewNode = buildReviewNodeSpec(args, {
      ...context,
      resolvedReviewCredentialId: context.reviewCredentialId,
    });
    const created = await runtime.createAndRunReviewNode(reviewNode);
    return {
      ...created,
      reviewNode,
      summary: summarizeReviewNodeSpec({
        ...reviewNode,
        resolvedReviewCredentialId: created?.reviewCredentialId || reviewNode.resolvedReviewCredentialId,
      }),
    };
  },
});
