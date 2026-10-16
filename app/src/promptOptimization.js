/**
 * Prompt families follow version edges and Optimize → Evaluate → Generate → Prompt ancestry.
 * Each family also lists its rounds: one Evaluate & Optimize step per Optimize (or per Evaluate
 * not optimized yet) reached from a version through Generate → Evaluate.
 */
import { generateDisplayName } from './nodeLabels.js';
import { runInputSource, stepSourceLabel } from './stepInputs.js';

const nodeId = (node) => String(node?.nodeId || node?.id || '');

const METHOD_NAMES = {
  issue_analysis_suggestions: 'Thompson Prompt Search',
  gepa: 'GEPA', miprov2: 'MIPROv2', bootstrap_fewshot: 'Bootstrap Few-Shot',
  textgrad: 'TextGrad', copro: 'COPRO', simba: 'SIMBA',
};

const methodName = (methodId) => (methodId ? METHOD_NAMES[methodId] || methodId : '');
/** The method chosen for an Optimize, else the one its result records it used. */
function reviewMethodId(review) {
  let result = review?.reviewResult;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch (_) { result = null; }
  }
  return String(review?.reviewMethodId || result?.review_method_id || '').trim();
}

export function buildPromptFamilies(canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const byId = new Map(nodes.map((node) => [nodeId(node), node]));
  const prompts = nodes.filter((node) => node.type === 'prompt').map(nodeId);
  const isType = (id, type) => byId.get(String(id))?.type === type;
  const fromOf = (type, toId) => String(connections.find((edge) => edge?.type === type && String(edge.toId) === toId)?.fromId || '');
  const parentOf = new Map();

  for (const edge of connections) {
    const fromId = String(edge?.fromId || '');
    const toId = String(edge?.toId || '');
    if (edge?.type === 'prompt-to-prompt' && isType(fromId, 'prompt') && isType(toId, 'prompt') && !parentOf.has(toId)) {
      parentOf.set(toId, { parentId: fromId, via: 'version', reviewName: '',
        changeLabel: byId.get(toId)?.nodeOrigin === 'agent' ? 'Agent edit' : 'Manual edit' });
    }
  }
  for (const edge of connections) {
    const toId = String(edge?.toId || '');
    const reviewId = String(edge?.fromId || '');
    if (edge?.type !== 'prompt-review-to-prompt' || !isType(reviewId, 'promptReview') || !isType(toId, 'prompt') || parentOf.has(toId)) continue;
    const scoreId = fromOf('score-to-prompt-review', reviewId);
    const runId = fromOf('run-to-score', scoreId);
    const promptId = fromOf('prompt-to-run', runId);
    if (!isType(scoreId, 'score') || !isType(runId, 'run') || !isType(promptId, 'prompt') || promptId === toId) continue;
    const review = byId.get(reviewId);
    const methodId = String(byId.get(toId)?.optimizationMethodId || '').trim() || reviewMethodId(review);
    parentOf.set(toId, { parentId: promptId, via: 'review', reviewId,
      reviewName: String(review.promptReviewName || review.name || 'Optimize'),
      method: methodName(methodId), changeLabel: methodId ? `Optimize · ${methodName(methodId)}` : 'Optimize' });
  }

  // Malformed imported cycles become a tree rooted at their first Prompt in canvas order.
  const order = new Map(prompts.map((id, index) => [id, index]));
  for (const id of prompts) {
    const path = [];
    const seen = new Map();
    let current = id;
    while (parentOf.has(current)) {
      if (seen.has(current)) {
        const root = path.slice(seen.get(current)).sort((a, b) => order.get(a) - order.get(b))[0];
        parentOf.delete(root);
        break;
      }
      seen.set(current, path.length);
      path.push(current);
      current = parentOf.get(current).parentId;
    }
  }
  const children = new Map();
  for (const id of prompts) {
    const parent = parentOf.get(id)?.parentId;
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(id);
  }
  const targetsOf = (type, fromId, toType) => [...new Set(connections
    .filter((edge) => edge?.type === type && String(edge.fromId) === fromId).map((edge) => String(edge.toId)))]
    .filter((id) => isType(id, toType));
  const groundTruthName = (score) => {
    const dataset = byId.get(String(score?.scoreGroundTruthId || '').trim());
    return dataset ? String(dataset.name || '').trim() || 'Dataset' : '';
  };
  /** Applied Optimizes group their versions by method, since a rerun with another method can apply again. */
  function roundsFrom(promptId) {
    const rounds = [];
    for (const runId of targetsOf('prompt-to-run', promptId, 'run')) {
      const input = runInputSource(canvasState, runId);
      for (const scoreId of targetsOf('run-to-score', runId, 'score')) {
        const score = byId.get(scoreId);
        const base = { promptId, runId, scoreId, reviewId: '', reviewName: '', method: '', childIds: [],
          runName: generateDisplayName(byId.get(runId)?.runName), scoreName: String(score.scoreName || 'Evaluate'),
          inputName: input ? stepSourceLabel(canvasState, input) : '', groundTruthName: groundTruthName(score) };
        const reviewIds = targetsOf('score-to-prompt-review', scoreId, 'promptReview');
        if (!reviewIds.length) rounds.push({ ...base, id: `score:${scoreId}`, status: 'notOptimized' });
        for (const reviewId of reviewIds) {
          const review = byId.get(reviewId);
          const reviewed = { ...base, reviewId, reviewName: String(review.promptReviewName || review.name || 'Optimize') };
          const applied = new Map();
          for (const childId of children.get(promptId) || []) {
            const link = parentOf.get(childId);
            if (link.reviewId !== reviewId) continue;
            if (!applied.has(link.method)) applied.set(link.method, []);
            applied.get(link.method).push(childId);
          }
          for (const [method, childIds] of applied) {
            rounds.push({ ...reviewed, id: `review:${reviewId}:${method}`, status: 'applied', method, childIds });
          }
          if (!applied.size) {
            rounds.push({ ...reviewed, id: `review:${reviewId}`, status: 'notApplied',
              method: methodName(reviewMethodId(review)) });
          }
        }
      }
    }
    return rounds;
  }
  return prompts.filter((id) => !parentOf.has(id)).map((rootId) => {
    const versions = [];
    const rounds = [];
    function visit(promptId, depth) {
      versions.push({ promptId, name: String(byId.get(promptId)?.name || 'Prompt'), depth,
        parentId: '', via: '', reviewName: '', method: '', changeLabel: '', ...parentOf.get(promptId) });
      rounds.push(...roundsFrom(promptId));
      for (const child of children.get(promptId) || []) visit(child, depth + 1);
    }
    visit(rootId, 0);
    return { rootId, versions, rounds };
  });
}
