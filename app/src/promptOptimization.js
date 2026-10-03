/**
 * Prompt version families for the Prompt Optimization panel (promptOptimizationPanel.js).
 *
 * A version's parent is the Prompt it was made from: "Add new version" (a prompt-to-prompt edge) or
 * applying a Review (the new Prompt's prompt-review-to-prompt edge, traced back through
 * Review → Score → Run → Prompt). Duplicates are standalone, so they start their own family.
 * Pure: takes canvas state ({ nodes, connections }), returns plain data.
 */

const nodeId = (node) => String(node?.nodeId || node?.id || '');

/**
 * @returns {Array<{ rootId: string, versions: Array<{ promptId: string, name: string, depth: number,
 *   parentId: string, via: ''|'version'|'review', reviewName: string,
 *   runs: Array<{ runId: string, name: string, scores: Array<{ scoreId: string, name: string, groundTruthId: string, groundTruthName: string }> }> }> }>}
 *   Versions are in family order (each parent before its children). Families with one version and
 *   no Run are left out: there is nothing to compare yet.
 */
export function buildPromptFamilies(canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const byId = new Map(nodes.map((node) => [nodeId(node), node]));
  const isType = (id, type) => byId.get(id)?.type === type;
  const fromOf = (type, toId) => connections.find((edge) => edge?.type === type && edge.toId === toId)?.fromId || '';
  const toAll = (type, fromId) => connections.filter((edge) => edge?.type === type && edge.fromId === fromId).map((edge) => edge.toId);

  const parentOf = new Map();
  for (const edge of connections) {
    if (edge?.type === 'prompt-to-prompt' && isType(edge.fromId, 'prompt') && isType(edge.toId, 'prompt') && !parentOf.has(edge.toId)) {
      parentOf.set(edge.toId, { parentId: edge.fromId, via: 'version', reviewName: '' });
    }
  }
  for (const edge of connections) {
    if (edge?.type !== 'prompt-review-to-prompt' || !isType(edge.toId, 'prompt') || parentOf.has(edge.toId)) continue;
    const scoreId = fromOf('score-to-prompt-review', edge.fromId);
    const runId = fromOf('run-to-score', scoreId);
    const promptId = fromOf('prompt-to-run', runId);
    if (!isType(promptId, 'prompt') || promptId === edge.toId) continue;
    const review = byId.get(edge.fromId);
    parentOf.set(edge.toId, { parentId: promptId, via: 'review', reviewName: String(review?.promptReviewName || review?.name || 'Review') });
  }

  const children = new Map();
  for (const [childId, { parentId }] of parentOf) {
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(childId);
  }
  // A parent chain that loops back has no root; break it at the first Prompt in canvas order.
  const prompts = nodes.filter((node) => node.type === 'prompt').map(nodeId);
  const hasRootAbove = (id) => {
    const seen = new Set();
    let current = id;
    while (parentOf.has(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = parentOf.get(current).parentId;
    }
    return true;
  };
  const roots = prompts.filter((id) => !parentOf.has(id) || !hasRootAbove(id));

  const runsOf = (promptId) => toAll('prompt-to-run', promptId).filter((id) => isType(id, 'run')).map((runId) => ({
    runId,
    name: String(byId.get(runId)?.runName || 'Run'),
    scores: toAll('run-to-score', runId).filter((id) => isType(id, 'score')).map((scoreId) => {
      const score = byId.get(scoreId);
      const groundTruthId = String(score?.scoreGroundTruthId || '');
      return {
        scoreId,
        name: String(score?.scoreName || 'Score'),
        groundTruthId,
        groundTruthName: String(byId.get(groundTruthId)?.name || ''),
      };
    }),
  }));

  const visited = new Set();
  const families = [];
  for (const rootId of roots) {
    if (visited.has(rootId)) continue;
    const versions = [];
    const visit = (promptId, depth) => {
      if (visited.has(promptId)) return;
      visited.add(promptId);
      const link = depth === 0 ? null : parentOf.get(promptId);
      versions.push({
        promptId,
        name: String(byId.get(promptId)?.name || 'Prompt'),
        depth,
        parentId: link?.parentId || '',
        via: link?.via || '',
        reviewName: link?.reviewName || '',
        runs: runsOf(promptId),
      });
      (children.get(promptId) || []).forEach((childId) => visit(childId, depth + 1));
    };
    visit(rootId, 0);
    if (versions.length > 1 || versions.some((version) => version.runs.length)) families.push({ rootId, versions });
  }
  return families;
}

/**
 * Change in F1 from the parent version, scored against the same ground truth (other ground truths
 * are not comparable). Uses the parent's first such Score that has metrics.
 * @param {ReturnType<typeof buildPromptFamilies>[number]} family
 * @param {Map<string, { f1: number } | null>} metricsByScoreId
 * @returns {Map<string, number>} scoreId → F1 change in percentage points
 */
export function f1ChangeFromParent(family, metricsByScoreId) {
  const byPrompt = new Map(family.versions.map((version) => [version.promptId, version]));
  const change = new Map();
  for (const version of family.versions) {
    const parent = byPrompt.get(version.parentId);
    if (!parent) continue;
    for (const run of version.runs) {
      for (const score of run.scores) {
        const own = metricsByScoreId.get(score.scoreId);
        if (!own || !Number.isFinite(own.f1)) continue;
        const parentScore = parent.runs.flatMap((item) => item.scores)
          .find((item) => item.groundTruthId === score.groundTruthId && Number.isFinite(metricsByScoreId.get(item.scoreId)?.f1));
        if (parentScore) change.set(score.scoreId, Number((own.f1 - metricsByScoreId.get(parentScore.scoreId).f1).toFixed(4)));
      }
    }
  }
  return change;
}
