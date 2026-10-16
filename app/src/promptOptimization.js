/** Prompt families follow version edges and Optimize → Evaluate → Generate → Prompt ancestry. */
const nodeId = (node) => String(node?.nodeId || node?.id || '');

const METHOD_NAMES = {
  issue_analysis_suggestions: 'Thompson Prompt Search',
  gepa: 'GEPA', miprov2: 'MIPROv2', bootstrap_fewshot: 'Bootstrap Few-Shot',
  textgrad: 'TextGrad', copro: 'COPRO', simba: 'SIMBA',
};

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
    const methodId = String(byId.get(toId)?.optimizationMethodId || review.reviewMethodId || '').trim();
    parentOf.set(toId, { parentId: promptId, via: 'review', reviewId,
      reviewName: String(review.promptReviewName || review.name || 'Optimize'),
      changeLabel: methodId ? `Optimize · ${METHOD_NAMES[methodId] || methodId}` : 'Optimize' });
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
  return prompts.filter((id) => !parentOf.has(id)).map((rootId) => {
    const versions = [];
    function visit(promptId, depth) {
      versions.push({ promptId, name: String(byId.get(promptId)?.name || 'Prompt'), depth,
        parentId: '', via: '', reviewName: '', changeLabel: '', ...parentOf.get(promptId) });
      for (const child of children.get(promptId) || []) visit(child, depth + 1);
    }
    visit(rootId, 0);
    return { rootId, versions };
  });
}
