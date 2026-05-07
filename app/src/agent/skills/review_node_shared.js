import { findWorkflowNodeById } from './run_node_shared.js';

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNodeId(value, label) {
  const normalized = toCleanString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function countScoreRules(scoreMapping) {
  if (!scoreMapping) return 0;
  if (Array.isArray(scoreMapping)) return scoreMapping.reduce((sum, item) => sum + countScoreRules(item), 0);
  if (typeof scoreMapping !== 'object') return 0;
  if (scoreMapping.type === 'rule') return 1;
  if (Array.isArray(scoreMapping.children)) {
    return scoreMapping.children.reduce((sum, item) => sum + countScoreRules(item), 0);
  }
  if (Array.isArray(scoreMapping.rules)) {
    return scoreMapping.rules.reduce((sum, item) => sum + countScoreRules(item), 0);
  }
  if (scoreMapping.inputRoot || scoreMapping.outputRoot) {
    return countScoreRules(scoreMapping.inputRoot) + countScoreRules(scoreMapping.outputRoot);
  }
  if (Array.isArray(scoreMapping.gtColumns) || Object.prototype.hasOwnProperty.call(scoreMapping, 'outputKey')) return 1;
  return 0;
}

export function getReviewSourceChainFromSnapshot(workflowSnapshot, scoreNodeId) {
  const scoreNode = findWorkflowNodeById(workflowSnapshot, scoreNodeId);
  if (!scoreNode || String(scoreNode?.type || '').trim() !== 'score') {
    throw new Error('Score node was not found.');
  }
  const runNodeId = Array.isArray(scoreNode?.upstream)
    ? scoreNode.upstream.map((id) => toCleanString(id)).find(Boolean)
    : '';
  if (!runNodeId) {
    throw new Error('Score node is not connected to an upstream run.');
  }
  const runNode = findWorkflowNodeById(workflowSnapshot, runNodeId);
  if (!runNode || String(runNode?.type || '').trim() !== 'run') {
    throw new Error('Upstream run node was not found.');
  }
  const promptNodeId = Array.isArray(runNode?.upstream)
    ? runNode.upstream.map((id) => toCleanString(id)).find(Boolean)
    : '';
  if (!promptNodeId) {
    throw new Error('Run node is not connected to an upstream prompt.');
  }
  const promptNode = findWorkflowNodeById(workflowSnapshot, promptNodeId);
  if (!promptNode || String(promptNode?.type || '').trim() !== 'prompt') {
    throw new Error('Upstream prompt node was not found.');
  }
  return {
    scoreNode,
    runNode,
    promptNode,
  };
}

export function buildReviewNodeSpec(args = {}, context = {}) {
  const scoreNodeId = normalizeNodeId(args?.score_node_id || args?.scoreNodeId, 'Score node id');
  const reviewCredentialId = toCleanString(args?.review_credential_id || args?.reviewCredentialId);
  const name = toCleanString(args?.name) || 'Review';
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

  const promptSectionCount = Number(context?.promptSectionCount) || 0;
  if (promptSectionCount <= 0) {
    throw new Error('Upstream prompt must include at least one section.');
  }

  const runResultsCount = Number(context?.runResultsCount) || 0;
  if (runResultsCount <= 0) {
    throw new Error('Upstream run must have results before starting review.');
  }

  const scoreRuleCount = Number(context?.scoreRuleCount) || 0;
  if (scoreRuleCount <= 0) {
    throw new Error('Score node must include at least one scoring rule.');
  }

  const groundTruthNodeId = toCleanString(context?.groundTruthNodeId);
  if (!groundTruthNodeId) {
    throw new Error('Score node must select a ground-truth dataset before review.');
  }

  return {
    scoreNodeId,
    ...(reviewCredentialId ? { reviewCredentialId } : {}),
    name,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ensureUniqueName,
    promptSectionCount,
    runResultsCount,
    scoreRuleCount,
    groundTruthNodeId,
    runNodeId: toCleanString(context?.runNodeId),
    promptNodeId: toCleanString(context?.promptNodeId),
    existingReviewCount: Number(context?.existingReviewCount) || 0,
    existingReviewNodeId: toCleanString(context?.existingReviewNodeId),
    resolvedReviewCredentialId: toCleanString(context?.resolvedReviewCredentialId || reviewCredentialId),
  };
}

export function summarizeReviewNodeSpec(spec = {}) {
  return {
    name: toCleanString(spec?.name) || 'Review',
    scoreNodeId: toCleanString(spec?.scoreNodeId || spec?.score_node_id),
    runNodeId: toCleanString(spec?.runNodeId || spec?.run_node_id),
    promptNodeId: toCleanString(spec?.promptNodeId || spec?.prompt_node_id),
    groundTruthNodeId: toCleanString(spec?.groundTruthNodeId || spec?.ground_truth_node_id),
    reviewCredentialId: toCleanString(spec?.resolvedReviewCredentialId || spec?.reviewCredentialId || spec?.review_credential_id),
    scoreRuleCount: Number(spec?.scoreRuleCount) || 0,
    runResultsCount: Number(spec?.runResultsCount) || 0,
    existingReviewCount: Number(spec?.existingReviewCount) || 0,
  };
}

export function buildReviewNodeContext(workflowSnapshot, scoreNodeId) {
  const { scoreNode, runNode, promptNode } = getReviewSourceChainFromSnapshot(workflowSnapshot, scoreNodeId);
  const promptSections = Array.isArray(promptNode?.config?.sections) ? promptNode.config.sections : [];
  const scoreRuleCount = countScoreRules(scoreNode?.config?.scoreMapping);
  const existingReviewNodeId = Array.isArray(scoreNode?.downstream)
    ? scoreNode.downstream
      .map((nodeId) => toCleanString(nodeId))
      .find((nodeId) => {
        const node = findWorkflowNodeById(workflowSnapshot, nodeId);
        return String(node?.type || '').trim() === 'promptReview';
      })
    : '';
  const existingReviewCount = Array.isArray(scoreNode?.downstream)
    ? scoreNode.downstream
      .map((nodeId) => findWorkflowNodeById(workflowSnapshot, nodeId))
      .filter((node) => String(node?.type || '').trim() === 'promptReview')
      .length
    : 0;
  return {
    scoreNodeId: toCleanString(scoreNode?.id),
    runNodeId: toCleanString(runNode?.id),
    promptNodeId: toCleanString(promptNode?.id),
    groundTruthNodeId: toCleanString(scoreNode?.config?.scoreGroundTruthId),
    promptSectionCount: promptSections.length,
    runResultsCount: Number(runNode?.status?.resultsCount) || 0,
    scoreRuleCount,
    existingReviewCount,
    existingReviewNodeId,
    reviewCredentialId: toCleanString(scoreNode?.config?.reviewCredentialId),
  };
}
